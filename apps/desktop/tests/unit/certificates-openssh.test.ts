import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectChain, type ConnectCallbacks } from '../../src/session-host/ssh/connect';
import { sshConfig } from '../support/config';

/**
 * Certificate logins against the reference implementation: a real OpenSSH sshd that trusts only the test
 * CA (TrustedUserCAKeys) and has no authorized_keys. Runs where sshd is installed (CI installs it on Linux).
 */
const SSHD = ['/usr/sbin/sshd', '/usr/local/sbin/sshd', '/opt/homebrew/sbin/sshd'].find((p) => existsSync(p));
const FIX = join(__dirname, '../../../../packages/key-formats/test/fixtures');
const user = userInfo().username;
const cb = (): ConnectCallbacks => ({
  status: () => undefined,
  verifyHostKey: async () => true,
  requestAuth: async () => null,
  authSucceeded: () => undefined,
  isCancelled: () => false,
});

let dir: string;
let sshd: ChildProcess | undefined;
let port: number;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

/** Signs `<key>.pub` for the current user with the test CA, as an administrator would. */
function certify(key: string): string {
  copyFileSync(join(FIX, `${key}.pub`), join(dir, `${key}.pub`));
  execFileSync('ssh-keygen', ['-q', '-s', join(dir, 'ca'), '-I', `${key}-openssh-test`, '-n', user, '-V', '-5m:+1h', join(dir, `${key}.pub`)]);
  return readFileSync(join(dir, `${key}-cert.pub`), 'utf8');
}

describe.skipIf(!SSHD || process.platform === 'win32')('SSH certificates against OpenSSH sshd', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'chh-sshd-'));
    copyFileSync(join(FIX, 'cert-ca'), join(dir, 'ca'));
    chmodSync(join(dir, 'ca'), 0o600);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'host')]);
    port = await freePort();
    writeFileSync(
      join(dir, 'sshd_config'),
      [
        `Port ${port}`,
        'ListenAddress 127.0.0.1',
        `HostKey ${join(dir, 'host')}`,
        `PidFile ${join(dir, 'sshd.pid')}`,
        `TrustedUserCAKeys ${join(FIX, 'cert-ca.pub')}`,
        'AuthorizedKeysFile none',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'PubkeyAuthentication yes',
        'UsePAM no',
        'StrictModes no',
        'LogLevel VERBOSE',
      ].join('\n') + '\n',
    );
    if (process.getuid?.() === 0) execFileSync('mkdir', ['-p', '/run/sshd']); // privilege separation directory
    sshd = spawn(SSHD!, ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sshd did not start')), 10_000);
      sshd!.stderr!.on('data', (d: Buffer) => {
        if (d.toString().includes('Server listening')) {
          clearTimeout(timer);
          resolve();
        }
      });
      sshd!.once('exit', (code) => reject(new Error(`sshd exited with ${code}`)));
    });
  });

  afterAll(() => {
    sshd?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.each(['openssh-ed25519', 'openssh-ecdsa256', 'openssh-rsa2048'])('logs in with a %s certificate', async (key) => {
    const client = await connectChain(
      sshConfig(port, { username: user, privateKey: readFileSync(join(FIX, key), 'utf8'), certificate: certify(key) }),
      cb(),
    );
    const out = await new Promise<string>((resolve) =>
      client.exec('echo cert-ok', (err, ch) => {
        if (err) return resolve(String(err));
        let s = '';
        ch.on('data', (d: Buffer) => (s += d)).on('close', () => resolve(s));
      }),
    );
    expect(out.trim()).toBe('cert-ok');
    client.end();
  });

  it('is refused without the certificate (the key alone is not authorized)', async () => {
    await expect(
      connectChain(sshConfig(port, { username: user, privateKey: readFileSync(join(FIX, 'openssh-ed25519'), 'utf8') }), cb()),
    ).rejects.toThrow();
  });
});
