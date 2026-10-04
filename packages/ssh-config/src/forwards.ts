export interface ForwardSpec {
  kind: 'local' | 'remote' | 'dynamic';
  bindHost: string;
  bindPort: number;
  destHost: string | null;
  destPort: number | null;
}

/** "[bind:]port" -> { host, port } (IPv6 may be bracketed). */
function parseListen(s: string): { host: string; port: number } | null {
  const m = /^(?:\[([^\]]+)\]:|([^:]*):)?(\d+)$/.exec(s);
  if (!m) return null;
  const host = m[1] ?? m[2];
  return { host: host === undefined || host === '' || host === '*' ? (host === '*' ? '0.0.0.0' : '127.0.0.1') : host, port: Number(m[3]) };
}

function parseTarget(s: string): { host: string; port: number } | null {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(s);
  return m ? { host: (m[1] ?? m[2])!, port: Number(m[3]) } : null;
}

const validPort = (p: number) => Number.isInteger(p) && p > 0 && p < 65536;

/** Parses LocalForward / RemoteForward / DynamicForward arguments. Unix-socket forms return null. */
export function parseForward(kind: ForwardSpec['kind'], args: string[]): ForwardSpec | null {
  let listenArg = args[0];
  let targetArg = args[1];
  // Also accept the single-argument "-L" style: bind:port:host:hostport.
  if (kind !== 'dynamic' && args.length === 1) {
    const m = /^(?:(.*):)?(\d+):(\[[^\]]+\]|[^:]+):(\d+)$/.exec(args[0]!);
    if (!m) return null;
    listenArg = m[1] ? `${m[1]}:${m[2]}` : m[2];
    targetArg = `${m[3]}:${m[4]}`;
  }
  const listen = listenArg ? parseListen(listenArg) : null;
  if (!listen || !validPort(listen.port)) return null;
  if (kind === 'dynamic') return { kind, bindHost: listen.host, bindPort: listen.port, destHost: null, destPort: null };
  const target = targetArg ? parseTarget(targetArg) : null;
  if (!target || !validPort(target.port)) return null;
  return { kind, bindHost: listen.host, bindPort: listen.port, destHost: target.host, destPort: target.port };
}
