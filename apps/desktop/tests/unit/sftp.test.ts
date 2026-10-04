import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Transfer } from '@cy-ssh/shared';
import { generateKey, publicKeyLine, writeOpenSshPrivate } from '@cy-ssh/key-formats';
import { LocalFs } from '../../src/session-host/files/local-fs';
import type { FsProvider } from '../../src/session-host/files/provider';
import { SftpFs } from '../../src/session-host/files/sftp-fs';
import { TransferManager } from '../../src/session-host/files/transfers';
import type { SshConnectConfig } from '../../src/session-host/protocol';
import { connectSsh, type ConnectCallbacks } from '../../src/session-host/ssh/connect';
import { sshConfig } from '../support/config';
import { startSshServer, type TestSshServer } from '../support/ssh-server';

const key = generateKey({ algorithm: 'ed25519' }, 'test');
let server: TestSshServer;
let remoteRoot: string;
let localRoot: string;
let sftp: SftpFs;
const local = new LocalFs();

const callbacks = (answers: string[][] = []): ConnectCallbacks => ({
  status: () => undefined,
  verifyHostKey: async () => true,
  requestAuth: async () => answers.shift() ?? null,
  authSucceeded: () => undefined,
  isCancelled: () => false,
});

const config = (over: Partial<SshConnectConfig> = {}): SshConnectConfig => sshConfig(server.port, over);

beforeAll(async () => {
  remoteRoot = mkdtempSync(join(tmpdir(), 'cy-remote-'));
  server = await startSshServer({ sftpRoot: remoteRoot, authorizedKeys: [publicKeyLine(key)] });
});

afterAll(async () => {
  sftp?.close();
  await server.close();
  rmSync(remoteRoot, { recursive: true, force: true });
});

beforeEach(() => {
  localRoot = mkdtempSync(join(tmpdir(), 'cy-local-'));
});

describe('connectSsh auth', () => {
  it('authenticates with a vault key (no prompts)', async () => {
    const prompts: string[] = [];
    const client = await connectSsh(config({ privateKey: writeOpenSshPrivate(key) }), {
      ...callbacks(),
      requestAuth: async (r) => {
        prompts.push(r.kind);
        return null;
      },
    });
    expect(prompts).toEqual([]);
    client.end();
  });

  it('falls back to a password prompt and reports retries', async () => {
    const seen: boolean[] = [];
    let remembered: string | null = null;
    const answers = [['wrong'], ['secret']];
    const client = await connectSsh(config(), {
      ...callbacks(),
      requestAuth: async (r) => {
        seen.push(r.retry);
        return answers.shift() ?? null;
      },
      authSucceeded: (p) => (remembered = p),
    });
    expect(seen).toEqual([false, true]);
    expect(remembered).toBe('secret');
    client.end();
  });

  it('fails cleanly when the user cancels', async () => {
    await expect(connectSsh(config(), callbacks([]))).rejects.toMatchObject({ level: 'client-authentication' });
  });
});

describe('SftpFs + TransferManager', () => {
  beforeAll(async () => {
    sftp = await SftpFs.open(await connectSsh(config({ password: 'secret' }), callbacks()));
  });

  const run = (src: FsProvider, srcPaths: string[], dst: FsProvider, dir: string, conflict: 'overwrite' | 'skip' | 'rename' = 'overwrite') =>
    new Promise<Transfer[]>((resolve) => {
      const providers = new Map<string, FsProvider>([
        ['src', src],
        ['dst', dst],
      ]);
      const final = new Map<string, Transfer>();
      let ids: string[] = [];
      const mgr = new TransferManager(
        (e) => providers.get(e)!,
        (t) => {
          if (['done', 'error', 'cancelled'].includes(t.state)) final.set(t.id, t);
          if (ids.length && ids.every((id) => final.has(id))) resolve(ids.map((id) => final.get(id)!));
        },
      );
      ids = mgr.start({ src: { endpoint: 'src', paths: srcPaths }, dst: { endpoint: 'dst', dir }, conflict });
    });

  it('lists, creates, renames, chmods and deletes remotely', async () => {
    await sftp.mkdir('/ops');
    writeFileSync(join(remoteRoot, 'ops', 'a.txt'), 'hello');
    const listing = await sftp.list('/ops');
    expect(listing.path).toBe('/ops');
    expect(listing.parent).toBe('/');
    expect(listing.entries.map((e) => [e.name, e.type, e.size])).toEqual([['a.txt', 'file', 5]]);
    await sftp.rename('/ops/a.txt', '/ops/b.txt');
    await sftp.chmod('/ops/b.txt', 0o600);
    expect(statSync(join(remoteRoot, 'ops', 'b.txt')).mode & 0o777).toBe(0o600);
    await sftp.remove('/ops');
    expect(await sftp.stat('/ops')).toBeNull();
    await expect(sftp.list('/missing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('uploads a directory tree and downloads it back intact', async () => {
    mkdirSync(join(localRoot, 'site', 'css'), { recursive: true });
    writeFileSync(join(localRoot, 'site', 'index.html'), '<h1>hi</h1>');
    const big = Buffer.alloc(3 * 1024 * 1024 + 7, 7);
    writeFileSync(join(localRoot, 'site', 'css', 'big.bin'), big);

    const [up] = await run(local, [join(localRoot, 'site')], sftp, '/');
    expect(up).toMatchObject({ state: 'done', files: 2, doneFiles: 2, totalBytes: big.length + 11, doneBytes: big.length + 11 });
    expect(readFileSync(join(remoteRoot, 'site', 'css', 'big.bin')).equals(big)).toBe(true);

    const back = join(localRoot, 'back');
    mkdirSync(back);
    const [down] = await run(sftp, ['/site'], local, back);
    expect(down!.state).toBe('done');
    expect(readFileSync(join(back, 'site', 'index.html'), 'utf8')).toBe('<h1>hi</h1>');
    expect(readFileSync(join(back, 'site', 'css', 'big.bin')).equals(big)).toBe(true);
  });

  it('applies conflict policies', async () => {
    writeFileSync(join(remoteRoot, 'c.txt'), 'remote');
    writeFileSync(join(localRoot, 'c.txt'), 'local');
    await run(local, [join(localRoot, 'c.txt')], sftp, '/', 'skip');
    expect(readFileSync(join(remoteRoot, 'c.txt'), 'utf8')).toBe('remote');
    const [renamed] = await run(local, [join(localRoot, 'c.txt')], sftp, '/', 'rename');
    expect(renamed!.dst.path).toBe('/c (1).txt');
    expect(readFileSync(join(remoteRoot, 'c (1).txt'), 'utf8')).toBe('local');
    await run(local, [join(localRoot, 'c.txt')], sftp, '/', 'overwrite');
    expect(readFileSync(join(remoteRoot, 'c.txt'), 'utf8')).toBe('local');
  });

  it('refuses to copy a folder into itself and reports missing sources', async () => {
    mkdirSync(join(localRoot, 'loop'));
    const [loop] = await run(local, [join(localRoot, 'loop')], local, join(localRoot, 'loop'));
    expect(loop!.state).toBe('error');
    const [missing] = await run(sftp, ['/does-not-exist'], local, localRoot);
    expect(missing).toMatchObject({ state: 'error' });
    expect(missing!.error).toMatch(/^files\.error\.not_found/);
  });
});
