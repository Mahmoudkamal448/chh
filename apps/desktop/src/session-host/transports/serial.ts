import { SerialPort } from 'serialport';
import type { SerialSettings } from '@chh/shared';
import type { Transport, TransportEvents } from './types';

const NEWLINES: Record<SerialSettings['newline'], string> = { cr: '\r', lf: '\n', crlf: '\r\n' };

/** Maps the Enter key (\r from xterm) to the configured line ending. */
export function translateInput(data: string, newline: SerialSettings['newline']): string {
  return newline === 'cr' ? data : data.replace(/\r/g, NEWLINES[newline]);
}

export function describeSerialError(err: Error & { code?: string; errno?: number }): string {
  const m = err.message;
  if (/no such file|cannot find|ENOENT|File not found/i.test(m)) return 'session.error.serialNotFound';
  if (/permission denied|access denied|EACCES/i.test(m)) return 'session.error.serialPermission';
  if (/busy|locked|EBUSY/i.test(m)) return 'session.error.serialBusy';
  return `session.error.serialFailed::${m}`;
}

/** A serial port as a terminal transport. `binding` is injectable for tests. */
export function openSerial(
  opts: { path: string; settings: SerialSettings; binding?: ConstructorParameters<typeof SerialPort>[0]['binding'] },
  ev: TransportEvents,
): Transport {
  const s = opts.settings;
  let closed = false;
  let exited = false;
  const finish = (code: number | null) => {
    if (exited) return;
    exited = true;
    ev.exit(code);
  };
  ev.status('connecting');
  const port = new SerialPort({
    path: opts.path,
    baudRate: s.baudRate,
    dataBits: s.dataBits,
    parity: s.parity,
    stopBits: s.stopBits,
    rtscts: s.flowControl === 'rtscts',
    xon: s.flowControl === 'xonxoff',
    xoff: s.flowControl === 'xonxoff',
    autoOpen: false,
    ...(opts.binding ? { binding: opts.binding } : {}),
  } as ConstructorParameters<typeof SerialPort>[0]);
  port.open((err) => {
    if (err) {
      ev.status('error', describeSerialError(err));
      finish(null);
      return;
    }
    ev.status('ready');
  });
  port.on('data', (d: Buffer) => ev.data(new Uint8Array(d)));
  port.on('error', (err) => {
    if (!closed) ev.status('error', describeSerialError(err));
    finish(null);
  });
  port.on('close', () => finish(null));

  return {
    write: (d) => {
      if (closed || !port.isOpen) return;
      const out = translateInput(d, s.newline);
      port.write(out);
      if (s.localEcho) ev.data(out.replace(/\r(?!\n)/g, '\r\n'));
    },
    resize: () => undefined, // serial lines have no window size
    pause: () => port.pause(),
    resume: () => port.resume(),
    close: () => {
      if (closed) return;
      closed = true;
      if (port.isOpen) port.close();
    },
  };
}
