import { Socket } from 'node:net';
import { describeSshError } from '../ssh/connect';
import type { Transport, TransportEvents } from './types';

// RFC 854/855 command bytes and the options we implement.
export const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;
export const OPT = { BINARY: 0, ECHO: 1, SGA: 3, TTYPE: 24, NAWS: 31 } as const;
const TTYPE_IS = 0;
const TTYPE_SEND = 1;
const TERMINAL_TYPE = 'XTERM-256COLOR';

/** Options we're willing to enable on our side (we WILL) and on the server's side (they WILL). */
const OUR_OPTIONS = new Set<number>([OPT.BINARY, OPT.SGA, OPT.TTYPE, OPT.NAWS]);
const THEIR_OPTIONS = new Set<number>([OPT.BINARY, OPT.ECHO, OPT.SGA]);

/**
 * Telnet protocol state machine, independent of the socket so it can be unit-tested.
 * `feed()` takes raw bytes from the server and returns terminal data; replies go to `send`.
 */
export class TelnetProtocol {
  private state: 'data' | 'iac' | 'cmd' | 'sb' | 'sb-iac' = 'data';
  private cmd = 0;
  private sb: number[] = [];
  /** Options currently enabled on our side / on the server's side. */
  readonly us = new Set<number>();
  readonly them = new Set<number>();
  private cols: number;
  private rows: number;

  constructor(
    private readonly send: (b: Buffer) => void,
    size: { cols: number; rows: number },
  ) {
    this.cols = size.cols;
    this.rows = size.rows;
  }

  /** Proactively offer what nearly every server wants, as common clients do. */
  start(): void {
    this.send(Buffer.from([IAC, WILL, OPT.NAWS, IAC, WILL, OPT.TTYPE, IAC, DO, OPT.SGA, IAC, DO, OPT.ECHO]));
    this.us.add(OPT.NAWS).add(OPT.TTYPE);
    this.them.add(OPT.SGA).add(OPT.ECHO);
  }

  feed(chunk: Buffer): Buffer {
    const out: number[] = [];
    for (const b of chunk) {
      switch (this.state) {
        case 'data':
          if (b === IAC) this.state = 'iac';
          else out.push(b);
          break;
        case 'iac':
          if (b === IAC) {
            out.push(IAC); // escaped 0xFF data byte
            this.state = 'data';
          } else if (b === DO || b === DONT || b === WILL || b === WONT) {
            this.cmd = b;
            this.state = 'cmd';
          } else if (b === SB) {
            this.sb = [];
            this.state = 'sb';
          } else this.state = 'data'; // NOP, GA, etc.
          break;
        case 'cmd':
          this.negotiate(this.cmd, b);
          this.state = 'data';
          break;
        case 'sb':
          if (b === IAC) this.state = 'sb-iac';
          else if (this.sb.length < 1024) this.sb.push(b);
          break;
        case 'sb-iac':
          if (b === SE) {
            this.subnegotiation(this.sb);
            this.state = 'data';
          } else {
            if (b === IAC) this.sb.push(IAC);
            this.state = 'sb';
          }
          break;
      }
    }
    return Buffer.from(out);
  }

  /** Encodes user input: escapes 0xFF and sends CR as CR NUL unless binary mode is on. */
  encode(data: string): Buffer {
    const raw = Buffer.from(data, 'utf8');
    const out: number[] = [];
    for (const b of raw) {
      if (b === IAC) out.push(IAC, IAC);
      else if (b === 13 && !this.us.has(OPT.BINARY)) out.push(13, 0);
      else out.push(b);
    }
    return Buffer.from(out);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.us.has(OPT.NAWS)) this.sendNaws();
  }

  private sendNaws(): void {
    const body = Buffer.alloc(4);
    body.writeUInt16BE(Math.min(this.cols, 65535), 0);
    body.writeUInt16BE(Math.min(this.rows, 65535), 2);
    const esc: number[] = [];
    for (const b of body) esc.push(...(b === IAC ? [IAC, IAC] : [b]));
    this.send(Buffer.from([IAC, SB, OPT.NAWS, ...esc, IAC, SE]));
  }

  /** Minimal RFC 1143-style negotiation: only reply when the state actually changes (no loops). */
  private negotiate(cmd: number, opt: number): void {
    switch (cmd) {
      case DO:
        if (OUR_OPTIONS.has(opt)) {
          if (!this.us.has(opt)) {
            this.us.add(opt);
            this.send(Buffer.from([IAC, WILL, opt]));
          }
          if (opt === OPT.NAWS) this.sendNaws();
        } else this.send(Buffer.from([IAC, WONT, opt]));
        break;
      case DONT:
        if (this.us.delete(opt)) this.send(Buffer.from([IAC, WONT, opt]));
        break;
      case WILL:
        if (THEIR_OPTIONS.has(opt)) {
          if (!this.them.has(opt)) {
            this.them.add(opt);
            this.send(Buffer.from([IAC, DO, opt]));
          }
        } else this.send(Buffer.from([IAC, DONT, opt]));
        break;
      case WONT:
        if (this.them.delete(opt)) this.send(Buffer.from([IAC, DONT, opt]));
        break;
    }
  }

  private subnegotiation(sb: number[]): void {
    if (sb[0] === OPT.TTYPE && sb[1] === TTYPE_SEND) {
      this.send(Buffer.concat([Buffer.from([IAC, SB, OPT.TTYPE, TTYPE_IS]), Buffer.from(TERMINAL_TYPE, 'ascii'), Buffer.from([IAC, SE])]));
    }
  }
}

export function openTelnet(opts: { host: string; port: number; cols: number; rows: number; connectTimeoutSec: number }, ev: TransportEvents): Transport {
  const sock = new Socket();
  let closed = false;
  let exited = false;
  const finish = (code: number | null) => {
    if (exited) return;
    exited = true;
    ev.exit(code);
  };
  const proto = new TelnetProtocol((b) => !sock.destroyed && sock.write(b), { cols: opts.cols, rows: opts.rows });

  ev.status('connecting');
  sock.setTimeout(opts.connectTimeoutSec * 1000);
  sock.once('timeout', () => sock.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
  sock.connect(opts.port, opts.host, () => {
    sock.setTimeout(0);
    sock.setNoDelay(true);
    ev.status('ready');
    proto.start();
  });
  sock.on('data', (chunk: Buffer) => {
    const data = proto.feed(chunk);
    if (data.length) ev.data(new Uint8Array(data));
  });
  sock.on('error', (err) => {
    if (!closed) ev.status('error', describeSshError(err));
    finish(null);
  });
  sock.on('close', () => finish(null));

  return {
    write: (d) => !sock.destroyed && sock.write(proto.encode(d)),
    resize: (c, r) => proto.resize(c, r),
    pause: () => sock.pause(),
    resume: () => sock.resume(),
    close: () => {
      closed = true;
      sock.destroy();
    },
  };
}
