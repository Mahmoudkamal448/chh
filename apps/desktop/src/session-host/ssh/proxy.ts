import { connect, isIPv4, type Socket } from 'node:net';
import type { ProxyConfig } from '@cy-ssh/shared';

export class ProxyError extends Error {
  constructor(
    /** i18n key suffix under session.error.proxy* */
    readonly code: 'proxyAuth' | 'proxyRefused' | 'proxyFailed',
    message: string,
  ) {
    super(message);
  }
}

function read(sock: Socket, n: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new ProxyError('proxyFailed', 'proxy timeout')), timeoutMs);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= n) {
        // Detach and pause BEFORE pushing back surplus bytes, or they'd be re-delivered to us.
        done(null, buf.subarray(0, n));
        const extra = buf.subarray(n);
        if (extra.length) sock.unshift(extra);
      }
    };
    const onEnd = () => done(new ProxyError('proxyFailed', 'proxy closed the connection'));
    let finished = false;
    const done = (err: Error | null, v?: Buffer) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('end', onEnd);
      sock.removeListener('error', onErr);
      sock.pause();
      if (err) reject(err);
      else resolve(v!);
    };
    const onErr = (e: Error) => done(e);
    sock.on('data', onData);
    sock.once('end', onEnd);
    sock.once('error', onErr);
    sock.resume();
  });
}

async function socks5(sock: Socket, host: string, port: number, user: string, password: string | null, t: number): Promise<void> {
  const auth = user ? [0x00, 0x02] : [0x00];
  sock.write(Buffer.from([5, auth.length, ...auth]));
  const [ver, method] = await read(sock, 2, t);
  if (ver !== 5) throw new ProxyError('proxyFailed', 'not a SOCKS5 proxy');
  if (method === 0x02) {
    const u = Buffer.from(user);
    const p = Buffer.from(password ?? '');
    sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    const [, status] = await read(sock, 2, t);
    if (status !== 0) throw new ProxyError('proxyAuth', 'SOCKS5 authentication failed');
  } else if (method !== 0x00) throw new ProxyError('proxyAuth', 'SOCKS5 proxy requires an unsupported authentication method');
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  const addr = isIPv4(host) ? Buffer.from([1, ...host.split('.').map(Number)]) : Buffer.concat([Buffer.from([3, Buffer.byteLength(host)]), Buffer.from(host)]);
  sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, p]));
  const head = await read(sock, 4, t);
  if (head[1] !== 0) throw new ProxyError('proxyRefused', `SOCKS5 error ${head[1]}`);
  // Skip the bound address in the reply.
  const len = head[3] === 1 ? 4 : head[3] === 4 ? 16 : (await read(sock, 1, t))[0]!;
  await read(sock, len + 2, t);
}

async function socks4(sock: Socket, host: string, port: number, user: string, t: number): Promise<void> {
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  // SOCKS4a: 0.0.0.1 + hostname lets the proxy resolve names.
  const ip = isIPv4(host) ? Buffer.from(host.split('.').map(Number)) : Buffer.from([0, 0, 0, 1]);
  const tail = isIPv4(host) ? Buffer.alloc(0) : Buffer.concat([Buffer.from(host), Buffer.from([0])]);
  sock.write(Buffer.concat([Buffer.from([4, 1]), p, ip, Buffer.from(user), Buffer.from([0]), tail]));
  const reply = await read(sock, 8, t);
  if (reply[1] !== 0x5a) throw new ProxyError('proxyRefused', `SOCKS4 error ${reply[1]}`);
}

async function httpConnect(sock: Socket, host: string, port: number, user: string, password: string | null, t: number): Promise<void> {
  const target = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  const headers = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
  if (user) headers.push(`Proxy-Authorization: Basic ${Buffer.from(`${user}:${password ?? ''}`).toString('base64')}`);
  sock.write(`${headers.join('\r\n')}\r\n\r\n`);
  let head = '';
  while (!head.includes('\r\n\r\n')) {
    head += (await read(sock, 1, t)).toString('latin1');
    if (head.length > 16 * 1024) throw new ProxyError('proxyFailed', 'proxy response too large');
  }
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
  if (status === 407) throw new ProxyError('proxyAuth', 'proxy authentication required');
  if (status < 200 || status >= 300) throw new ProxyError('proxyRefused', `proxy answered HTTP ${status}`);
}

/** Opens a TCP tunnel to host:port through a SOCKS4a/5 or HTTP CONNECT proxy. */
export async function connectViaProxy(proxy: ProxyConfig, password: string | null, host: string, port: number, timeoutMs: number): Promise<Socket> {
  const sock = connect(proxy.port, proxy.host);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('proxy connect timeout'), { code: 'ETIMEDOUT' })), timeoutMs);
    sock.once('connect', () => (clearTimeout(timer), resolve()));
    sock.once('error', (e) => (clearTimeout(timer), reject(e)));
  });
  try {
    if (proxy.type === 'socks5') await socks5(sock, host, port, proxy.username, password, timeoutMs);
    else if (proxy.type === 'socks4') await socks4(sock, host, port, proxy.username, timeoutMs);
    else await httpConnect(sock, host, port, proxy.username, password, timeoutMs);
  } catch (e) {
    sock.destroy();
    throw e;
  }
  return sock;
}
