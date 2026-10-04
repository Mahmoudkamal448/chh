import { execFile } from 'node:child_process';
import { powerMonitor, systemPreferences } from 'electron';
import { DEFAULT_LOCK_SETTINGS, LockSettingsSchema, type LockSettings, type LockState } from '@cy-ssh/shared';
import { hashPasscode, verifyPasscode } from '@cy-ssh/vault-crypto';
import type { SettingsRepo } from './db/settings-repo';
import { errInfo, log } from './log';
import { readKeyFile, unlockPasswordKey, writeOsKey, writePasswordKey } from './secrets/local-key';

const SETTINGS_KEY = 'lock';
const PASSCODE_KEY = 'lock_passcode';
const FREE_ATTEMPTS = 5;
const IDLE_CHECK_MS = 15_000;

type Biometric = LockState['biometricAvailable'];

/** Windows Hello via WinRT's UserConsentVerifier, driven from PowerShell (no native addon needed). */
function runWindowsHello(action: 'check' | 'verify', reason = ''): Promise<string> {
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(); $t.Result }
${
  action === 'check'
    ? `Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])`
    : `Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('${reason.replace(/'/g, "''")}')) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])`
}`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 120_000, windowsHide: true }, (err, stdout) =>
      resolve(err ? '' : stdout.trim()),
    );
  });
}

/**
 * App lock. Two independent protections:
 * - UI lock: a passcode (optionally Touch ID / Windows Hello) hides the app after idle/sleep.
 * - Master password: the local database key is stored encrypted with it, so data can't be read at
 *   rest without it. It's asked for at every start, and it doubles as the unlock secret.
 */
export class LockManager {
  private locked: LockState['locked'] = 'no';
  private settings: SettingsRepo | null = null;
  private dbKey: Buffer | null = null;
  private failures = 0;
  private blockedUntil = 0;
  private biometric: Biometric = 'none';
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: {
      userData: string;
      emit(state: LockState): void;
      /** Opens the encrypted database once the master password is verified. */
      openWithKey(key: Buffer): Promise<void>;
    },
  ) {
    void this.detectBiometric();
  }

  /** Called when the database is open (startup without master password, or after unlocking). */
  attach(settings: SettingsRepo, dbKey: Buffer): void {
    this.settings = settings;
    this.dbKey = Buffer.from(dbKey);
    this.startWatching();
  }

  /** Database key is password-protected: stay locked until unlock(). */
  startLockedForPassword(): void {
    this.locked = 'startup';
  }

  isLocked(): boolean {
    return this.locked !== 'no';
  }

  state(): LockState {
    return {
      locked: this.locked,
      settings: this.lockSettings(),
      masterPassword: this.hasMasterPassword(),
      biometricAvailable: this.biometric,
      retryAfter: Math.max(0, Math.ceil((this.blockedUntil - Date.now()) / 1000)),
    };
  }

  /** Locks if any protection is configured. */
  lockNow(): void {
    if (this.locked !== 'no' || !this.isConfigured()) return;
    this.locked = 'idle';
    log.info({}, 'app locked');
    this.emitState();
  }

  async unlock(input: { secret?: string; biometric?: boolean }): Promise<{ ok: boolean }> {
    if (this.locked === 'no') return { ok: true };
    if (Date.now() < this.blockedUntil) return { ok: false };

    let ok = false;
    if (input.biometric && this.locked === 'idle' && this.lockSettings().biometric) ok = await this.promptBiometric();
    else if (input.secret !== undefined) ok = await this.verifySecret(input.secret);

    if (!ok) {
      this.failures++;
      if (this.failures >= FREE_ATTEMPTS) this.blockedUntil = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (this.failures - FREE_ATTEMPTS));
      this.emitState();
      return { ok: false };
    }
    this.failures = 0;
    this.blockedUntil = 0;
    this.locked = 'no';
    log.info({}, 'app unlocked');
    this.emitState();
    return { ok: true };
  }

  async configure(input: { passcode?: string; settings: Partial<LockSettings> }): Promise<LockState> {
    const s = this.requireSettings();
    if (input.passcode) s.setRaw(PASSCODE_KEY, await hashPasscode(input.passcode));
    const next = LockSettingsSchema.parse({ ...this.lockSettings(), ...input.settings });
    if (next.enabled && !s.getRaw(PASSCODE_KEY) && !this.hasMasterPassword()) throw new Error('passcode required');
    s.setRaw(SETTINGS_KEY, JSON.stringify(next));
    this.emitState();
    return this.state();
  }

  async disable(secret: string): Promise<LockState> {
    if (!(await this.verifySecret(secret))) throw new Error('wrong secret');
    const s = this.requireSettings();
    s.setRaw(SETTINGS_KEY, JSON.stringify({ ...this.lockSettings(), enabled: false, biometric: false }));
    s.setRaw(PASSCODE_KEY, '');
    this.emitState();
    return this.state();
  }

  async setMasterPassword(password: string): Promise<LockState> {
    if (!this.dbKey) throw new Error('database not open');
    await writePasswordKey(this.deps.userData, this.dbKey, password);
    log.info({}, 'master password enabled');
    this.emitState();
    return this.state();
  }

  async removeMasterPassword(password: string): Promise<LockState> {
    const file = readKeyFile(this.deps.userData);
    if (file.kind !== 'password') return this.state();
    const key = await unlockPasswordKey(file, password);
    if (!key) throw new Error('wrong password');
    writeOsKey(this.deps.userData, key);
    log.info({}, 'master password removed');
    this.emitState();
    return this.state();
  }

  // ---------------------------------------------------------------------------------------------

  private async verifySecret(secret: string): Promise<boolean> {
    const file = readKeyFile(this.deps.userData);
    if (file.kind === 'password') {
      const key = await unlockPasswordKey(file, secret);
      if (!key) return false;
      if (this.locked === 'startup') {
        await this.deps.openWithKey(key);
      }
      return true;
    }
    const hash = this.settings?.getRaw(PASSCODE_KEY);
    return !!hash && (await verifyPasscode(secret, hash));
  }

  private hasMasterPassword(): boolean {
    try {
      return readKeyFile(this.deps.userData).kind === 'password';
    } catch {
      return false;
    }
  }

  private isConfigured(): boolean {
    return this.hasMasterPassword() || (this.lockSettings().enabled && !!this.settings?.getRaw(PASSCODE_KEY));
  }

  private lockSettings(): LockSettings {
    const raw = this.settings?.getRaw(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_LOCK_SETTINGS };
    const parsed = LockSettingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { ...DEFAULT_LOCK_SETTINGS };
  }

  private requireSettings(): SettingsRepo {
    if (!this.settings) throw new Error('database not open');
    return this.settings;
  }

  private startWatching(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      const mins = this.lockSettings().autoLockMinutes;
      if (mins > 0 && this.locked === 'no' && powerMonitor.getSystemIdleTime() >= mins * 60) this.lockNow();
    }, IDLE_CHECK_MS);
    const onSleep = () => this.lockSettings().lockOnSleep && this.lockNow();
    powerMonitor.on('lock-screen', onSleep);
    powerMonitor.on('suspend', onSleep);
  }

  private async detectBiometric(): Promise<void> {
    try {
      if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) this.biometric = 'touchid';
      else if (process.platform === 'win32' && (await runWindowsHello('check')) === 'Available') this.biometric = 'windows-hello';
    } catch (e) {
      log.warn({ err: errInfo(e) }, 'biometric detection failed');
    }
  }

  private async promptBiometric(): Promise<boolean> {
    try {
      if (this.biometric === 'touchid') {
        await systemPreferences.promptTouchID('unlock cy-ssh');
        return true;
      }
      if (this.biometric === 'windows-hello') return (await runWindowsHello('verify', 'Unlock cy-ssh')) === 'Verified';
    } catch {
      // cancelled or failed
    }
    return false;
  }

  private emitState(): void {
    this.deps.emit(this.state());
  }
}
