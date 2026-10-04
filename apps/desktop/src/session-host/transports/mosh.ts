import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import * as pty from 'node-pty';
import type { Client } from 'ssh2';
import type { MoshClientSpec, SshConnectConfig } from '../protocol';
import { connectChain, describeSshError } from '../ssh/connect';
import type { SshCallbacks } from './ssh';
import type { Transport } from './types';

const CONNECT_RE = /MOSH CONNECT (\d+) ([A-Za-z0-9/+]{22})/;
const BOOTSTRAP_TIMEOUT_MS = 20_000;

/** Quotes a string for a POSIX shell. */
function sh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Starts mosh-server over SSH and returns the UDP port and session key it printed. */
export function bootstrapMoshServer(client: Client, moshServer: string, env: Record<string, string> = {}): Promise<{ port: number; key: string }> {
  const parts = moshServer.trim().split(/\s+/);
  // -l NAME=VALUE sets variables for the remote shell (mosh has no env requests).
  const vars = { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', ...env };
  const cmd = `${parts.map(sh).join(' ')} new -s -c 256 ${Object.entries(vars).map(([k, v]) => `-l ${sh(`${k}=${v}`)}`).join(' ')}`;
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(Object.assign(new Error('mosh-server did not start'), { code: 'MOSH_TIMEOUT' })), BOOTSTRAP_TIMEOUT_MS);
    client.exec(cmd, { pty: { term: 'xterm-256color', cols: 80, rows: 24, width: 0, height: 0, modes: {} } }, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        return reject(err);
      }
      const onData = (d: Buffer) => {
        out += d.toString('utf8');
        if (out.length > 64 * 1024) out = out.slice(-8192);
        const m = CONNECT_RE.exec(out);
        if (m) {
          clearTimeout(timer);
          resolve({ port: Number(m[1]), key: m[2]! });
        }
      };
      stream.on('data', onData);
      stream.stderr.on('data', onData);
      stream.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (CONNECT_RE.test(out)) return;
        if (code === 127 || /not found/i.test(out)) reject(Object.assign(new Error('mosh-server not installed'), { code: 'MOSH_SERVER_MISSING' }));
        else reject(Object.assign(new Error(out.trim().split('\n').pop() || 'mosh-server failed'), { code: 'MOSH_FAILED' }));
      });
    });
  });
}

export function describeMoshError(err: Error & { code?: string; level?: string }): string {
  if (err.code === 'MOSH_SERVER_MISSING') return 'session.error.moshServerMissing';
  if (err.code === 'MOSH_TIMEOUT') return 'session.error.moshTimeout';
  if (err.code === 'MOSH_FAILED') return `session.error.moshFailed::${err.message}`;
  return describeSshError(err);
}

/**
 * Mosh: authenticate over SSH, start mosh-server, then run the local mosh-client in a PTY with
 * MOSH_KEY. The SSH connection is closed once mosh-server is running.
 */
export function openMosh(
  opts: { cols: number; rows: number; config: SshConnectConfig; moshServer: string; client: MoshClientSpec },
  cb: SshCallbacks,
): Transport {
  let proc: pty.IPty | null = null;
  let closed = false;
  let exited = false;
  let cols = opts.cols;
  let rows = opts.rows;
  const finish = (code: number | null) => {
    if (exited) return;
    exited = true;
    cb.exit(code);
  };

  void (async () => {
    let client: Client | null = null;
    try {
      client = await connectChain(opts.config, { ...cb, status: (s) => cb.status(s), isCancelled: () => closed });
      const remote = (client as unknown as { _sock?: { remoteAddress?: string } })._sock?.remoteAddress;
      const { port, key } = await bootstrapMoshServer(client, opts.moshServer, opts.config.env);
      client.end();
      client = null;
      if (closed) return;
      // mosh-client needs an IP address, not a name.
      const ip = remote && isIP(remote.replace(/^::ffff:/, '')) ? remote.replace(/^::ffff:/, '') : (await lookup(opts.config.host)).address;
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ELECTRON_')) env[k] = v;
      Object.assign(env, opts.client.env, { MOSH_KEY: key, TERM: 'xterm-256color', MOSH_PREDICTION_DISPLAY: 'adaptive' });
      if (!/utf-?8/i.test(env.LC_ALL ?? env.LANG ?? '')) env.LANG = 'C.UTF-8';
      proc = pty.spawn(opts.client.path, [...opts.client.args, ip, String(port)], { name: 'xterm-256color', cols, rows, env });
      cb.status('ready');
      proc.onData((d) => cb.data(d));
      proc.onExit(({ exitCode }) => finish(exitCode));
    } catch (err) {
      client?.end();
      if (!closed) cb.status('error', describeMoshError(err as Error));
      finish(null);
    }
  })();

  return {
    write: (d) => proc?.write(d),
    resize: (c, r) => {
      cols = c;
      rows = r;
      proc?.resize(c, r);
    },
    pause: () => proc?.pause(),
    resume: () => proc?.resume(),
    close: () => {
      if (closed) return;
      closed = true;
      try {
        proc?.kill();
      } catch {
        // already gone
      }
    },
  };
}
