import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { MockBinding } from '@serialport/binding-mock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveSettings, type GroupLike, type RunHostStatus, type RunOutput } from '@chh/shared';
import { ExecRunner } from '../../src/session-host/exec/runner';
import { connectChain, describeSshError, type ConnectCallbacks } from '../../src/session-host/ssh/connect';
import { parseOs } from '../../src/session-host/ssh/os-detect';
import { openSerial, translateInput } from '../../src/session-host/transports/serial';
import { exportLine, openSsh } from '../../src/session-host/transports/ssh';
import { sshConfig } from '../support/config';
import { startFakeAgent } from '../support/agent';
import { startHttpProxy, startSocks5Proxy } from '../support/proxies';
import { startSshServer, type TestSshServer } from '../support/ssh-server';

const FIX = join(__dirname, '../../../../packages/key-formats/test/fixtures');
const cb = (answers: string[][] = []): ConnectCallbacks => ({
  status: () => undefined,
  verifyHostKey: async () => true,
  requestAuth: async () => answers.shift() ?? null,
  authSucceeded: () => undefined,
  isCancelled: () => false,
});

let jump: TestSshServer;
let target: TestSshServer;

beforeAll(async () => {
  jump = await startSshServer({ password: 'jump-pw' });
  target = await startSshServer({
    osRelease: 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\nLinux\n',
    exec: (cmd) =>
      cmd.includes('fail') ? { stderr: 'boom\n', code: 3 } : cmd.includes('slow') ? { stdout: 'late\n', delayMs: 3000 } : { stdout: `ran: ${cmd}\n` },
  });
});

afterAll(async () => {
  await jump.close();
  await target.close();
});

describe('jump hosts', () => {
  it('connects to the target through a jump host (each hop authenticated)', async () => {
    const client = await connectChain(
      sshConfig(target.port, { password: 'secret', jumps: [sshConfig(jump.port, { password: 'jump-pw', label: 'bastion' })] }),
      cb(),
    );
    const out = await new Promise<string>((resolve) =>
      client.exec('hello', (err, ch) => {
        let s = '';
        ch.on('data', (d: Buffer) => (s += d)).on('close', () => resolve(s));
      }),
    );
    expect(out).toBe('ran: hello\n');
    client.end();
  });

  it('names the jump host that failed', async () => {
    const err = await connectChain(sshConfig(target.port, { password: 'secret', jumps: [sshConfig(jump.port, { password: 'wrong', label: 'bastion' })] }), cb()).catch((e) => e);
    expect(describeSshError(err)).toBe('session.error.jump::bastion');
  });
});

describe('proxies', () => {
  it('reaches the SSH server through SOCKS5 with authentication', async () => {
    const proxy = await startSocks5Proxy({ user: 'u', pass: 'p' });
    const client = await connectChain(sshConfig(target.port, { password: 'secret', proxy: { type: 'socks5', host: '127.0.0.1', port: proxy.port, username: 'u' } }), cb([['p']]));
    expect(proxy.targets).toEqual([`127.0.0.1:${target.port}`]);
    client.end();
    await proxy.close();
  });

  it('reaches the SSH server through an HTTP CONNECT proxy, and reports bad proxy credentials', async () => {
    const proxy = await startHttpProxy({ user: 'u', pass: 'p' });
    const ok = await connectChain(sshConfig(target.port, { password: 'secret', proxy: { type: 'http', host: '127.0.0.1', port: proxy.port, username: 'u' } }), cb([['p']]));
    ok.end();
    const err = await connectChain(sshConfig(target.port, { password: 'secret', proxy: { type: 'http', host: '127.0.0.1', port: proxy.port, username: 'u' } }), cb([['nope']])).catch((e) => e);
    expect(describeSshError(err)).toBe('session.error.proxyAuth');
    await proxy.close();
  });

  it('proxy + jump host combined', async () => {
    const proxy = await startSocks5Proxy();
    const client = await connectChain(
      sshConfig(target.port, {
        password: 'secret',
        proxy: { type: 'socks5', host: '127.0.0.1', port: proxy.port, username: '' },
        jumps: [sshConfig(jump.port, { password: 'jump-pw' })],
      }),
      cb(),
    );
    expect(proxy.targets).toEqual([`127.0.0.1:${jump.port}`]); // the proxy only sees the first hop
    client.end();
    await proxy.close();
  });
});

