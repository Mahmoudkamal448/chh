import { describe, expect, it } from 'vitest';
import { IAC, OPT, TelnetProtocol, openTelnet } from '../../src/session-host/transports/telnet';
import { startTelnetServer } from '../support/telnet-server';

const DO = 253;
const DONT = 254;
const WILL = 251;
const WONT = 252;
const SB = 250;
const SE = 240;

describe('TelnetProtocol', () => {
  const make = () => {
    const sent: number[][] = [];
    const p = new TelnetProtocol((b) => sent.push([...b]), { cols: 80, rows: 24 });
    return { p, sent };
  };

  it('strips negotiation from data and unescapes IAC IAC', () => {
    const { p } = make();
    expect([...p.feed(Buffer.from([104, IAC, IAC, 105, IAC, WILL, OPT.ECHO, 33]))]).toEqual([104, 255, 105, 33]);
  });

  it('handles sequences split across chunks', () => {
    const { p, sent } = make();
    expect([...p.feed(Buffer.from([65, IAC]))]).toEqual([65]);
    expect([...p.feed(Buffer.from([DO]))]).toEqual([]);
    expect([...p.feed(Buffer.from([OPT.NAWS, 66]))]).toEqual([66]);
    expect(sent[0]).toEqual([IAC, WILL, OPT.NAWS]);
    expect(sent[1]).toEqual([IAC, SB, OPT.NAWS, 0, 80, 0, 24, IAC, SE]);
  });

  it('refuses unknown options and does not loop on repeats', () => {
    const { p, sent } = make();
    p.feed(Buffer.from([IAC, DO, 99, IAC, WILL, 98]));
    expect(sent).toEqual([
      [IAC, WONT, 99],
      [IAC, DONT, 98],
    ]);
    p.feed(Buffer.from([IAC, WILL, OPT.ECHO, IAC, WILL, OPT.ECHO]));
    expect(sent.filter((x) => x[1] === DO && x[2] === OPT.ECHO)).toHaveLength(1);
  });

  it('answers TTYPE SEND and escapes NAWS values containing 255', () => {
    const { p, sent } = make();
    p.feed(Buffer.from([IAC, DO, OPT.TTYPE, IAC, SB, OPT.TTYPE, 1, IAC, SE]));
    expect(Buffer.from(sent[1]!.slice(4, -2)).toString()).toBe('XTERM-256COLOR');
    p.feed(Buffer.from([IAC, DO, OPT.NAWS]));
    p.resize(255, 40);
    expect(sent.at(-1)).toEqual([IAC, SB, OPT.NAWS, 0, 255, 255, 0, 40, IAC, SE]);
  });

  it('encodes input: IAC doubled, CR followed by NUL unless binary', () => {
    const { p } = make();
    expect([...p.encode('a\r')]).toEqual([97, 13, 0]);
    expect([...p.encode('\xff')]).toEqual([0xc3, 0xbf]); // UTF-8 encoded, no raw 0xFF
    p.feed(Buffer.from([IAC, DO, OPT.BINARY]));
    expect([...p.encode('a\r')]).toEqual([97, 13]);
  });
});

describe('openTelnet', () => {
  it('connects, negotiates window size and terminal type, and exchanges data', async () => {
    const server = await startTelnetServer();
    let out = '';
    const statuses: string[] = [];
    const t = openTelnet(
      { host: '127.0.0.1', port: server.port, cols: 120, rows: 40, connectTimeoutSec: 5 },
      { data: (d) => (out += Buffer.from(d as Uint8Array).toString('latin1')), status: (s) => statuses.push(s), exit: () => undefined },
    );
    await expect.poll(() => out).toContain('login:');
    await expect.poll(() => server.size()).toEqual({ cols: 120, rows: 40 });
    expect(server.terminalType()).toBe('XTERM-256COLOR');
    t.write('hello\r');
    await expect.poll(() => out).toContain('you typed: hello');
    t.resize(100, 30);
    await expect.poll(() => server.size()).toEqual({ cols: 100, rows: 30 });
    expect(statuses).toEqual(['connecting', 'ready']);
    t.close();
    await server.close();
  });

  it('reports connection refused', async () => {
    const statuses: Array<[string, string | undefined]> = [];
    let exited = false;
    openTelnet({ host: '127.0.0.1', port: 1, cols: 80, rows: 24, connectTimeoutSec: 5 }, { data: () => undefined, status: (s, m) => statuses.push([s, m]), exit: () => (exited = true) });
    await expect.poll(() => exited).toBe(true);
    expect(statuses.at(-1)).toEqual(['error', 'session.error.refused']);
  });
});
