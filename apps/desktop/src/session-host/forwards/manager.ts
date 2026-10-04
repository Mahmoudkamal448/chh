import { createServer, connect, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Client } from 'ssh2';
import type { ForwardStatus } from '@chh/shared';
import type { SshConnectConfig } from '../protocol';
import { connectChain, describeSshError, type ConnectCallbacks } from '../ssh/connect';

export interface ForwardRule {
  kind: 'local' | 'remote' | 'dynamic';
  bindHost: string;
  bindPort: number;
  destHost: string | null;
  destPort: number | null;
}

interface Running {
  id: string;
  rule: ForwardRule;
  client: Client | null;
  server: Server | null;
  sockets: Set<Socket | Duplex>;
  status: ForwardStatus;
  stopped: boolean;
}

/** Pipes two streams together, counting bytes in each direction. */
function splice(local: Socket, remote: Duplex, r: Running, emit: () => void): void {
  r.sockets.add(local).add(remote);
  r.status.connections += 1;
  emit();
  local.on('data', (d: Buffer) => (r.status.bytesOut += d.length));
  remote.on('data', (d: Buffer) => (r.status.bytesIn += d.length));
  local.pipe(remote).pipe(local);
  const done = () => {
    if (!r.sockets.delete(local)) return;
    r.sockets.delete(remote);
    local.destroy();
    remote.destroy();
    r.status.connections = Math.max(0, r.status.connections - 1);
    emit();
  };
  local.on('close', done).on('error', done);
  remote.on('close', done).on('error', done);
}

/** Reads exactly `n` bytes from a socket (SOCKS handshake helper). */
function reader(sock: Socket) {
  let buf = Buffer.alloc(0);
  const waiters: Array<() => void> = [];
  sock.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    waiters.splice(0).forEach((w) => w());
  });
  const read = async (n: number): Promise<Buffer> => {
    while (buf.length < n) {
      if (sock.destroyed) throw new Error('closed');
      await new Promise<void>((res) => waiters.push(res));
    }
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    return out;
  };
  const readUntilNul = async (max = 512): Promise<Buffer> => {
    for (;;) {
      const i = buf.indexOf(0);
      if (i >= 0) {
        const out = buf.subarray(0, i);
        buf = buf.subarray(i + 1);
        return out;
      }
      if (buf.length > max || sock.destroyed) throw new Error('bad request');
      await new Promise<void>((res) => waiters.push(res));
    }
  };
  /** Bytes received after the handshake (forwarded once the tunnel is open). */
  const rest = () => {
    sock.removeAllListeners('data');
    return buf;
  };
  return { read, readUntilNul, rest };
}

/** SOCKS4/4a/5 (CONNECT only, no auth) handshake. Returns the requested target. */
export async function socksHandshake(sock: Socket): Promise<{ host: string; port: number; reply(ok: boolean): void; rest(): Buffer }> {
  const r = reader(sock);
  const [ver] = await r.read(1);
  if (ver === 5) {
    const [nMethods] = await r.read(1);
    const methods = await r.read(nMethods!);
    if (!methods.includes(0)) {
      sock.end(Buffer.from([5, 0xff]));
      throw new Error('no acceptable auth method');
    }
    sock.write(Buffer.from([5, 0]));
    const [, cmd, , atyp] = await r.read(4);
    let host: string;
    if (atyp === 1) host = [...(await r.read(4))].join('.');
    else if (atyp === 3) host = (await r.read((await r.read(1))[0]!)).toString('utf8');
    else if (atyp === 4) host = ((await r.read(16)).toString('hex').match(/.{4}/g) ?? []).join(':');
    else throw new Error('bad address type');
    const port = (await r.read(2)).readUInt16BE(0);
    if (cmd !== 1) {
      sock.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); // command not supported
      throw new Error('only CONNECT is supported');
    }
    return { host, port, reply: (ok) => sock.write(Buffer.from([5, ok ? 0 : 5, 0, 1, 0, 0, 0, 0, 0, 0])), rest: r.rest };
  }
  if (ver === 4) {
    const head = await r.read(7);
    const cmd = head[0];
    const port = head.readUInt16BE(1);
    const ip = [...head.subarray(3, 7)];
    await r.readUntilNul(); // user id
    // SOCKS4a: 0.0.0.x with x != 0 means a host name follows.
    const host = ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] !== 0 ? (await r.readUntilNul()).toString('utf8') : ip.join('.');
    if (cmd !== 1) {
      sock.end(Buffer.from([0, 0x5b, 0, 0, 0, 0, 0, 0]));
      throw new Error('only CONNECT is supported');
    }
    return { host, port, reply: (ok) => sock.write(Buffer.from([0, ok ? 0x5a : 0x5b, 0, 0, 0, 0, 0, 0])), rest: r.rest };
  }
  throw new Error('not a SOCKS request');
}

