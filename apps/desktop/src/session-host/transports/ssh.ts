import type { Client, ClientChannel } from 'ssh2';
import type { SshConnectConfig } from '../protocol';
import { connectChain, describeSshError, type ConnectCallbacks } from '../ssh/connect';
import { detectOs } from '../ssh/os-detect';
import type { Transport, TransportEvents } from './types';

export type SshCallbacks = TransportEvents &
  Omit<ConnectCallbacks, 'status' | 'isCancelled'> & {
    /** Reports the remote OS once detected (best effort). */
    osDetected?(os: string): void;
  };

/** `export A='x' B='y'` with POSIX single-quote escaping; the leading space keeps it out of most histories. */
export function exportLine(env: Record<string, string>): string {
  const parts = Object.entries(env).map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'`);
  return parts.length ? ` export ${parts.join(' ')}\r` : '';
}

/** An interactive shell over SSH. */
export function openSsh(opts: { cols: number; rows: number; config: SshConnectConfig }, cb: SshCallbacks): Transport {
  let client: Client | null = null;
  let channel: ClientChannel | null = null;
  let closed = false;
  let exited = false;
  let cols = opts.cols;
  let rows = opts.rows;

  const finish = (code: number | null) => {
    if (exited) return;
    exited = true;
    cb.exit(code);
  };

  connectChain(opts.config, { ...cb, status: (s) => cb.status(s), isCancelled: () => closed })
    .then((c) => {
      client = c;
      if (closed) return c.end();
      c.on('error', (err) => {
        if (!closed) cb.status('error', describeSshError(err));
        finish(null);
      });
      c.on('close', () => finish(null));
      const env = opts.config.env;
      const useRequests = opts.config.envMethod === 'request' && Object.keys(env).length > 0;
      c.shell({ term: 'xterm-256color', cols, rows }, useRequests ? { env } : {}, (err, stream) => {
        if (err) {
          cb.status('error', describeSshError(err));
          c.end();
          return;
        }
        channel = stream;
        cb.status('ready');
        if (opts.config.envMethod === 'export') {
          const line = exportLine(env);
          if (line) stream.write(line);
        }
        if (cb.osDetected) void detectOs(c).then((os) => os && !closed && cb.osDetected!(os));
        stream.on('data', (d: Buffer) => cb.data(new Uint8Array(d)));
        stream.stderr.on('data', (d: Buffer) => cb.data(new Uint8Array(d)));
        stream.on('exit', (code: number | null) => finish(typeof code === 'number' ? code : null));
        stream.on('close', () => {
          finish(null);
          c.end();
        });
      });
    })
    .catch((err: Error) => {
      if (!closed) cb.status('error', describeSshError(err));
      finish(null);
    });

  return {
    write: (d) => channel?.write(d),
    resize: (c, r) => {
      cols = c;
      rows = r;
      channel?.setWindow(r, c, 0, 0);
    },
    pause: () => channel?.pause(),
    resume: () => channel?.resume(),
    close: () => {
      if (closed) return;
      closed = true;
      channel?.close();
      client?.end();
    },
  };
}
