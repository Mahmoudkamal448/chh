import type { ForwardSpec } from './forwards';

export interface ExportHost {
  alias: string;
  hostName: string;
  port?: number;
  user?: string;
  identityFile?: string;
  forwards?: ForwardSpec[];
  comment?: string;
}

/** Quotes a value if it contains whitespace or '#'. */
function v(s: string): string {
  return /[\s#"]/.test(s) ? `"${s.replace(/"/g, '')}"` : s;
}

/** Makes a label usable as a Host alias (no whitespace, wildcards or commas). */
export function toAlias(label: string): string {
  return label.trim().replace(/[\s,*?!]+/g, '-').replace(/^-+|-+$/g, '') || 'host';
}

function fmtListen(host: string, port: number): string {
  if (host === '127.0.0.1' || host === 'localhost') return String(port);
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Serializes hosts to ssh_config text. Aliases are made unique. */
export function writeSshConfig(hosts: ExportHost[], header = 'Exported by chh'): string {
  const used = new Map<string, number>();
  const out: string[] = [`# ${header}`, ''];
  for (const h of hosts) {
    let alias = toAlias(h.alias);
    const n = used.get(alias.toLowerCase()) ?? 0;
    used.set(alias.toLowerCase(), n + 1);
    if (n) alias = `${alias}-${n + 1}`;
    if (h.comment) for (const c of h.comment.split('\n')) out.push(`# ${c}`);
    out.push(`Host ${alias}`);
    out.push(`    HostName ${v(h.hostName)}`);
    if (h.port && h.port !== 22) out.push(`    Port ${h.port}`);
    if (h.user) out.push(`    User ${v(h.user)}`);
    if (h.identityFile) out.push(`    IdentityFile ${v(h.identityFile)}`);
    for (const f of h.forwards ?? []) {
      const listen = fmtListen(f.bindHost, f.bindPort);
      if (f.kind === 'dynamic') out.push(`    DynamicForward ${listen}`);
      else out.push(`    ${f.kind === 'local' ? 'LocalForward' : 'RemoteForward'} ${listen} ${f.destHost?.includes(':') ? `[${f.destHost}]` : f.destHost}:${f.destPort}`);
    }
    out.push('');
  }
  return out.join('\n');
}
