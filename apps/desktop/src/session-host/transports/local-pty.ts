import * as pty from 'node-pty';
import type { Transport, TransportEvents } from './types';

export function openLocalPty(
  opts: { shell: { path: string; args: string[] }; cwd: string; cols: number; rows: number },
  ev: TransportEvents,
): Transport {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('ELECTRON_') && k !== 'CHH_TEST') env[k] = v;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'chh';

  ev.status('connecting');
  const proc = pty.spawn(opts.shell.path, opts.shell.args, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env,
    // Windows: ConPTY (default on Windows 10 1809+).
    useConpty: process.platform === 'win32' ? true : undefined,
  });
  ev.status('ready');

  proc.onData((d) => ev.data(d));
  proc.onExit(({ exitCode }) => ev.exit(exitCode));

  let closed = false;
  return {
    write: (d) => {
      if (!closed) proc.write(d);
    },
    resize: (c, r) => {
      if (!closed) proc.resize(c, r);
    },
    pause: () => proc.pause(),
    resume: () => proc.resume(),
    close: () => {
      if (closed) return;
      closed = true;
      try {
        proc.kill();
      } catch {
        // already exited
      }
    },
  };
}