function listenError(err: Error & { code?: string }): string {
  if (err.code === 'EADDRINUSE') return 'forwards.error.addrInUse';
  if (err.code === 'EACCES') return 'forwards.error.addrDenied';
  if (err.code === 'EADDRNOTAVAIL') return 'forwards.error.addrNotAvail';
  return `forwards.error.generic::${err.message}`;
}

/**
 * Runs port-forwarding rules. Each rule gets its own SSH connection so starting/stopping one never
 * affects terminals or other rules.
 */
export class ForwardManager {
  private readonly running = new Map<string, Running>();

  constructor(private readonly emit: (s: ForwardStatus) => void) {}

  statuses(): ForwardStatus[] {
    return [...this.running.values()].map((r) => ({ ...r.status }));
  }

  isRunning(id: string): boolean {
    const s = this.running.get(id)?.status.state;
    return s === 'running' || s === 'starting';
  }

  async start(id: string, rule: ForwardRule, config: SshConnectConfig, cb: Omit<ConnectCallbacks, 'status' | 'isCancelled'>): Promise<void> {
    if (this.isRunning(id)) return;
    const r: Running = {
      id,
      rule,
      client: null,
      server: null,
      sockets: new Set(),
      stopped: false,
      status: { id, state: 'starting', connections: 0, bytesIn: 0, bytesOut: 0 },
    };
    this.running.set(id, r);
    const emit = () => this.emit({ ...r.status });
    emit();
    try {
      const client = await connectChain(config, { ...cb, status: () => undefined, isCancelled: () => r.stopped });
      r.client = client;
      if (r.stopped) {
        client.end();
        return;
      }
      client.on('close', () => !r.stopped && this.fail(r, 'forwards.error.disconnected'));
      client.on('error', (err) => !r.stopped && this.fail(r, describeSshError(err)));
      if (rule.kind === 'remote') await this.startRemote(r, client, emit);
      else await this.startLocal(r, client, emit);
      r.status.state = 'running';
      r.status.message = undefined;
      emit();
    } catch (err) {
      this.fail(r, describeOrListen(err as Error & { code?: string }));
      throw err;
    }
  }

  stop(id: string): void {
    const r = this.running.get(id);
    if (!r) return;
    r.stopped = true;
    this.teardown(r);
    r.status = { ...r.status, state: 'stopped', connections: 0, message: undefined };
    this.emit({ ...r.status });
    this.running.delete(id);
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id);
  }

  private fail(r: Running, message: string): void {
    if (r.status.state === 'error') return;
    this.teardown(r);
    r.status = { ...r.status, state: 'error', connections: 0, message };
    this.emit({ ...r.status });
  }

  private teardown(r: Running): void {
    r.server?.close();
    r.server = null;
    for (const s of r.sockets) s.destroy();
    r.sockets.clear();
    r.client?.end();
    r.client = null;
  }

  /** Local (-L) and dynamic (-D): listen here, tunnel each connection through the server. */
  private startLocal(r: Running, client: Client, emit: () => void): Promise<void> {
    const { rule } = r;
    const server = createServer((sock) => {
      sock.on('error', () => sock.destroy());
      if (rule.kind === 'local') {
        sock.pause();
        client.forwardOut(sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, rule.destHost!, rule.destPort!, (err, ch) => {
          if (err || r.stopped) return sock.destroy();
          splice(sock, ch, r, emit);
          sock.resume();
        });
        return;
      }
      socksHandshake(sock).then(
        (req) => {
          client.forwardOut(sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, req.host, req.port, (err, ch) => {
            if (err || r.stopped) {
              req.reply(false);
              return sock.end();
            }
            req.reply(true);
            const early = req.rest();
            if (early.length) ch.write(early);
            splice(sock, ch, r, emit);
          });
        },
        () => sock.destroy(),
      );
    });
    r.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(rule.bindPort, rule.bindHost, () => {
        server.removeListener('error', reject);
        server.on('error', (err) => this.fail(r, listenError(err)));
        resolve();
      });
    });
  }

  /** Remote (-R): the server listens and sends connections back to us; we connect to the target. */
  private startRemote(r: Running, client: Client, emit: () => void): Promise<void> {
    const { rule } = r;
    client.on('tcp connection', (info, accept, reject) => {
      if (info.destPort !== rule.bindPort) return reject();
      const ch = accept();
      const sock = connect(rule.destPort!, rule.destHost!);
      sock.on('connect', () => splice(sock, ch, r, emit));
      sock.on('error', () => ch.destroy());
    });
    return new Promise((resolve, reject) => {
      client.forwardIn(rule.bindHost, rule.bindPort, (err) =>
        err ? reject(Object.assign(err, { code: 'REMOTE_REFUSED' })) : resolve(),
      );
    });
  }
}

/** Error key for a failed start: listen problems, remote refusal, or SSH errors. */
function describeOrListen(e: Error & { code?: string }): string {
  if (e.code === 'REMOTE_REFUSED') return 'forwards.error.remoteRefused';
  if (e.code && String(e.code).startsWith('EADDR')) return listenError(e);
  if (e.code === 'EACCES') return 'forwards.error.addrDenied';
  return describeSshError(e);
}

