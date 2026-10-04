import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';

export interface AppHandle {
  app: ElectronApplication;
  page: Page;
  userData: string;
  close(): Promise<void>;
}

/** Launches the built app with an isolated, throwaway user-data directory. */
export async function launchApp(
  userData = mkdtempSync(join(tmpdir(), 'cy-ssh-e2e-')),
  extraEnv: Record<string, string> = {},
  opts: { waitFor?: string } = {},
): Promise<AppHandle> {
  const args = [resolve(__dirname, '../..')];
  // Chromium refuses to run as root without this; CI Linux runners also lack the SUID sandbox helper.
  if (process.getuid?.() === 0 || (process.env.CI && process.platform === 'linux')) args.push('--no-sandbox');
  const app = await electron.launch({
    args,
    env: {
      ...process.env,
      CY_SSH_TEST: '1',
      CY_SSH_USER_DATA: userData,
      CY_SSH_ALLOW_WEAK_KEYSTORE: '1',
      SSH_AUTH_SOCK: '', // don't let the developer's agent influence auth tests
      ...extraEnv,
    } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.waitForSelector(`[data-testid="${opts.waitFor ?? 'tab-hosts'}"]`);
  return {
    app,
    page,
    userData,
    close: async () => {
      await app.close();
    },
  };
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Full text of the most recently opened terminal (test hook installed in test mode). */
export async function terminalText(page: Page, index = -1): Promise<string> {
  return page.evaluate((i) => (window as unknown as { __cyTest: { terminalText(i: number): string } }).__cyTest.terminalText(i), index);
}

export async function paneCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __cyTest: { paneCount(): number } }).__cyTest.paneCount());
}

export async function expectTerminalToContain(page: Page, text: string, timeout = 15_000, index = -1): Promise<void> {
  await expect.poll(() => terminalText(page, index), { timeout }).toContain(text);
}

export const accel = (key: string) => (process.platform === 'darwin' ? `Meta+${key}` : `Control+Shift+${key}`);

export { startSshServer, type TestSshServer } from '../support/ssh-server';
