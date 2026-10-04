import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ForwardStatus } from '@cy-ssh/shared';
import { ForwardManager, type ForwardRule } from '../../src/session-host/forwards/manager';
import type { SshConnectConfig } from '../../src/session-host/protocol';
import { sshConfig } from '../support/config';
import { startSshServer, type TestSshServer } from '../support/ssh-server';

let ssh: TestSshServer;
let echo: Server;
let echoPort: number;

const cb = { verifyHostKey: async () => true, requestAuth: async () => null, authSucceeded: () => undefined };
const config = (): SshConnectConfig => sshConfig(ssh.port, { password: 'secret' });

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

/** Sends `msg` (after an optional handshake) and resolves with the first echoed reply. */
function roundTrip(port: number, msg: string, handshake?: (sock: Socket) => Promise<void>): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', async () => {
      try {
        if (handshake) await handshake(sock);
        sock.once('data', (d) => {
          resolve(d.toString());
          sock.destroy();
        });
        sock.write(msg);
      } catch (e) {
        reject(e);
      }
    });
    sock.on('error', reject);
  });
}

function readN(sock: Socket, n: number): Promise<Buffer> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const on = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= n) {
        sock.removeListener('data', on);
        resolve(buf);
      }
    };
    sock.on('data', on);
  });
}

beforeAll(async () => {
  ssh = await startSshServer();
  echo = createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
  echoPort = (echo.address() as AddressInfo).port;
});

afterAll(async () => {
  await ssh.close();
  echo.close();
});

describe('ForwardManager', () => {
  it('local forward (-L) tunnels to the destination and counts traffic', async () => {
    const updates: ForwardStatus[] = [];
    const m = new ForwardManager((s) => updates.push(s));
    const port = await freePort();
    const rule: ForwardRule = { kind: 'local', bindHost: '127.0.0.1', bindPort: port, destHost: '127.0.0.1', destPort: echoPort };
    await m.start('f1', rule, config(), cb);
    expect(m.isRunning('f1')).toBe(true);
    expect(await roundTrip(port, 'ping')).toBe('ping');
    await expect.poll(() => m.statuses()[0]!.bytesIn).toBeGreaterThanOrEqual(4);
    m.stop('f1');
    expect(updates.at(-1)!.state).toBe('stopped');
    await expect(roundTrip(port, 'x')).rejects.toThrow();
  });

  it('dynamic forward speaks SOCKS5 and SOCKS4a', async () => {
    const m = new ForwardManager(() => undefined);
    const port = await freePort();
    await m.start('f2', { kind: 'dynamic', bindHost: '127.0.0.1', bindPort: port, destHost: null, destPort: null }, config(), cb);

    const socks5 = await roundTrip(port, 'five', async (s) => {
      s.write(Buffer.from([5, 1, 0]));
      expect([...(await readN(s, 2))]).toEqual([5, 0]);
      const host = Buffer.from('127.0.0.1');
      const p = Buffer.alloc(2);
      p.writeUInt16BE(echoPort);
      s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, p]));
      expect((await readN(s, 10))[1]).toBe(0);
    });
    expect(socks5).toBe('five');

    const socks4a = await roundTrip(port, 'four', async (s) => {
      const p = Buffer.alloc(2);
      p.writeUInt16BE(echoPort);
      s.write(Buffer.concat([Buffer.from([4, 1]), p, Buffer.from([0, 0, 0, 1]), Buffer.from('me\0localhost\0')]));
      expect((await readN(s, 8))[1]).toBe(0x5a);
    });
    expect(socks4a).toBe('four');
    m.stopAll();
  });

  it('remote forward (-R) brings server-side connections back here', async () => {
    const m = new ForwardManager(() => undefined);
    const port = await freePort();
    await m.start('f3', { kind: 'remote', bindHost: '127.0.0.1', bindPort: port, destHost: '127.0.0.1', destPort: echoPort }, config(), cb);
    // The test server listens on `port` on behalf of the "remote" side.
    expect(await roundTrip(port, 'back')).toBe('back');
    m.stopAll();
  });

  it('reports a busy local port', async () => {
    const m = new ForwardManager(() => undefined);
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()));
    const port = (busy.address() as AddressInfo).port;
    await expect(m.start('f4', { kind: 'local', bindHost: '127.0.0.1', bindPort: port, destHost: 'x', destPort: 1 }, config(), cb)).rejects.toThrow();
    expect(m.statuses()[0]).toMatchObject({ state: 'error', message: 'forwards.error.addrInUse' });
    busy.close();
  });
});
