import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, Menu, nativeTheme } from 'electron';
import { BRAND } from '@cy-ssh/shared';
import { openDatabase, type Db } from './db/database';
import { GroupsRepo } from './db/groups-repo';
import { HostsRepo } from './db/hosts-repo';
import { ForwardsRepo } from './db/forwards-repo';
import { HistoryRepo } from './db/history-repo';
import { IdentitiesRepo } from './db/identities-repo';
import { KeysRepo } from './db/keys-repo';
import { ItemStore } from './db/item-store';
import { KnownHostsRepo } from './db/known-hosts-repo';
import { SettingsRepo } from './db/settings-repo';
import { SnippetsRepo } from './db/snippets-repo';
import { ALLOW_WEAK_KEYSTORE, USER_DATA_OVERRIDE } from './env';
import { emit, registerHandlers } from './ipc/handle';
import { createHandlers } from './ipc/handlers';
import { errInfo, initLogger, log } from './log';
import { keystoreKind, loadOrCreateLocalKey, memzero } from './secrets/local-key';
import { SessionManager, sessionHostScript } from './sessions';
import { detectMoshClient, detectShells, type MoshClient } from './shells';
import { SshConfigIO } from './ssh-config-io';
import { LocalVault } from './vault/local-vault';
import { createMainWindow, isTrustedSender } from './window';

app.setName(BRAND.productName);
if (USER_DATA_OVERRIDE) app.setPath('userData', USER_DATA_OVERRIDE);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let db: Db | null = null;
  let vault: LocalVault | null = null;
  let sessions: SessionManager | null = null;

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  const userData = app.getPath('userData');

  /** On Linux without a keyring, ask once before storing the DB key with weak protection. */
  async function confirmWeakKeystore(settingsFlag: string): Promise<boolean> {
    if (ALLOW_WEAK_KEYSTORE) return true;
    const { existsSync, writeFileSync } = await import('node:fs');
    if (existsSync(settingsFlag)) return true;
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: BRAND.productName,
      message: 'No system keyring found',
      detail:
        'cy-ssh could not find a Secret Service keyring (e.g. GNOME Keyring or KWallet). Your data will still be ' +
        'encrypted, but the encryption key will only be obfuscated on disk. Install and unlock a keyring for full ' +
        'protection, or continue now. A master-password lock will be available in a later release.',
      buttons: ['Continue', 'Quit'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return false;
    writeFileSync(settingsFlag, 'accepted\n', { mode: 0o600 });
    return true;
  }

  async function boot(): Promise<void> {
    initLogger(join(userData, 'logs'));
    log.info({ version: app.getVersion(), platform: process.platform }, 'starting');

    const keystore = keystoreKind();
    if (keystore === 'weak' && !(await confirmWeakKeystore(join(userData, 'weak-keystore-accepted')))) {
      app.quit();
      return;
    }

    const { key } = loadOrCreateLocalKey(userData);
    try {
      db = openDatabase(join(userData, `${BRAND.slug}.db`), key);
      vault = LocalVault.openOrCreate(db, key);
    } finally {
      memzero(key);
    }

    const settings = new SettingsRepo(db);
    let deviceId = settings.getRaw('device_id');
    if (!deviceId) {
      deviceId = randomUUID();
      settings.setRaw('device_id', deviceId);
    }
    nativeTheme.themeSource = settings.getApp().uiTheme;

    const store = new ItemStore(db, deviceId, vault.id);
    const groups = new GroupsRepo(store);
    const hosts = new HostsRepo(store, vault, groups);
    const knownHosts = new KnownHostsRepo(store);
    const keys = new KeysRepo(store, vault);
    const identities = new IdentitiesRepo(store, vault);
    const forwards = new ForwardsRepo(store);
    const snippets = new SnippetsRepo(store);
    const history = new HistoryRepo(db);
    const sshConfig = new SshConfigIO({ hosts, groups, keys, identities, forwards });
    // mosh-client detection can be slow on Windows (WSL), so cache it briefly.
    let mosh: { at: number; client: MoshClient | null } | null = null;
    sessions = new SessionManager({
      keys,
      identities,
      forwards,
      moshClient: () => {
        if (!mosh || Date.now() - mosh.at > 60_000) mosh = { at: Date.now(), client: detectMoshClient() };
        return mosh.client;
      },
      broadcast: (event, payload) => {
        for (const w of BrowserWindow.getAllWindows()) emit(w.webContents, event, payload);
      },
      hostScript: sessionHostScript(__dirname),
      hosts,
      groups,
      knownHosts,
      shells: detectShells,
      defaultShellId: () => settings.getApp().defaultShell,
    });

    registerHandlers(
      createHandlers({ hosts, groups, settings, sessions, keys, identities, knownHosts, forwards, snippets, history, sshConfig, keystore }),
      isTrustedSender,
    );
    buildMenu();
    mainWindow = createMainWindow(join(__dirname, '../preload/index.js'), join(__dirname, '../renderer'));
    mainWindow.on('closed', () => (mainWindow = null));

    // Auto-start forwarding rules once the UI is up (it may need to show prompts).
    const wc = mainWindow.webContents;
    wc.once('did-finish-load', () => {
      for (const f of forwards.list().filter((x) => x.autoStart)) {
        sessions?.startForward(wc, f.id).catch((err) => log.warn({ forwardId: f.id, err: errInfo(err) }, 'auto-start failed'));
      }
    });
  }

  function buildMenu(): void {
    const isMac = process.platform === 'darwin';
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(isMac ? [{ role: 'appMenu' as const }] : []),
        { role: 'editMenu' },
        {
          label: 'View',
          submenu: [
            { role: 'reload', visible: !app.isPackaged },
            { role: 'toggleDevTools', visible: !app.isPackaged },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' },
          ],
        },
        { role: 'windowMenu' },
      ]),
    );
  }

  app.whenReady().then(boot).catch((err) => {
    log.error({ err: errInfo(err) }, 'startup failed');
    process.stderr.write(`cy-ssh: startup failed: ${(err as Error).message}\n`);
    dialog.showErrorBox(BRAND.productName, `Startup failed: ${(err as Error).message}`);
    app.exit(1);
  });

  app.on('activate', () => {
    if (!mainWindow && db) {
      mainWindow = createMainWindow(join(__dirname, '../preload/index.js'), join(__dirname, '../renderer'));
      mainWindow.on('closed', () => (mainWindow = null));
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    sessions?.shutdown();
    vault?.dispose();
    db?.close();
    db = null;
  });
}
