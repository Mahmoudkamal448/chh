import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { cleanup, expectTerminalToContain, launchApp, startSshServer, type AppHandle } from './fixtures';

const FIX = join(__dirname, '../../../../packages/key-formats/test/fixtures');

let h: AppHandle;

test.beforeEach(async () => {
  h = await launchApp();
});

test.afterEach(async () => {
  await h.close();
  cleanup(h.userData);
});

async function createHost(page: Page, opts: { label: string; port: number; username?: string; password?: string; key?: string; identity?: string }) {
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('new-host').click();
  const dlg = page.getByTestId('host-editor');
  await dlg.getByTestId('host-address').fill('127.0.0.1');
  await dlg.getByTestId('host-label').fill(opts.label);
  await dlg.getByLabel('Port').fill(String(opts.port));
  if (opts.username) await dlg.getByLabel('Username').fill(opts.username);
  if (opts.password) await dlg.getByTestId('host-password').fill(opts.password);
  if (opts.key) await dlg.getByTestId('host-key').selectOption({ label: opts.key });
  if (opts.identity) await dlg.getByTestId('host-identity').selectOption({ label: opts.identity });
  await dlg.getByTestId('host-save').click();
  await expect(dlg).toBeHidden();
}

test('generates a key and logs in with it — no password prompt', async () => {
  const { page } = h;
  await page.getByTestId('nav-keys').click();
  await page.getByTestId('generate-key').click();
  await page.getByTestId('key-label').fill('E2E key');
  await page.getByTestId('generate-key-submit').click();
  await expect(page.getByTestId('key-row').filter({ hasText: 'E2E key' })).toBeVisible();
  const publicKey = await page.getByTestId('public-key-text').inputValue();
  expect(publicKey).toMatch(/^ssh-ed25519 /);

  const server = await startSshServer({ authorizedKeys: [publicKey] });
  try {
    await createHost(page, { label: 'Key host', port: server.port, username: 'tester', key: 'E2E key (ED25519)' });
    await page.getByTestId('host-row').filter({ hasText: 'Key host' }).dblclick();
    await page.getByTestId('hostkey-accept').click();
    await expectTerminalToContain(page, 'Welcome to chh-test');
    await expect(page.getByTestId('auth-dialog')).toHaveCount(0);

    // The key is now listed as used by the host.
    await page.getByTestId('tab-hosts').click();
    await page.getByTestId('nav-keys').click();
    await expect(page.getByRole('region', { name: 'E2E key' }).getByText('Key host', { exact: true })).toBeVisible();
  } finally {
    await server.close();
  }
});

test('imports a passphrase-protected PuTTY key', async () => {
  const { page } = h;
  await page.getByTestId('nav-keys').click();
  await page.getByTestId('import-key').click();
  await page.getByTestId('import-key-paste').click();
  const dlg = page.getByTestId('import-key-dialog');
  await dlg.getByTestId('key-paste').fill(readFileSync(join(FIX, 'ppk3-rsa2048-enc.ppk'), 'utf8'));
  await dlg.getByTestId('import-key-submit').click();
  await expect(dlg).toContainText('protected by a passphrase');
  await dlg.getByTestId('key-passphrase').fill('wrong');
  await dlg.getByTestId('import-key-submit').click();
  await expect(dlg).toContainText('incorrect');
  await dlg.getByTestId('key-passphrase').fill('test-pass');
  await dlg.getByTestId('import-key-submit').click();
  await expect(dlg).toBeHidden();
  const expected = readFileSync(join(FIX, 'openssh-rsa2048.pub'), 'utf8').split(' ').slice(0, 2).join(' ');
  await expect(page.getByTestId('public-key-text')).toHaveValue(new RegExp(`^${expected.replace(/[+/]/g, '\\$&')}`));
});

test('identities supply username and password; known hosts can be managed', async () => {
  const server = await startSshServer();
  try {
    const { page } = h;
    await page.getByTestId('nav-identities').click();
    await page.getByTestId('new-identity').click();
    const ed = page.getByTestId('identity-editor');
    await ed.getByTestId('identity-label').fill('Tester');
    await ed.getByTestId('identity-username').fill('tester');
    await ed.getByTestId('identity-password').fill('secret');
    await ed.getByTestId('identity-save').click();
    await expect(page.getByTestId('identity-row').filter({ hasText: 'Tester' })).toBeVisible();

    await createHost(page, { label: 'Via identity', port: server.port, identity: 'Tester (tester)' });
    await page.getByTestId('host-row').filter({ hasText: 'Via identity' }).dblclick();
    await page.getByTestId('hostkey-accept').click();
    await expectTerminalToContain(page, 'Welcome to chh-test');
    await expect(page.getByTestId('auth-dialog')).toHaveCount(0);

    // The trusted key shows up in Known hosts; removing it brings the prompt back.
    await page.getByTestId('tab-hosts').click();
    await page.getByTestId('nav-knownHosts').click();
    const row = page.getByTestId('known-host-row').filter({ hasText: `[127.0.0.1]:${server.port}` });
    await expect(row).toContainText(server.fingerprint);
    await row.click();
    await page.getByTestId('known-hosts-delete').click();
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByTestId('known-host-row')).toHaveCount(0);

    await page.getByTestId('nav-hosts').click();
    await page.getByTestId('host-row').filter({ hasText: 'Via identity' }).dblclick();
    await expect(page.getByTestId('hostkey-dialog')).toBeVisible();
  } finally {
    await server.close();
  }
});

