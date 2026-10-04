import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { cleanup, expectTerminalToContain, launchApp, startSshServer, type AppHandle } from './fixtures';

const FIX = join(__dirname, '../../../../packages/key-formats/test/fixtures');
const read = (name: string) => readFileSync(join(FIX, name), 'utf8');

let h: AppHandle;

test.beforeEach(async () => {
  h = await launchApp();
});

test.afterEach(async () => {
  await h.close();
  cleanup(h.userData);
});

async function importKey(page: Page, file: string, label: string) {
  await page.getByTestId('nav-keys').click();
  await page.getByTestId('import-key').click();
  await page.getByTestId('import-key-paste').click();
  const dlg = page.getByTestId('import-key-dialog');
  await dlg.getByTestId('key-paste').fill(read(file));
  await dlg.getByLabel('Label').fill(label);
  await dlg.getByTestId('import-key-submit').click();
  await expect(dlg).toBeHidden();
}

async function editHost(page: Page, label: string) {
  await page.getByTestId('tab-hosts').click();
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('host-row').filter({ hasText: label }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  return page.getByTestId('host-editor');
}

test('each authentication method uses only its own credentials', async () => {
  const { page } = h;
  await importKey(page, 'openssh-ed25519', 'Work key');
  // The server knows the key and a password different from the one saved below.
  const server = await startSshServer({ authorizedKeys: [read('openssh-ed25519.pub')], password: 'server-pw' });
  try {
    await page.getByTestId('nav-hosts').click();
    await page.getByTestId('new-host').click();
    const ed = page.getByTestId('host-editor');
    await ed.getByTestId('host-address').fill('127.0.0.1');
    await ed.getByTestId('host-label').fill('Methods');
    await ed.getByLabel('Port', { exact: true }).fill(String(server.port));
    // Password: user name and password only; the key isn't even offered.
    await ed.getByTestId('auth-method-password').click();
    await expect(ed.getByTestId('host-key')).toHaveCount(0);
    await ed.getByTestId('host-username').fill('tester');
    await ed.getByTestId('host-password').fill('wrong-pw');
    await ed.getByTestId('host-save').click();
    await expect(ed).toBeHidden();

    await page.getByTestId('host-row').filter({ hasText: 'Methods' }).dblclick();
    await page.getByTestId('hostkey-accept').click();
    // The saved password is wrong and the key isn't used, so it asks.
    const auth = page.getByTestId('auth-dialog');
    await expect(auth).toBeVisible();
    await auth.getByTestId('auth-input-0').fill('server-pw');
    await auth.getByTestId('auth-submit').click();
    await expectTerminalToContain(page, 'Welcome to chh-test');

    // Key: logs in with the key, no prompt.
    const ed2 = await editHost(page, 'Methods');
    await ed2.getByTestId('auth-method-key').click();
    await expect(ed2.getByTestId('host-password')).toHaveCount(0);
    await ed2.getByTestId('host-key').selectOption({ label: 'Work key (ED25519)' });
    await ed2.getByTestId('host-save').click();
    await expect(ed2).toBeHidden();
    await page.getByTestId('host-row').filter({ hasText: 'Methods' }).dblclick();
    await expectTerminalToContain(page, 'Welcome to chh-test');
    await expect(page.getByTestId('auth-dialog')).toHaveCount(0);

    // Certificate without a certificate on the key: a clear message instead of a confusing login failure.
    const ed3 = await editHost(page, 'Methods');
    await ed3.getByTestId('auth-method-certificate').click();
    await expect(ed3.getByTestId('cert-add')).toBeVisible();
    await ed3.getByTestId('host-save').click();
    await expect(ed3).toBeHidden();
    await page.getByTestId('host-row').filter({ hasText: 'Methods' }).dblclick();
    await expect(page.getByTestId('session-overlay').last()).toContainText('is set to log in with a certificate, but its key has none');
  } finally {
    await server.close();
  }
});
