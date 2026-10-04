import { join } from 'node:path';
import { BrowserWindow, shell, type IpcMainInvokeEvent } from 'electron';
import { BRAND } from '@cy-ssh/shared';

const DEV_URL = process.env.ELECTRON_RENDERER_URL;

export function createMainWindow(preloadPath: string, rendererDir: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: BRAND.productName,
    show: false,
    backgroundColor: '#0f1115',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Never open new windows or navigate away from the app; external links go to the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });
  // Deny every permission except clipboard access (terminal copy/paste).
  const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write']);
  win.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => cb(allowed.has(perm)));
  win.webContents.session.setPermissionCheckHandler((_wc, perm) => allowed.has(perm));

  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(join(rendererDir, 'index.html'));
  return win;
}

/** Only our own top-level page may call IPC. */
export function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? '';
  if (e.senderFrame?.parent) return false;
  if (DEV_URL) return url.startsWith(DEV_URL);
  return url.startsWith('file://');
}