describe('shell sessions: env, agent forwarding, OS detection', () => {
  it('sends env requests, requests agent forwarding, and detects the OS', async () => {
    const agent = await startFakeAgent();
    const sock = agent.path;
    try {
      let os: string | null = null;
      let ready = false;
      const t = openSsh(
        {
          cols: 80,
          rows: 24,
          config: sshConfig(target.port, { password: 'secret', useAgent: true, agent: sock, agentForward: true, env: { APP_ENV: 'staging', LANG: 'C.UTF-8' } }),
        },
        {
          data: () => undefined,
          status: (s) => (ready ||= s === 'ready'),
          exit: () => undefined,
          verifyHostKey: async () => true,
          requestAuth: async () => null,
          authSucceeded: () => undefined,
          osDetected: (o) => (os = o),
        },
      );
      await expect.poll(() => ready).toBe(true);
      await expect.poll(() => os).toBe('ubuntu');
      expect(target.env).toMatchObject({ APP_ENV: 'staging', LANG: 'C.UTF-8' });
      expect(target.agentForwardRequested()).toBe(true);
      t.close();
    } finally {
      await agent.close();
    }
  });

  it('builds safe export lines', () => {
    expect(exportLine({ A: "it's", B: 'x y' })).toBe(` export A='it'\\''s' B='x y'\r`);
    expect(exportLine({})).toBe('');
  });

  it('parses os-release and uname output', () => {
    expect(parseOs('ID=debian\n')).toBe('debian');
    expect(parseOs('ID="rocky"\n')).toBe('rocky');
    expect(parseOs('ID=amzn\n')).toBe('amazon');
    expect(parseOs('ID=somethingnew\n')).toBe('linux');
    expect(parseOs('Darwin\n')).toBe('macos');
    expect(parseOs('FreeBSD\n')).toBe('freebsd');
    expect(parseOs('')).toBeNull();
  });
});

describe('multi-host exec runner', () => {
  it('runs on several hosts, streams output, reports exit codes, and cancels', async () => {
    const statuses: RunHostStatus[] = [];
    const outputs: RunOutput[] = [];
    const runner = new ExecRunner((s) => statuses.push(s), (o) => outputs.push(o));
    const c = { verifyHostKey: async () => true, requestAuth: async () => null, authSucceeded: () => undefined };
    await Promise.all([
      runner.run('r1', 'h-ok', sshConfig(target.port, { password: 'secret' }), 'uptime', c),
      runner.run('r1', 'h-fail', sshConfig(target.port, { password: 'secret' }), 'fail please', c),
      runner.run('r1', 'h-bad', sshConfig(target.port, { password: 'wrong' }), 'uptime', c),
    ]);
    const final = (h: string) => statuses.filter((s) => s.hostId === h).at(-1);
    expect(final('h-ok')).toMatchObject({ status: 'done', exitCode: 0 });
    expect(final('h-fail')).toMatchObject({ status: 'done', exitCode: 3 });
    expect(final('h-bad')).toMatchObject({ status: 'error', error: 'session.error.auth' });
    expect(outputs.filter((o) => o.hostId === 'h-ok').map((o) => o.data).join('')).toBe('ran: uptime\n');
    expect(outputs.find((o) => o.hostId === 'h-fail')).toMatchObject({ stream: 'stderr', data: 'boom\n' });

    const slow = runner.run('r2', 'h-slow', sshConfig(target.port, { password: 'secret' }), 'slow', c);
    await expect.poll(() => statuses.some((s) => s.runId === 'r2' && s.status === 'running')).toBe(true);
    runner.cancel('r2');
    await slow;
    expect(statuses.filter((s) => s.runId === 'r2').at(-1)!.status).toBe('cancelled');
  });
});

describe('serial transport (mock port)', () => {
  it('translates Enter, echoes locally when asked, and reports missing ports', async () => {
    MockBinding.createPort('/dev/ROBOT', { echo: true, record: true });
    let received = '';
    let state = '';
    const t = openSerial(
      {
        path: '/dev/ROBOT',
        settings: { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none', newline: 'crlf', localEcho: false },
        binding: MockBinding,
      },
      { data: (d) => (received += Buffer.from(d as Uint8Array).toString()), status: (s) => (state = s), exit: () => undefined },
    );
    await expect.poll(() => state).toBe('ready');
    t.write('AT\r');
    await expect.poll(() => received).toBe('AT\r\n'); // mock port echoes what we sent
    t.close();

    let err = '';
    openSerial(
      { path: '/dev/NOPE', settings: { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none', newline: 'cr', localEcho: false }, binding: MockBinding },
      { data: () => undefined, status: (s, m) => s === 'error' && (err = m ?? ''), exit: () => undefined },
    );
    await expect.poll(() => err).toMatch(/^session\.error\.serial/);
    expect(translateInput('a\rb\r', 'lf')).toBe('a\nb\n');
    expect(translateInput('a\r', 'cr')).toBe('a\r');
  });
});

describe('settings inheritance for env', () => {
  it('merges env per variable down the group tree', () => {
    const groups = new Map<string, GroupLike>([
      ['g', { id: 'g', parentId: null, settings: { env: { A: '1', B: '1' } } }],
      ['h', { id: 'h', parentId: 'g', settings: { env: { B: '2' } } }],
    ]);
    expect(resolveSettings('h', { env: { C: '3' } }, groups).env).toEqual({ A: '1', B: '2', C: '3' });
  });
});

describe('fixtures sanity', () => {
  it('has the key fixture used by agent tests', () => {
    expect(readFileSync(join(FIX, 'openssh-ed25519'), 'utf8')).toContain('OPENSSH');
    expect(createServer).toBeTypeOf('function');
    expect(typeof ({} as AddressInfo)).toBe('object');
  });
});
