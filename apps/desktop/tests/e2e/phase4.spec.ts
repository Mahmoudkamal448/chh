import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { buildApp } from '../../../server/src/app';
import { base32Decode, hotp, totpStep } from '../../../server/src/crypto';
import { MemoryStore } from '../../../server/src/store/memory';
import { cleanup, launchApp, type AppHandle } from './fixtures';

const settingsKey = process.platform === 'darwin' ? 'Meta+,' : 'Control+,';
const lockKey = process.platform === 'darwin' ? 'Meta+Shift+L' : 'Control+Shift+L';

async function openSettings(page: Page, section: 'sync' | 'security') {
  await page.keyboard.press(settingsKey);
  await page.getByTestId(`settings-${section}`).click();
}

async function closeDialog(page: Page) {
  await page.keyboard.press('Escape');
}

test('two devices sync end-to-end encrypted; 2FA protects new sign-ins', async () => {
  test.setTimeout(120_000);
  const store = new MemoryStore();
  const server = await buildApp({
    config: { port: 0, host: '127.0.0.1', store: 'memory', serverSecret: randomBytes(32), allowRegistration: true, trustProxy: false, logLevel: 'silent', accessTtl: 3600, refreshTtl: 86400, authRateLimit: 1000 },
    store,
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
  const email = `e2e-${Date.now()}@example.com`;
  const password = 'a long enough password';
  const handles: AppHandle[] = [];
  try {
    // Device A: create an account.
    const a = await launchApp();
    handles.push(a);
    await a.page.evaluate(() => window.cy.hosts.create({ label: 'synced-web', address: 'web.example.com', password: 'pw-123' }));
    await openSettings(a.page, 'sync');
    await a.page.getByTestId('sync-mode-register').click();
    await a.page.getByTestId('sync-server').fill(url);
    await a.page.getByTestId('sync-email').fill(email);
    await a.page.getByTestId('sync-password').fill(password);
    await a.page.getByTestId('sync-password-confirm').fill(password);
    await a.page.getByTestId('sync-submit').click();
    const rk = a.page.getByTestId('recovery-key-dialog');
    await expect(rk.getByTestId('recovery-key')).toHaveText(/^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/, { timeout: 20_000 });
    await expect(rk.getByTestId('recovery-done')).toBeDisabled();
    await rk.getByLabel("I've saved it").check();
    await rk.getByTestId('recovery-done').click();
    await expect(a.page.getByTestId('sync-status')).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });
    expect(JSON.stringify([...store.items.values()])).not.toContain('synced-web');

    // Device B: sign in and receive the host.
    const b = await launchApp(mkdtempSync(join(tmpdir(), 'cy-ssh-e2e-b-')));
    handles.push(b);
    await openSettings(b.page, 'sync');
    await b.page.getByTestId('sync-server').fill(url);
    await b.page.getByTestId('sync-email').fill(email);
    // A wrong password shows the specific error, not a generic one.
    await b.page.getByTestId('sync-password').fill('not the password');
    await b.page.getByTestId('sync-submit').click();
    await expect(b.page.getByRole('alert')).toHaveText('Wrong email or password.', { timeout: 20_000 });
    await b.page.getByTestId('sync-password').fill(password);
    await b.page.getByTestId('sync-submit').click();
    await expect(b.page.getByTestId('sync-status')).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });
    await closeDialog(b.page);
    await expect(b.page.getByTestId('host-row').filter({ hasText: 'synced-web' })).toBeVisible({ timeout: 15_000 });

    // Live: a change on A appears on B without doing anything on B.
    await a.page.evaluate(() => window.cy.hosts.create({ label: 'live-from-a', address: 'live.example' }));
    await expect(b.page.getByTestId('host-row').filter({ hasText: 'live-from-a' })).toBeVisible({ timeout: 15_000 });
    await expect(b.page.getByTestId('tabbar-sync')).toHaveAttribute('data-state', 'idle');

    // 2FA on A, then B must provide a code to sign in again.
    await a.page.getByTestId('totp-setup').click();
    const secret = (await a.page.getByTestId('totp-secret').textContent())!.trim();
    await a.page.getByTestId('totp-code').fill(hotp(base32Decode(secret), totpStep()));
    await a.page.getByTestId('totp-enable').click();
    await expect(a.page.getByTestId('totp-recovery-codes')).toBeVisible();

    await openSettings(b.page, 'sync');
    await b.page.getByTestId('sync-logout').click();
    await b.page.getByTestId('sync-server').fill(url);
    await b.page.getByTestId('sync-email').fill(email);
    await b.page.getByTestId('sync-password').fill(password);
    await b.page.getByTestId('sync-submit').click();
    await b.page.getByTestId('sync-totp').fill(hotp(base32Decode(secret), totpStep() + 1));
    await b.page.getByTestId('sync-submit').click();
    await expect(b.page.getByTestId('sync-status')).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });
  } finally {
    for (const h of handles) {
      await h.close();
      cleanup(h.userData);
    }
    await server.close();
  }
});

test('lock screen with passcode', async () => {
  const h = await launchApp();
  try {
    const { page } = h;
    await openSettings(page, 'security');
    await page.getByTestId('lock-passcode').fill('2468');
    await page.getByTestId('lock-passcode-confirm').fill('2468');
    await page.getByTestId('lock-enable').click();
    await expect(page.getByTestId('lock-now')).toBeVisible();
    await closeDialog(page);

    await page.keyboard.press(lockKey);
    const lock = page.getByTestId('lock-screen');
    await expect(lock).toBeVisible();
    // Data APIs are refused while locked, not just hidden.
    const refused = await page.evaluate(() => window.cy.hosts.list({}).then(() => 'ok', (e) => (e as Error).message));
    expect(refused).toContain('"code":"locked"');
    await page.getByTestId('lock-input').fill('1111');
    await page.getByTestId('lock-submit').click();
    await expect(lock).toContainText('Wrong passcode');
    await page.getByTestId('lock-input').fill('2468');
    await page.getByTestId('lock-submit').click();
    await expect(lock).toBeHidden();
    await expect(page.getByTestId('tab-hosts')).toBeVisible();
  } finally {
    await h.close();
    cleanup(h.userData);
  }
});

test('master password encrypts the local key and is required at startup', async () => {
  test.setTimeout(90_000);
  const first = await launchApp();
  const userData = first.userData;
  await first.page.evaluate(() => window.cy.hosts.create({ label: 'behind-master', address: 'm.example' }));
  await openSettings(first.page, 'security');
  await first.page.getByTestId('master-password').fill('master-pass-123');
  await first.page.getByTestId('master-password-confirm').fill('master-pass-123');
  await first.page.getByTestId('master-enable').click();
  await expect(first.page.getByText('Master password set')).toBeVisible({ timeout: 20_000 });
  await first.close();

  const second = await launchApp(userData, {}, { waitFor: 'lock-screen' });
  try {
    const { page } = second;
    await expect(page.getByTestId('lock-screen')).toContainText('Unlock your data');
    await expect(page.getByTestId('tab-hosts')).toHaveCount(0);
    await page.getByTestId('lock-input').fill('wrong password');
    await page.getByTestId('lock-submit').click();
    await expect(page.getByTestId('lock-screen')).toContainText('Wrong password', { timeout: 15_000 });
    await page.getByTestId('lock-input').fill('master-pass-123');
    await page.getByTestId('lock-submit').click();
    await expect(page.getByTestId('host-row').filter({ hasText: 'behind-master' })).toBeVisible({ timeout: 15_000 });
  } finally {
    await second.close();
    cleanup(userData);
  }
});
