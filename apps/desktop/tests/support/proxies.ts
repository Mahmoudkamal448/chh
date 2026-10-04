/** Minimal SOCKS5 and HTTP CONNECT proxies for tests (optional username/password). */
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';

export interface TestProxy {
  port: number;
  /** Targets requested through the proxy ("host:port"). */
  targets: string[];
  close(): Promise<void>;
}

function listen(server: Server, sockets: Set<Socket>): Promise<number> {
  server.on('connection', (s) => (sockets.add(s), s.on('close', () => sockets.delete(s))));
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
}

const closer = (server: Server, sockets: Set<Socket>) => () =>
  new Promise<void>((r) => {
    sockets.forEach((s) => s.destroy());
    server.close(() => r());
  });

export async function startSocks5Proxy(auth?: { user: string; pass: string }): Promise<TestProxy> {
  const targets: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((c) => {
    let stage = 0;
    c.on('data', function onData(d: Buffer) {
      if (stage === 0) {
        c.write(Buffer.from([5, auth ? 2 : 0]));
        stage = auth ? 1 : 2;
      } else if (stage === 1) {
        const ul = d[1]!;
        const user = d.subarray(2, 2 + ul).toString();
        const pass = d.subarray(3 + ul, 3 + ul + d[2 + ul]!).toString();
        const ok = user === auth!.user && pass === auth!.pass;
        c.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) return c.end();
        stage = 2;
      } else {
        const atyp = d[3];
        let host: string;
        let off: number;
        if (atyp === 1) {
          host = [...d.subarray(4, 8)].join('.');
          off = 8;
        } else {
          host = d.subarray(5, 5 + d[4]!).toString();
          off = 5 + d[4]!;
        }
        const port = d.readUInt16BE(off);
        targets.push(`${host}:${port}`);
        c.removeListener('data', onData);
        const up = connect(port, host, () => {
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          c.pipe(up).pipe(c);
        });
        up.on('error', () => c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
      }
    });
  });
  return { port: await listen(server, sockets), targets, close: closer(server, sockets) };
}

export async function startHttpProxy(auth?: { user: string; pass: string }): Promise<TestProxy> {
  const targets: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((c) => {
    let head = '';
    c.on('data', function onData(d: Buffer) {
      head += d.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      c.removeListener('data', onData);
      const [, target] = /^CONNECT (\S+) HTTP/.exec(head) ?? [];
      const expected = auth ? `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}` : null;
      if (expected && !head.includes(`Proxy-Authorization: ${expected}`)) return c.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      targets.push(target!);
      const [host, port] = target!.split(':');
      const up = connect(Number(port), host!, () => {
        c.write('HTTP/1.1 200 Connection established\r\n\r\n');
        c.pipe(up).pipe(c);
      });
      up.on('error', () => c.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    });
  });
  return { port: await listen(server, sockets), targets, close: closer(server, sockets) };
}
