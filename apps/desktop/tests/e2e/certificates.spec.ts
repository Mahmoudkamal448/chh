import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { cleanup, expectTerminalToContain, launchApp, startSshServer, type AppHandle } from './fixtures';

// Certificates for user "tester" signed by fixtures/cert-ca (see packages/key-formats/test/fixtures).
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

test('adds a certificate while creating an identity and logs in with it', async () => {
  const { page } = h;
  // The key, as the user would have it.
  await page.getByTestId('nav-keys').click();
  await page.getByTestId('import-key').click();
  await page.getByTestId('import-key-paste').click();
  const imp = page.getByTestId('import-key-dialog');
  await imp.getByTestId('key-paste').fill(read('openssh-ed25519'));
  await imp.getByLabel('Label').fill('Work key');
  await imp.getByTestId('import-key-submit').click();
  await expect(imp).toBeHidden();

  // New identity: pick the key, then add its certificate right there.
  await page.getByTestId('nav-identities').click();
  await page.getByTestId('new-identity').click();
  const ed = page.getByTestId('identity-editor');
  await ed.getByTestId('identity-label').fill('Ops (certificate)');
  await ed.getByTestId('identity-username').fill('tester');
  await ed.getByTestId('identity-key').selectOption({ label: 'Work key (ED25519)' });
  await ed.getByTestId('cert-add').click();
  const dlg = page.getByTestId('cert-dialog');
  // A certificate for another key is refused with an explanation.
  await dlg.getByTestId('cert-text').fill(read('openssh-ecdsa256-tester-cert.pub'));
  await dlg.getByTestId('cert-save').click();
  await expect(dlg.getByTestId('cert-error')).toContainText('different key');
  await dlg.getByTestId('cert-text').fill(read('openssh-ed25519-tester-cert.pub'));
  await dlg.getByTestId('cert-save').click();
  await expect(dlg).toBeHidden();
  await expect(ed.getByTestId('cert-principals')).toHaveText('tester');
  await expect(ed.getByTestId('cert-validity')).toContainText('Valid until');
  await expect(ed).toBeVisible(); // adding the certificate didn't save or close the identity
  await ed.getByTestId('identity-save').click();
  await expect(ed).toBeHidden();
  await expect(page.getByTestId('identity-row').filter({ hasText: 'Ops (certificate)' }).getByTestId('cert-chip')).toBeVisible();

  // A server that trusts only the CA: no authorized_keys, no password.
  const server = await startSshServer({ password: 'not-offered', trustedUserCAKeys: [read('cert-ca.pub')] });
  try {
    await page.getByTestId('nav-hosts').click();
    await page.getByTestId('new-host').click();
    const host = page.getByTestId('host-editor');
    await host.getByTestId('host-address').fill('127.0.0.1');
    await host.getByTestId('host-label').fill('Cert host');
    await host.getByLabel('Port', { exact: true }).fill(String(server.port));
    await host.getByTestId('host-identity').selectOption({ label: 'Ops (certificate) (tester)' });
    await host.getByTestId('host-save').click();
    await expect(host).toBeHidden();
    await page.getByTestId('host-row').filter({ hasText: 'Cert host' }).dblclick();
    await page.getByTestId('hostkey-accept').click();
    await expectTerminalToContain(page, 'Welcome to chh-test');
    await expect(page.getByTestId('auth-dialog')).toHaveCount(0);
    expect(server.certificateLogins).toEqual(['ok']);
  } finally {
    await server.close();
  }

  // The Keys screen shows the certificate's details.
  await page.getByTestId('tab-hosts').click();
  await page.getByTestId('nav-keys').click();
  await expect(page.getByTestId('key-row').filter({ hasText: 'Work key' }).getByTestId('cert-chip')).toBeVisible();
  await expect(page.getByTestId('cert-panel')).toContainText('openssh-ed25519-tester');
});
