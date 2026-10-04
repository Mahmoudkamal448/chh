import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { Server, utils } from 'ssh2';

export interface AppHandle {
  app: ElectronApplication;
  page: Page;
  userData: string;
  close(): Promise<void>;
}

/** Launches the built app with an isolated, throwaway user-data directory. */
export async function launchApp(userData = mkdtempSync(join(tmpdir(), 'cy-ssh-e2e-'))): Promise<AppHandle> {
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
    } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="tab-hosts"]');
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
export async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __cyTest: { terminalText(): string } }).__cyTest.terminalText());
}

export async function expectTerminalToContain(page: Page, text: string, timeout = 15_000): Promise<void> {
  await expect.poll(() => terminalText(page), { timeout }).toContain(text);
}

export const accel = (key: string) => (process.platform === 'darwin' ? `Meta+${key}` : `Control+Shift+${key}`);

export interface TestSshServer {
  port: number;
  fingerprint: string;
  close(): Promise<void>;
}

/**
 * A minimal SSH server: password auth (tester/secret), a fake shell that echoes input and
 * implements `echo …` and `exit`.
 */
export async function startSshServer(opts: { port?: number } = {}): Promise<TestSshServer> {
  const key = utils.generateKeyPairSync('ed25519');
  const parsed = utils.parseKey(key.public);
  if (parsed instanceof Error) throw parsed;
  const pubBlob = (Array.isArray(parsed) ? parsed[0]! : parsed).getPublicSSH();
  const fingerprint = `SHA256:${createHash('sha256').update(pubBlob).digest('base64').replace(/=+$/, '')}`;

  const clients = new Set<{ end(): void }>();
  const server = new Server({ hostKeys: [key.private] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'secret') ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acc) => acc?.());
        session.on('window-change', (acc) => acc?.());
        session.on('shell', (acc) => {
          const stream = acc();
          stream.write('Welcome to cy-test\r\n$ ');
          let line = '';
          stream.on('data', (d: Buffer) => {
            for (const ch of d.toString('utf8')) {
              if (ch === '\r' || ch === '\n') {
                stream.write('\r\n');
                const cmd = line.trim();
                line = '';
                if (cmd === 'exit') {
                  stream.exit(0);
                  stream.end();
                  return;
                }
                if (cmd.startsWith('echo ')) stream.write(`${cmd.slice(5)}\r\n`);
                stream.write('$ ');
              } else if (ch === '\x7f') {
                line = line.slice(0, -1);
                stream.write('\b \b');
              } else {
                line += ch;
                stream.write(ch);
              }
            }
          });
        });
      });
    });
  });

  await new Promise<void>((res) => server.listen(opts.port ?? 0, '127.0.0.1', () => res()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    fingerprint,
    close: () =>
      new Promise<void>((res) => {
        // server.close() waits for open connections, so drop them first.
        for (const c of clients) c.end();
        server.close(() => res());
      }),
  };
}
