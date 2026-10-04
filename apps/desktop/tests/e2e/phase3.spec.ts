import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { startTelnetServer } from '../support/telnet-server';
import { accel, cleanup, expectTerminalToContain, launchApp, paneCount, recordedCommands, startSshServer, terminalText, waitForOutput, waitForPrompt, type AppHandle } from './fixtures';

const FIX = join(__dirname, '../../../../packages/key-formats/test/fixtures');
const hasMosh = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v mosh-client && command -v mosh-server'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let h: AppHandle;

test.afterEach(async () => {
  await h?.close();
  if (h) cleanup(h.userData);
});

async function typeInFocused(page: Page, text: string) {
  await page.locator('[data-testid="terminal"][data-focused] .xterm').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

async function createHost(page: Page, o: { label: string; port: number; protocol?: string; username?: string; password?: string }) {
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('new-host').click();
  const dlg = page.getByTestId('host-editor');
  if (o.protocol) await dlg.getByTestId('host-protocol').selectOption(o.protocol);
  await dlg.getByTestId('host-address').fill('127.0.0.1');
  await dlg.getByTestId('host-label').fill(o.label);
  await dlg.getByLabel('Port', { exact: true }).fill(String(o.port));
  if (o.username) await dlg.getByLabel('Username').fill(o.username);
  if (o.password) await dlg.getByTestId('host-password').fill(o.password);
  await dlg.getByTestId('host-save').click();
  await expect(dlg).toBeHidden();
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

test('split view: split, type in each pane, close one — the other keeps its scrollback', async () => {
  h = await launchApp();
  const { page } = h;
  await page.getByTestId('new-local').click();
  await page.waitForTimeout(500);
  await typeInFocused(page, 'echo first-$((1+1))');
  await expectTerminalToContain(page, 'first-2', 15_000, 0);

  await page.keyboard.press(accel('D'));
  await expect.poll(() => paneCount(page)).toBe(2);
  await expect(page.locator('[role="separator"]')).toHaveCount(1);
  await page.waitForTimeout(500);
  await typeInFocused(page, 'echo second-$((2+2))');
  await expectTerminalToContain(page, 'second-4', 15_000, 1);

  await page.keyboard.press(accel('W')); // closes the focused pane, not the tab
  await expect.poll(() => paneCount(page)).toBe(1);
  await expect(page.getByTestId('session-tab')).toHaveCount(1);
  expect(await terminalText(page, 0)).toContain('first-2');
});

test('snippets with variables run from the side panel; typed commands land in History', async () => {
  h = await launchApp();
  const { page } = h;
  await page.getByTestId('nav-snippets').click();
  await page.getByTestId('new-snippet').click();
  const ed = page.getByTestId('snippet-editor');
  await ed.getByTestId('snippet-label').fill('Greet');
  await ed.getByTestId('snippet-script').fill('echo hello-{{name}}');
  await ed.getByTestId('snippet-save').click();
  await expect(page.getByTestId('snippet-row')).toHaveCount(1);

  await page.getByTestId('new-local').click();
  await waitForPrompt(page);
  // The panel shortcut is ⌘⇧S on macOS (⌘S is left to the shell) and Ctrl+Shift+S elsewhere.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+S' : accel('S'));
  await page.getByTestId('side-panel').getByTestId('panel-snippet-run').click();
  await page.getByTestId('var-name').fill('cy');
  await page.getByTestId('snippet-variables-run').click();
  await waitForOutput(page, 'hello-cy');

  await typeInFocused(page, 'echo typed-history-$((3*3))');
  await expectTerminalToContain(page, 'typed-history-9');
  await expect.poll(() => recordedCommands(page)).toContain('echo typed-history-$((3*3))');
  await page.getByTestId('panel-history').click();
  await expect(page.getByTestId('side-panel').getByText('echo typed-history-$((3*3))')).toBeVisible();

  await page.getByTestId('tab-hosts').click();
  await page.getByTestId('nav-history').click();
  await page.getByTestId('history-search').fill('typed-history');
  await expect(page.getByTestId('history-row')).toHaveCount(1);
  await expect(page.getByTestId('history-row')).toContainText('echo typed-history-$((3*3))');
});

test('telnet host', async () => {
  const server = await startTelnetServer();
  try {
    h = await launchApp();
    const { page } = h;
    await createHost(page, { label: 'Router', port: server.port, protocol: 'telnet' });
    await page.getByTestId('host-row').filter({ hasText: 'Router' }).dblclick();
    await expectTerminalToContain(page, 'Welcome to chh-telnet');
    await typeInFocused(page, 'admin');
    await expectTerminalToContain(page, 'you typed: admin');
    await expect.poll(() => server.terminalType()).toBe('XTERM-256COLOR');
    expect(server.size()?.cols).toBeGreaterThan(20);
  } finally {
    await server.close();
  }
});

test('mosh host', async () => {
  test.skip(!hasMosh, 'mosh-client/mosh-server not installed');
  const ssh = await startSshServer({ allowMosh: true });
  try {
    h = await launchApp();
    const { page } = h;
    await createHost(page, { label: 'Mobile', port: ssh.port, protocol: 'mosh', username: 'tester', password: 'secret' });
    await page.getByTestId('host-row').filter({ hasText: 'Mobile' }).dblclick();
    await page.getByTestId('hostkey-accept').click();
    await page.waitForTimeout(2000);
    await typeInFocused(page, 'echo mosh-$((6*7))');
    await expectTerminalToContain(page, 'mosh-42', 20_000);
    await typeInFocused(page, 'exit');
  } finally {
    await ssh.close();
  }
});

test('port forwarding rule: create, start, tunnel traffic, stop', async () => {
  const ssh = await startSshServer();
  const echo: Server = createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
  const echoPort = (echo.address() as AddressInfo).port;
  const bindPort = await freePort();
  try {
    h = await launchApp();
    const { page } = h;
    await createHost(page, { label: 'Gateway', port: ssh.port, username: 'tester', password: 'secret' });
    await page.getByTestId('nav-forwards').click();
    await page.getByTestId('new-forward').click();
    const ed = page.getByTestId('forward-editor');
    await ed.getByTestId('forward-label').fill('Echo tunnel');
    await ed.getByTestId('forward-bind-port').fill(String(bindPort));
    await ed.getByTestId('forward-dest-host').fill('127.0.0.1');
    await ed.getByTestId('forward-dest-port').fill(String(echoPort));
    await ed.getByTestId('forward-save').click();

    const row = page.getByTestId('forward-row').filter({ hasText: 'Echo tunnel' });
    await row.getByTestId('forward-toggle').click();
    await page.getByTestId('hostkey-accept').click();
    await expect(row).toHaveAttribute('data-state', 'running');

    const reply = await new Promise<string>((resolve, reject) => {
      const s = connect(bindPort, '127.0.0.1', () => s.write('through-the-tunnel'));
      s.once('data', (d) => {
        resolve(d.toString());
        s.destroy();
      });
      s.on('error', reject);
    });
    expect(reply).toBe('through-the-tunnel');

    await row.getByTestId('forward-toggle').click();
    await expect(row).toHaveAttribute('data-state', 'stopped');
  } finally {
    echo.close();
    await ssh.close();
  }
});

test('imports hosts, keys and forwards from ~/.ssh/config and exports back', async () => {
  const home = mkdtempSync(join(tmpdir(), 'chh-e2e-home-'));
  mkdirSync(join(home, '.ssh'));
  copyFileSync(join(FIX, 'openssh-ed25519'), join(home, '.ssh', 'id_test'));
  writeFileSync(
    join(home, '.ssh', 'config'),
    ['Host *', '  User fallback', '', 'Host web1', '  HostName 10.0.0.11', '  Port 2222', '  IdentityFile ~/.ssh/id_test', '  LocalForward 15432 db.internal:5432', '', 'Host db', '  HostName db.example.com', '  User postgres', ''].join('\n'),
  );
  try {
    h = await launchApp(undefined, { HOME: home, USERPROFILE: home });
    const { page } = h;
    await page.getByTestId('ssh-config-menu').click();
    await page.getByTestId('ssh-import-default').click();
    const dlg = page.getByTestId('ssh-import-dialog');
    await expect(dlg.getByTestId('ssh-import-row')).toHaveCount(2);
    await expect(dlg).toContainText('fallback@10.0.0.11:2222');
    await dlg.getByTestId('ssh-import-submit').click();
    await expect(dlg.getByTestId('ssh-import-result')).toContainText('Imported 2 hosts, 1 keys and 1 forwarding rules');
    await dlg.getByRole('button', { name: 'Close' }).last().click();

    await expect(page.getByTestId('host-row').filter({ hasText: 'web1' })).toContainText('fallback@10.0.0.11:2222');
    await page.getByTestId('nav-keys').click();
    await expect(page.getByTestId('key-row')).toHaveCount(1);
    await page.getByTestId('nav-forwards').click();
    await expect(page.getByTestId('forward-row')).toContainText('127.0.0.1:15432 → db.internal:5432');

    await page.getByTestId('nav-hosts').click();
    await page.getByTestId('ssh-config-menu').click();
    await page.getByTestId('ssh-export-copy').click();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain('Host web1');
    expect(text).toContain('LocalForward 15432 db.internal:5432');
    expect(text).toContain('HostName db.example.com'); // "Host *" came first, so User is "fallback" (first value wins)
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
