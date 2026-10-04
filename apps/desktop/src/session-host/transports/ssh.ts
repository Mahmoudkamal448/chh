import type { Client, ClientChannel } from 'ssh2';
import type { SshConnectConfig } from '../protocol';
import { connectSsh, describeSshError, type ConnectCallbacks } from '../ssh/connect';
import type { Transport, TransportEvents } from './types';

export type SshCallbacks = TransportEvents & Omit<ConnectCallbacks, 'status' | 'isCancelled'>;

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

  connectSsh(opts.config, { ...cb, status: (s) => cb.status(s), isCancelled: () => closed })
    .then((c) => {
      client = c;
      if (closed) return c.end();
      c.on('error', (err) => {
        if (!closed) cb.status('error', describeSshError(err));
        finish(null);
      });
      c.on('close', () => finish(null));
      c.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) {
          cb.status('error', describeSshError(err));
          c.end();
          return;
        }
        channel = stream;
        cb.status('ready');
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
