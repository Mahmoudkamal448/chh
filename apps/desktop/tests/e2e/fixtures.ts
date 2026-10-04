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
  userData = mkdtempSync(join(tmpdir(), 'chh-e2e-')),
  extraEnv: Record<string, string> = {},
  opts: { waitFor?: string } = {},
): Promise<AppHandle> {
  const args = [resolve(__dirname, '../..')];
  // Chromium refuses to run as root without this; CI Linux runners also lack the SUID sandbox helper.
  if (process.getuid?.() === 0 || (process.env.CI && process.platform === 'linux')) args.push('--no-sandbox');
  // Software WebGL, so headless Linux uses the same WebGL terminal renderer as macOS and Windows.
  if (process.env.CHH_E2E_WEBGL) args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist');
  const app = await electron.launch({
    args,
    env: {
      ...process.env,
      CHH_TEST: '1',
      CHH_USER_DATA: userData,
      CHH_ALLOW_WEAK_KEYSTORE: '1',
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
  return page.evaluate((i) => (window as unknown as { __chhTest: { terminalText(i: number): string } }).__chhTest.terminalText(i), index);
}

export async function paneCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __chhTest: { paneCount(): number } }).__chhTest.paneCount());
}

/**
 * Waits until the last line on screen is an idle shell prompt (`$`, `#`, `%` or `>` at the end), so typing
 * doesn't race the shell: input sent before the prompt is drawn ends up in front of it (PowerShell on
 * Windows draws its prompt well after the first output).
 */
export async function waitForPrompt(page: Page, index = -1): Promise<void> {
  const lastLine = async () => (await terminalText(page, index)).trimEnd().split('\n').pop() ?? '';
  await expect.poll(lastLine, { timeout: 30_000 }).toMatch(/[$#%>❯]$/);
}

/** Waits for a command's output line (not just its echo) and the prompt after it. */
export async function waitForOutput(page: Page, line: string, index = -1): Promise<void> {
  const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await expect.poll(() => terminalText(page, index), { timeout: 15_000 }).toMatch(new RegExp(`^${escaped}\\s*$`, 'm'));
  await waitForPrompt(page, index);
}

/** Commands recorded in History (newest first). */
export async function recordedCommands(page: Page): Promise<string[]> {
  return page.evaluate(async () => (await window.chh.history.search({ limit: 50 })).map((e) => e.command));
}

export async function expectTerminalToContain(page: Page, text: string, timeout = 15_000, index = -1): Promise<void> {
  await expect.poll(() => terminalText(page, index), { timeout }).toContain(text);
}

export const accel = (key: string) => (process.platform === 'darwin' ? `Meta+${key}` : `Control+Shift+${key}`);

export { startSshServer, type TestSshServer } from '../support/ssh-server';
