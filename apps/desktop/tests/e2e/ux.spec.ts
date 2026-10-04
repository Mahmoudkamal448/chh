import { expect, test } from '@playwright/test';
import { cleanup, expectTerminalToContain, launchApp, startSshServer, type AppHandle } from './fixtures';

let h: AppHandle;

test.beforeEach(async () => {
  h = await launchApp();
});

test.afterEach(async () => {
  await h.close();
  cleanup(h.userData);
});

test('first launch offers next steps, and Quick connect opens an unsaved session', async () => {
  const { page } = h;
  await expect(page.getByTestId('welcome')).toBeVisible();
  await page.getByTestId('quick-connect-input').fill('not a host');
  await page.getByTestId('quick-connect-go').click();
  await expect(page.getByTestId('quick-connect')).toContainText('Type a host');

  const server = await startSshServer({ password: 'secret' });
  try {
    await page.getByTestId('quick-connect-input').fill(`ssh -p ${server.port} tester@127.0.0.1`);
    await page.getByTestId('quick-connect-go').click();
    await page.getByTestId('hostkey-accept').click();
    const auth = page.getByTestId('auth-dialog');
    await auth.getByTestId('auth-input-0').fill('secret');
    await auth.getByTestId('auth-submit').click();
    await expectTerminalToContain(page, 'Welcome to chh-test');
    await expect(page.getByTestId('session-tab').filter({ hasText: `tester@127.0.0.1:${server.port}` })).toBeVisible();
    // Nothing was saved.
    await page.getByTestId('tab-hosts').click();
    await expect(page.getByTestId('welcome')).toBeVisible();
  } finally {
    await server.close();
  }
});

test('host rows have Connect, Files and Edit actions and show a live status', async () => {
  const { page } = h;
  const server = await startSshServer({ password: 'secret' });
  try {
    await page.getByTestId('welcome-new-host').click();
    const ed = page.getByTestId('host-editor');
    await ed.getByTestId('host-address').fill('127.0.0.1');
    await ed.getByTestId('host-label').fill('Row actions');
    await ed.getByLabel('Port', { exact: true }).fill(String(server.port));
    await ed.getByTestId('auth-method-password').click();
    await ed.getByTestId('host-username').fill('tester');
    await ed.getByTestId('host-password').fill('secret');
    await ed.getByTestId('host-save').click();
    await expect(ed).toBeHidden();

    const row = page.getByTestId('host-row').filter({ hasText: 'Row actions' });
    await row.hover();
    await row.getByTestId('host-action-edit').click();
    await expect(page.getByTestId('host-editor')).toBeVisible();
    await page.keyboard.press('Escape');

    await row.hover();
    await row.getByTestId('host-action-connect').click();
    await page.getByTestId('hostkey-accept').click();
    await expectTerminalToContain(page, 'Welcome to chh-test');
    await page.getByTestId('tab-hosts').click();
    await expect(row.getByTestId('host-live')).toHaveAttribute('aria-label', 'Connected');
  } finally {
    await server.close();
  }
});

test('the sidebar shows section names and can collapse to icons', async () => {
  const { page } = h;
  await expect(page.getByTestId('nav')).toContainText('Port forwarding');
  await page.getByTestId('nav-toggle').click();
  await expect(page.getByTestId('nav')).not.toContainText('Port forwarding');
  await page.getByTestId('nav-keys').click(); // still navigable by icon
  await expect(page.getByRole('heading', { name: 'Keys' })).toBeVisible();
});
