import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { cleanup, expectTerminalToContain, launchApp, startSshServer, terminalText, type AppHandle } from './fixtures';

const has = (cmd: string) => {
  try {
    execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

let h: AppHandle | null = null;
test.afterEach(async () => {
  if (h) {
    await h.close();
    cleanup(h.userData);
    h = null;
  }
});

async function newHost(page: Page, o: { label: string; port?: number; protocol?: string; address?: string; username?: string; password?: string }) {
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('new-host').click();
  const dlg = page.getByTestId('host-editor');
  if (o.protocol) await dlg.getByTestId('host-protocol').selectOption(o.protocol);
  await dlg.getByTestId('host-address').fill(o.address ?? '127.0.0.1');
  await dlg.getByTestId('host-label').fill(o.label);
  if (o.port) await dlg.getByLabel('Port', { exact: true }).fill(String(o.port));
  if (o.username) await dlg.getByLabel('Username').fill(o.username);
  if (o.password) await dlg.getByTestId('host-password').fill(o.password);
  return dlg;
}

async function typeLine(page: Page, text: string) {
  await page.locator('[data-testid="terminal"][data-focused] .xterm').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test('jump host chain, env variables and OS detection', async () => {
  const jump = await startSshServer({ password: 'jump-pw' });
  const target = await startSshServer({ osRelease: 'ID=debian\n' });
  try {
    h = await launchApp();
    const { page } = h;
    let dlg = await newHost(page, { label: 'Bastion', port: jump.port, username: 'tester', password: 'jump-pw' });
    await dlg.getByTestId('host-save').click();
    dlg = await newHost(page, { label: 'Inner', port: target.port, username: 'tester', password: 'secret' });
    await dlg.getByTestId('advanced-fields').locator('summary').click();
    await dlg.getByTestId('jump-pick').selectOption({ label: 'Bastion' });
    await dlg.getByTestId('jump-add').click();
    await expect(dlg.getByTestId('jump-row')).toHaveCount(1);
    await dlg.getByTestId('env-add').click();
    await dlg.getByTestId('env-name').fill('APP_ENV');
    await dlg.getByTestId('env-value').fill('staging');
    await dlg.getByTestId('host-save').click();
    await expect(dlg).toBeHidden();

    await page.getByTestId('host-row').filter({ hasText: 'Inner' }).dblclick();
    // Two hops → two host keys to verify.
    await page.getByTestId('hostkey-accept').click();
    await page.getByTestId('hostkey-accept').click();
    await expectTerminalToContain(page, 'Welcome to chh-test');
    expect(target.env.APP_ENV).toBe('staging');
    await page.getByTestId('tab-hosts').click();
    await expect(page.getByTestId('host-row').filter({ hasText: 'Inner' }).getByTestId('os-badge')).toHaveAttribute('data-os', 'debian');
  } finally {
    await jump.close();
    await target.close();
  }
});

test('run a snippet on several hosts in parallel with per-host results', async () => {
  const a = await startSshServer({ exec: (c) => ({ stdout: `A says ${c}\n` }) });
  const b = await startSshServer({ exec: () => ({ stderr: 'disk full\n', code: 2 }) });
  try {
    h = await launchApp();
    const { page } = h;
    for (const [label, port] of [['node-a', a.port], ['node-b', b.port]] as const) {
      const dlg = await newHost(page, { label, port, username: 'tester', password: 'secret' });
      await dlg.getByTestId('host-save').click();
    }
    // Host keys are trusted ahead of time so the run doesn't stop for prompts.
    for (const label of ['node-a', 'node-b']) {
      await page.getByTestId('host-row').filter({ hasText: label }).dblclick();
      await page.getByTestId('hostkey-accept').click();
      await expectTerminalToContain(page, 'Welcome to chh-test');
      await page.getByTestId('tab-hosts').click();
    }
    await page.getByTestId('nav-snippets').click();
    await page.getByTestId('new-snippet').click();
    await page.getByTestId('snippet-label').fill('Check');
    await page.getByTestId('snippet-script').fill('df -h /');
    await page.getByTestId('snippet-save').click();
    await page.getByTestId('snippet-run-multi').click();
    const picker = page.getByTestId('host-multi-picker');
    await picker.getByTestId('picker-all').check();
    await picker.getByTestId('picker-confirm').click();

    const view = page.getByTestId('run-view');
    await expect(view.getByTestId('run-host').filter({ hasText: 'node-a' })).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    await expect(view.getByTestId('run-host').filter({ hasText: 'node-b' })).toHaveAttribute('data-exit', '2');
    await expect(view.getByTestId('run-summary')).toContainText('1 succeeded · 1 failed · 2 hosts');
    await view.getByTestId('run-host').filter({ hasText: 'node-a' }).getByRole('button').first().click();
    await expect(view.getByTestId('run-output')).toContainText('A says df -h /');
  } finally {
    await a.close();
    await b.close();
  }
});

test('serial port terminal (virtual port pair)', async () => {
  test.skip(!has('socat'), 'socat not installed');
  const dir = mkdtempSync(join(tmpdir(), 'chh-serial-'));
  const socat: ChildProcess = spawn('socat', ['-d', '-d', `pty,raw,echo=0,link=${dir}/ttyA`, `pty,raw,echo=0,link=${dir}/ttyB`], { stdio: 'ignore' });
  try {
    await expect.poll(() => existsSync(`${dir}/ttyA`) && existsSync(`${dir}/ttyB`)).toBe(true);
    const device = openSync(`${dir}/ttyB`, 'r+');
    h = await launchApp();
    const { page } = h;
    const dlg = await newHost(page, { label: 'Router console', protocol: 'serial', address: `${dir}/ttyA` });
    await expect(dlg.getByTestId('serial-fields')).toBeVisible();
    await dlg.getByTestId('serial-baud').selectOption('9600');
    await dlg.getByTestId('host-save').click();
    await page.getByTestId('host-row').filter({ hasText: 'Router console' }).dblclick();
    await page.waitForTimeout(500);
    writeSync(device, 'Router> ');
    await expectTerminalToContain(page, 'Router>');
    await typeLine(page, 'show ver');
    // The device side receives what was typed, with CR line endings.
    const buf = Buffer.alloc(64);
    await expect.poll(() => {
      try {
        const n = readSync(device, buf, 0, 64, null);
        return buf.subarray(0, n).toString();
      } catch {
        return '';
      }
    }).toContain('show ver\r');
    closeSync(device);
  } finally {
    socat.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('System OpenSSH engine runs the installed ssh client', async () => {
  test.skip(!has('ssh'), 'OpenSSH client not installed');
  const server = await startSshServer();
  const home = mkdtempSync(join(tmpdir(), 'chh-home-'));
  mkdirSync(join(home, '.ssh'));
  try {
    h = await launchApp(undefined, { HOME: home });
    const { page } = h;
    const dlg = await newHost(page, { label: 'Via OpenSSH', port: server.port, username: 'tester' });
    await dlg.getByTestId('advanced-fields').locator('summary').click();
    await dlg.getByTestId('ssh-engine').selectOption('openssh');
    await dlg.getByTestId('host-save').click();
    await page.getByTestId('host-row').filter({ hasText: 'Via OpenSSH' }).dblclick();
    await expectTerminalToContain(page, 'Are you sure you want to continue connecting');
    await typeLine(page, 'yes');
    await expectTerminalToContain(page, 'password:');
    await typeLine(page, 'secret');
    await expectTerminalToContain(page, 'Welcome to chh-test');
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('autocomplete: ghost suggestion from history, accepted with →; Ctrl+Space list', async () => {
  h = await launchApp();
  const { page } = h;
  await page.getByTestId('new-local').click();
  await page.waitForTimeout(600);
  await typeLine(page, 'echo ghost-test-123');
  await expectTerminalToContain(page, 'ghost-test-123');
  await page.waitForTimeout(400); // history is recorded shortly after Enter
  await page.keyboard.type('echo gho');
  await expect(page.getByTestId('ghost-suggestion')).toHaveText('st-test-123');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await terminalText(page)).match(/ghost-test-123/g)?.length ?? 0).toBeGreaterThanOrEqual(4);

  await page.keyboard.type('echo g');
  // Suggestions read the input line from the screen: wait until the shell has echoed it.
  await expect(page.getByTestId('ghost-suggestion')).toHaveText('host-test-123');
  await page.keyboard.press('Control+Space');
  const list = page.getByTestId('suggestion-list');
  await expect(list).toContainText('echo ghost-test-123');
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
});

test('import droplets from DigitalOcean (fake API)', async () => {
  const api: Server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer do-token') {
      res.statusCode = 401;
      return res.end('{}');
    }
    res.end(
      JSON.stringify({
        droplets: [{ id: 7, name: 'do-web', region: { slug: 'ams3' }, image: { distribution: 'Ubuntu' }, networks: { v4: [{ ip_address: '203.0.113.9', type: 'public' }] } }],
        links: {},
      }),
    );
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  try {
    h = await launchApp(undefined, { CHH_DO_ENDPOINT: `http://127.0.0.1:${(api.address() as AddressInfo).port}` });
    const { page } = h;
    await page.getByTestId('ssh-config-menu').click();
    await page.getByTestId('import-do').click();
    const dlg = page.getByTestId('cloud-import-dialog');
    await dlg.getByTestId('do-token').fill('wrong');
    await dlg.getByTestId('cloud-fetch').click();
    await expect(dlg.getByRole('alert')).toHaveText('The credentials were rejected.');
    await dlg.getByTestId('do-token').fill('do-token');
    await dlg.getByTestId('cloud-fetch').click();
    await expect(dlg.getByTestId('cloud-row')).toHaveCount(1);
    await dlg.getByTestId('cloud-import').click();
    await expect(dlg.getByTestId('cloud-result')).toHaveText('1 hosts added, 0 updated.');
    await page.keyboard.press('Escape');
    const row = page.getByTestId('host-row').filter({ hasText: 'do-web' });
    await expect(row).toContainText('root@203.0.113.9');
    await expect(row.getByTestId('os-badge')).toHaveAttribute('data-os', 'ubuntu');
  } finally {
    api.close();
  }
});