test('SFTP browser: upload, download, mkdir, permissions, delete', async () => {
  const remote = mkdtempSync(join(tmpdir(), 'chh-e2e-remote-'));
  const local = mkdtempSync(join(tmpdir(), 'chh-e2e-local-'));
  writeFileSync(join(local, 'upload-me.txt'), 'from local');
  mkdirSync(join(remote, 'docs'));
  writeFileSync(join(remote, 'docs', 'report.txt'), 'remote report');
  const server = await startSshServer({ sftpRoot: remote });
  try {
    const { page } = h;
    await createHost(page, { label: 'Files host', port: server.port, username: 'tester', password: 'secret' });
    await page.getByTestId('host-row').filter({ hasText: 'Files host' }).click({ button: 'right' });
    await page.getByTestId('host-open-files').click();
    await page.getByTestId('hostkey-accept').click();

    const left = page.getByTestId('pane-left');
    const right = page.getByTestId('pane-right');
    await expect(right.getByTestId('file-row').filter({ hasText: 'docs' })).toBeVisible();

    // Point the local pane at our temp folder.
    await left.getByTestId('pane-left-path').fill(local);
    await left.getByTestId('pane-left-path').press('Enter');
    await expect(left.getByTestId('file-row').filter({ hasText: 'upload-me.txt' })).toBeVisible();

    // Upload with F5.
    await left.getByTestId('file-row').filter({ hasText: 'upload-me.txt' }).click();
    await page.keyboard.press('F5');
    await expect(right.getByTestId('file-row').filter({ hasText: 'upload-me.txt' })).toBeVisible();
    expect(readFileSync(join(remote, 'upload-me.txt'), 'utf8')).toBe('from local');
    await expect(page.getByTestId('transfer-row').first()).toHaveAttribute('data-state', 'done');

    // Download a folder by dragging it to the local pane.
    await right.getByTestId('file-row').filter({ hasText: 'docs' }).dragTo(left.getByTestId('pane-left-list'));
    await expect(left.getByTestId('file-row').filter({ hasText: 'docs' })).toBeVisible();
    await expect.poll(() => existsSync(join(local, 'docs', 'report.txt'))).toBe(true);
    expect(readFileSync(join(local, 'docs', 'report.txt'), 'utf8')).toBe('remote report');

    // Uploading again asks about the conflict.
    await left.getByTestId('file-row').filter({ hasText: 'upload-me.txt' }).click();
    await page.keyboard.press('F5');
    await page.getByTestId('conflict-dialog').getByRole('button', { name: 'Keep both' }).click();
    await expect(right.getByTestId('file-row').filter({ hasText: 'upload-me (1).txt' })).toBeVisible();

    // New folder on the remote side.
    await right.getByTestId('pane-right-mkdir').click();
    await page.getByTestId('prompt-input').fill('new-dir');
    await page.getByTestId('prompt-submit').click();
    await expect(right.getByTestId('file-row').filter({ hasText: 'new-dir' })).toBeVisible();
    expect(statSync(join(remote, 'new-dir')).isDirectory()).toBe(true);

    // Permissions.
    await right.getByTestId('file-row').filter({ hasText: /^upload-me\.txt/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Permissions/ }).click();
    await page.getByTestId('perm-octal').fill('600');
    await page.getByTestId('permissions-apply').click();
    // Windows keeps only a read-only flag: a writable file reads back as 0o666 there.
    await expect.poll(() => statSync(join(remote, 'upload-me.txt')).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600);

    // Delete.
    await right.getByTestId('file-row').filter({ hasText: 'new-dir' }).click();
    await page.keyboard.press('Delete');
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(right.getByTestId('file-row').filter({ hasText: 'new-dir' })).toHaveCount(0);
    expect(existsSync(join(remote, 'new-dir'))).toBe(false);
  } finally {
    await server.close();
    rmSync(remote, { recursive: true, force: true });
    rmSync(local, { recursive: true, force: true });
  }
});
