import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, dialog, Menu, type BrowserWindow } from 'electron';
import { BRAND } from '@chh/shared';
import { broadcast, openContext, type AppContext } from './context';
import { ALLOW_WEAK_KEYSTORE, USER_DATA_OVERRIDE } from './env';
import { registerHandlers } from './ipc/handle';
import { createHandlers } from './ipc/handlers';
import { migrateLegacyUserData } from './legacy';
import { LockManager } from './lock';
import { errInfo, initLogger, log } from './log';
import { createLocalKey, keystoreKind, memzero, readKeyFile } from './secrets/local-key';
import { UpdateService, detectUpdateSupport, type UpdaterLike } from './updater';
import { createMainWindow, isTrustedSender } from './window';

app.setName(BRAND.productName);
if (USER_DATA_OVERRIDE) app.setPath('userData', USER_DATA_OVERRIDE);

/**
 * Data from a pre-rename (cy-ssh) install moves before Chromium or the single-instance lock touch
 * the user-data folder: on Windows the safeStorage key lives in Chromium's "Local State" file there.
 */
let migrated: boolean | Error = false;
if (!USER_DATA_OVERRIDE) {
  try {
    migrated = migrateLegacyUserData(app.getPath('userData'));
  } catch (err) {
    migrated = err as Error;
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let ctx: AppContext | null = null;
  let lock: LockManager | null = null;
  let updates: UpdateService | null = null;

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
        'chh could not find a Secret Service keyring (e.g. GNOME Keyring or KWallet). Your data will still be ' +
        'encrypted, but the encryption key will only be obfuscated on disk. Install and unlock a keyring, or set a ' +
        'master password in Settings → Security for full protection.',
      buttons: ['Continue', 'Quit'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) return false;
    writeFileSync(settingsFlag, 'accepted\n', { mode: 0o600 });
    return true;
  }

  /** Opens the database and starts everything that depends on it. */
  async function open(key: Buffer): Promise<void> {
    try {
      ctx = openContext(userData, key, __dirname);
      lock!.attach(ctx.settings, key);
    } finally {
      memzero(key);
    }
    ctx.sync.start();
    updates?.start();
    const c = ctx;
    const startForwards = () => {
      for (const f of c.forwards.list().filter((x) => x.autoStart)) {
        if (!mainWindow) return;
        c.sessions.startForward(mainWindow.webContents, f.id).catch((err) => log.warn({ forwardId: f.id, err: errInfo(err) }, 'auto-start failed'));
      }
    };
    // Auto-start forwarding rules once the UI is up (they may need to show prompts).
    if (mainWindow && !mainWindow.webContents.isLoading()) startForwards();
    else mainWindow?.webContents.once('did-finish-load', startForwards);
  }

  async function boot(): Promise<void> {
    initLogger(join(userData, 'logs'));
    log.info({ version: app.getVersion(), platform: process.platform }, 'starting');
    if (migrated instanceof Error) log.error({ err: errInfo(migrated) }, 'moving data from the pre-rename user-data folder failed');
    else if (migrated) log.info({ from: 'cy-ssh' }, 'moved data from the pre-rename user-data folder');

    let keyFile: ReturnType<typeof readKeyFile>;
    try {
      keyFile = readKeyFile(userData);
    } catch (err) {
      // The OS keychain entry belongs to the app name, so data from a pre-rename build may not be
      // readable on macOS/Linux. A master-password key file isn't affected.
      throw new Error(
        migrated
          ? `the local database key from the previous version (cy-ssh) can't be read: ${(err as Error).message}. ` +
              'See docs/PHASE-6.md ("Upgrading from cy-ssh").'
          : (err as Error).message,
      );
    }
    const keystore = keystoreKind();
    if (keyFile.kind !== 'password' && keystore === 'weak' && !(await confirmWeakKeystore(join(userData, 'weak-keystore-accepted')))) {
      app.quit();
      return;
    }

    lock = new LockManager({ userData, emit: (s) => broadcast('lock.changed', s), openWithKey: open });
    const l = lock;
    updates = createUpdateService();
    registerHandlers(
      createHandlers(() => ctx, { keystore, lock: l, updates }),
      isTrustedSender,
      // While locked, only the lock screen's calls get through.
      (ns, m) => !l.isLocked() || ns === 'lock' || (ns === 'app' && m === 'info'),
    );
    buildMenu();

    if (keyFile.kind === 'password') {
      // Master password: the database stays encrypted until the user unlocks.
      l.startLockedForPassword();
      mainWindow = createMainWindow(join(__dirname, '../preload/index.js'), join(__dirname, '../renderer'));
    } else {
      mainWindow = createMainWindow(join(__dirname, '../preload/index.js'), join(__dirname, '../renderer'));
      await open(keyFile.kind === 'os' ? keyFile.key : createLocalKey(userData));
      // A configured UI lock also applies at startup.
      l.lockNow();
    }
    mainWindow.on('closed', () => (mainWindow = null));
  }

  function createUpdateService(): UpdateService {
    const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : null);
    let signed = false;
    try {
      // Written into the packaged package.json by electron-builder.config.cjs.
      signed = JSON.parse(read(join(app.getAppPath(), 'package.json')) ?? '{}').chhSigned === true;
    } catch {
      // unreadable: treat as unsigned
    }
    const support = detectUpdateSupport({
      isPackaged: app.isPackaged,
      platform: process.platform,
      env: process.env,
      linuxPackageType: app.isPackaged ? read(join(process.resourcesPath, 'package-type')) : null,
      signed,
    });
    log.info({ support }, 'auto-update');
    return new UpdateService({
      currentVersion: app.getVersion(),
      support,
      releasesUrl: `${BRAND.homepage}/releases`,
      settings: () => ctx?.settings.getApp().updates ?? null,
      loadUpdater: async () => {
        const { autoUpdater } = await import('electron-updater');
        autoUpdater.logger = null;
        return autoUpdater as unknown as UpdaterLike;
      },
      onStatus: (s) => broadcast('update.status', s),
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
    process.stderr.write(`chh: startup failed: ${(err as Error).message}\n`);
    dialog.showErrorBox(BRAND.productName, `Startup failed: ${(err as Error).message}`);
    app.exit(1);
  });

  app.on('activate', () => {
    if (!mainWindow && lock) {
      mainWindow = createMainWindow(join(__dirname, '../preload/index.js'), join(__dirname, '../renderer'));
      mainWindow.on('closed', () => (mainWindow = null));
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    updates?.stop();
    ctx?.close();
    ctx = null;
  });
}
