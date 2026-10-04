import { expect, test, type Page } from '@playwright/test';
import { accel, cleanup, expectTerminalToContain, launchApp, startSshServer, type AppHandle } from './fixtures';

let h: AppHandle;

test.beforeEach(async () => {
  h = await launchApp();
});

test.afterEach(async () => {
  await h.close();
  cleanup(h.userData);
});

async function createHost(page: Page, opts: { label: string; port: number; username?: string; password?: string }) {
  await page.getByTestId('new-host').click();
  const dlg = page.getByTestId('host-editor');
  await dlg.getByTestId('host-address').fill('127.0.0.1');
  await dlg.getByTestId('host-label').fill(opts.label);
  await dlg.getByLabel('Port').fill(String(opts.port));
  if (opts.username) await dlg.getByLabel('Username').fill(opts.username);
  if (opts.password) await dlg.getByTestId('host-password').fill(opts.password);
  await dlg.getByTestId('host-save').click();
  await expect(dlg).toBeHidden();
  await expect(page.getByTestId('host-row').filter({ hasText: opts.label })).toBeVisible();
}

async function typeInTerminal(page: Page, text: string) {
  await page.locator('[role="tabpanel"]:not(.hidden) .xterm').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test('opens a local terminal and runs a command', async () => {
  const { page } = h;
  await page.getByTestId('new-local').click();
  await expect(page.getByTestId('session-tab')).toHaveCount(1);
  await page.waitForTimeout(500); // let the shell print its prompt
  await typeInTerminal(page, 'echo cy-$((40+2))');
  await expectTerminalToContain(page, 'cy-42');
});

test('connects over SSH, verifies the host key, and remembers it', async () => {
  const server = await startSshServer();
  try {
    const { page } = h;
    await createHost(page, { label: 'Test server', port: server.port, username: 'tester', password: 'secret' });
    await page.getByTestId('host-row').filter({ hasText: 'Test server' }).dblclick();

    const dlg = page.getByTestId('hostkey-dialog');
    await expect(dlg).toBeVisible();
    await expect(dlg.getByTestId('hostkey-fingerprint')).toHaveText(server.fingerprint);
    await dlg.getByTestId('hostkey-accept').click();

    await expectTerminalToContain(page, 'Welcome to chh-test');
    await typeInTerminal(page, 'echo hello-cy');
    await expectTerminalToContain(page, 'hello-cy\n');

    // Close the tab, reconnect from the command palette: the saved key means no prompt.
    await page.keyboard.press(accel('W'));
    await expect(page.getByTestId('session-tab')).toHaveCount(0);
    await page.keyboard.press(accel('K'));
    await page.getByTestId('palette-input').fill('Test');
    await page.keyboard.press('Enter');
    await expectTerminalToContain(page, 'Welcome to chh-test');
    await expect(page.getByTestId('hostkey-dialog')).toHaveCount(0);

    // Shell exit shows the reconnect bar.
    await typeInTerminal(page, 'exit');
    await expect(page.getByTestId('reconnect')).toBeVisible();
  } finally {
    await server.close();
  }
});

test('warns loudly when a known host key changes', async () => {
  const first = await startSshServer();
  const port = first.port;
  const { page } = h;
  await createHost(page, { label: 'Rekeyed', port, username: 'tester', password: 'secret' });
  await page.getByTestId('host-row').filter({ hasText: 'Rekeyed' }).dblclick();
  await page.getByTestId('hostkey-accept').click();
  await expectTerminalToContain(page, 'Welcome to chh-test');
  await page.keyboard.press(accel('W'));
  await first.close();

  const second = await startSshServer({ port });
  try {
    await page.getByTestId('host-row').filter({ hasText: 'Rekeyed' }).dblclick();
    const dlg = page.getByTestId('hostkey-dialog');
    await expect(dlg).toContainText('host key has changed');
    await expect(dlg).toContainText(first.fingerprint);
    await expect(dlg).toContainText(second.fingerprint);
    await dlg.getByRole('button', { name: 'Disconnect' }).click();
    await expect(page.getByTestId('session-overlay')).toContainText(/Connection error|closed|failed/i);
  } finally {
    await second.close();
  }
});

test('prompts for a password, retries, and can remember it', async () => {
  const server = await startSshServer();
  try {
    const { page } = h;
    await createHost(page, { label: 'No password', port: server.port, username: 'tester' });
    await page.getByTestId('host-row').filter({ hasText: 'No password' }).dblclick();
    await page.getByTestId('hostkey-accept').click();

    const auth = page.getByTestId('auth-dialog');
    await auth.getByTestId('auth-input-0').fill('wrong');
    await auth.getByTestId('auth-submit').click();
    await expect(auth).toContainText("didn't work");
    await auth.getByTestId('auth-input-0').fill('secret');
    await auth.getByLabel('Remember password on this device').check();
    await auth.getByTestId('auth-submit').click();
    await expectTerminalToContain(page, 'Welcome to chh-test');

    await page.getByTestId('tab-hosts').click();
    await expect(page.getByTestId('host-row').filter({ hasText: 'No password' }).getByRole('img', { name: 'Password saved' })).toBeVisible();
  } finally {
    await server.close();
  }
});

test('stays responsive with thousands of hosts', async () => {
  const { page } = h;
  await page.evaluate(() => window.chh.dev.seedHosts({ count: 5000 }));
  const search = page.getByTestId('host-search');
  await search.fill('seed-');
  await expect(page.getByText('5000 hosts')).toBeVisible();
  // Virtualized: only a screenful of rows exist in the DOM.
  expect(await page.getByTestId('host-row').count()).toBeLessThan(80);

  const t0 = Date.now();
  await search.fill('seed-04321');
  await expect(page.getByText('1 host', { exact: true })).toBeVisible();
  expect(Date.now() - t0).toBeLessThan(2000);
});

test('switches between light and dark themes', async () => {
  const { page } = h;
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
  await page.getByTestId('ui-theme').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByTestId('ui-theme').selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
