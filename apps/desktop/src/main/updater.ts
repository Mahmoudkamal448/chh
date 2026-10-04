import type { AppSettings, UpdateStatus } from '@chh/shared';
import { errInfo, log } from './log';

/** The part of electron-updater's AppUpdater we use (lets tests drive the service). */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export type UpdateSupport = { supported: true } | { supported: false; reason: NonNullable<UpdateStatus['reason']> };

const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 6 * 3600_000;

/**
 * Background updates for signed release builds (electron-updater: NSIS on Windows, Squirrel on
 * macOS, AppImage/deb/rpm on Linux). Downloads are verified by electron-updater against the
 * SHA-512 in the release metadata, and on Windows/macOS against the code signature.
 */
export class UpdateService {
  private status: UpdateStatus;
  private updater: UpdaterLike | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deps: {
      currentVersion: string;
      support: UpdateSupport;
      /** Release page for manual downloads. */
      releasesUrl: string;
      /** Null while the database is still locked (defaults apply). */
      settings: () => AppSettings['updates'] | null;
      loadUpdater: () => Promise<UpdaterLike>;
      onStatus: (s: UpdateStatus) => void;
    },
  ) {
    const s = deps.support;
    this.status = {
      supported: s.supported,
      ...(s.supported ? {} : { reason: s.reason }),
      state: 'idle',
      currentVersion: deps.currentVersion,
      version: null,
      releaseNotes: null,
      progress: null,
      lastCheckedAt: null,
      downloadUrl: deps.releasesUrl,
    };
  }

  get(): UpdateStatus {
    return { ...this.status };
  }

  /** Starts periodic background checks if enabled. Safe to call again after settings change. */
  start(): void {
    this.stopTimers();
    if (!this.status.supported || !this.prefs().auto) return;
    this.first = setTimeout(() => void this.check().catch(() => undefined), FIRST_CHECK_MS);
    this.timer = setInterval(() => void this.check().catch(() => undefined), CHECK_EVERY_MS);
  }

  stop(): void {
    this.stopTimers();
  }

  async check(): Promise<UpdateStatus> {
    if (!this.status.supported) return this.get();
    if (this.status.state === 'checking' || this.status.state === 'downloading' || this.status.state === 'downloaded') return this.get();
    const u = await this.ensureUpdater();
    this.applyPrefs(u);
    this.set({ state: 'checking', error: undefined });
    try {
      await u.checkForUpdates();
    } catch (e) {
      this.fail(e);
    }
    return this.get();
  }

  async download(): Promise<void> {
    if (!this.status.supported || this.status.state !== 'available') return;
    const u = await this.ensureUpdater();
    this.set({ state: 'downloading', progress: 0 });
    try {
      await u.downloadUpdate();
    } catch (e) {
      this.fail(e);
    }
  }

  install(): void {
    if (this.status.state !== 'downloaded' || !this.updater) return;
    log.info({ version: this.status.version }, 'restarting to install update');
    this.updater.quitAndInstall(false, true);
  }

  private prefs(): AppSettings['updates'] {
    return this.deps.settings() ?? { auto: true, channel: 'latest' };
  }

  private applyPrefs(u: UpdaterLike): void {
    const p = this.prefs();
    u.autoDownload = p.auto;
    u.autoInstallOnAppQuit = true;
    u.allowPrerelease = p.channel === 'beta';
    u.allowDowngrade = false;
  }

  private async ensureUpdater(): Promise<UpdaterLike> {
    if (this.updater) return this.updater;
    const u = await this.deps.loadUpdater();
    u.on('checking-for-update', () => this.set({ state: 'checking' }));
    u.on('update-available', (info) => {
      const i = info as { version?: string; releaseNotes?: unknown };
      this.set({
        state: this.prefs().auto ? 'downloading' : 'available',
        version: i.version ?? null,
        releaseNotes: notesText(i.releaseNotes),
        progress: this.prefs().auto ? 0 : null,
        lastCheckedAt: Date.now(),
      });
    });
    u.on('update-not-available', () => this.set({ state: 'not-available', version: null, releaseNotes: null, progress: null, lastCheckedAt: Date.now() }));
    u.on('download-progress', (p) => this.set({ state: 'downloading', progress: Math.round((p as { percent?: number }).percent ?? 0) }));
    u.on('update-downloaded', (info) => {
      log.info({ version: (info as { version?: string }).version }, 'update downloaded');
      this.set({ state: 'downloaded', progress: 100, version: (info as { version?: string }).version ?? this.status.version });
    });
    u.on('error', (e) => this.fail(e));
    this.updater = u;
    return u;
  }

  private fail(e: unknown): void {
    log.warn({ err: errInfo(e) }, 'update check failed');
    const offline = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|net::ERR_/i.test(String((e as Error)?.message ?? e));
    this.set({ state: 'error', progress: null, error: offline ? 'updates.error.network' : 'updates.error.generic', lastCheckedAt: Date.now() });
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.deps.onStatus(this.get());
  }

  private stopTimers(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    this.timer = this.first = null;
  }
}

/** Release notes arrive as HTML/markdown text or a list per version; keep plain text, bounded. */
function notesText(n: unknown): string | null {
  const raw = Array.isArray(n) ? n.map((x) => (x as { note?: string }).note ?? '').join('\n\n') : typeof n === 'string' ? n : '';
  const text = raw.replace(/<[^>]*>/g, '').trim();
  return text ? text.slice(0, 5000) : null;
}

/** Whether this build can update itself, from how it was packaged. */
export function detectUpdateSupport(opts: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Linux: electron-builder writes resources/package-type for deb/rpm builds. */
  linuxPackageType: string | null;
  /** Set at build time when the app was code-signed. */
  signed: boolean;
}): UpdateSupport {
  if (opts.env.CHH_DISABLE_UPDATES === '1') return { supported: false, reason: 'disabled' };
  if (!opts.isPackaged) return { supported: false, reason: 'dev' };
  if (opts.platform === 'darwin' && !opts.signed) return { supported: false, reason: 'unsigned' };
  if (opts.platform === 'linux' && !opts.env.APPIMAGE && opts.linuxPackageType !== 'deb' && opts.linuxPackageType !== 'rpm') {
    return { supported: false, reason: 'package' };
  }
  return { supported: true };
}
