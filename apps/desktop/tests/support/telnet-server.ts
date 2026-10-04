/** Minimal Telnet server for tests: negotiates NAWS/TTYPE/ECHO/SGA and echoes lines. */
import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

const IAC = 255;
const DO = 253;
const WILL = 251;
const SB = 250;
const SE = 240;
const NAWS = 31;
const TTYPE = 24;

export interface TestTelnetServer {
  port: number;
  /** Last window size the client reported via NAWS. */
  size(): { cols: number; rows: number } | null;
  terminalType(): string | null;
  close(): Promise<void>;
}

export async function startTelnetServer(): Promise<TestTelnetServer> {
  let size: { cols: number; rows: number } | null = null;
  let ttype: string | null = null;
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.write(Buffer.from([IAC, DO, NAWS, IAC, DO, TTYPE, IAC, WILL, 1, IAC, WILL, 3]));
    sock.write(Buffer.from([IAC, SB, TTYPE, 1, IAC, SE]));
    sock.write('Welcome to cy-telnet\r\nlogin: ');
    let buf = Buffer.alloc(0);
    let line = '';
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const i = buf.indexOf(IAC);
        const chunk = i < 0 ? buf : buf.subarray(0, i);
        for (const b of chunk) {
          if (b === 13 || b === 10) {
            if (b === 13) {
              sock.write('\r\n');
              if (line) sock.write(`you typed: ${line}\r\n$ `);
              line = '';
            }
          } else if (b !== 0) {
            line += String.fromCharCode(b);
            sock.write(Buffer.from([b]));
          }
        }
        if (i < 0) {
          buf = Buffer.alloc(0);
          break;
        }
        buf = buf.subarray(i);
        if (buf.length < 3) break;
        if (buf[1] === SB) {
          const end = buf.indexOf(SE);
          if (end < 0) break;
          const sb = buf.subarray(2, end - 1);
          if (sb[0] === NAWS) size = { cols: sb.readUInt16BE(1), rows: sb.readUInt16BE(3) };
          if (sb[0] === TTYPE && sb[1] === 0) ttype = sb.subarray(2).toString('ascii');
          buf = buf.subarray(end + 1);
        } else if (buf[1] === IAC) {
          line += '\xff';
          buf = buf.subarray(2);
        } else buf = buf.subarray(3);
      }
    });
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  return {
    port: (server.address() as AddressInfo).port,
    size: () => size,
    terminalType: () => ttype,
    close: () =>
      new Promise((res) => {
        sockets.forEach((s) => s.destroy());
        server.close(() => res());
      }),
  };
}
