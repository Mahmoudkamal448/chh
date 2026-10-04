import { join } from 'node:path';
import { app, dialog, Menu, type BrowserWindow } from 'electron';
import { BRAND } from '@cy-ssh/shared';
import { broadcast, openContext, type AppContext } from './context';
import { ALLOW_WEAK_KEYSTORE, USER_DATA_OVERRIDE } from './env';
import { registerHandlers } from './ipc/handle';
import { createHandlers } from './ipc/handlers';
import { LockManager } from './lock';
import { errInfo, initLogger, log } from './log';
import { createLocalKey, keystoreKind, memzero, readKeyFile } from './secrets/local-key';
import { createMainWindow, isTrustedSender } from './window';

app.setName(BRAND.productName);
if (USER_DATA_OVERRIDE) app.setPath('userData', USER_DATA_OVERRIDE);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let ctx: AppContext | null = null;
  let lock: LockManager | null = null;

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

    const keyFile = readKeyFile(userData);
    const keystore = keystoreKind();
    if (keyFile.kind !== 'password' && keystore === 'weak' && !(await confirmWeakKeystore(join(userData, 'weak-keystore-accepted')))) {
      app.quit();
      return;
    }

    lock = new LockManager({ userData, emit: (s) => broadcast('lock.changed', s), openWithKey: open });
    const l = lock;
    registerHandlers(
      createHandlers(() => ctx, { keystore, lock: l }),
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
    if (!mainWindow && lock) {
      mainWindow = createMainWindow(join(__dirname, '../preload/index.js'), join(__dirname, '../renderer'));
      mainWindow.on('closed', () => (mainWindow = null));
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    ctx?.close();
    ctx = null;
  });
}
