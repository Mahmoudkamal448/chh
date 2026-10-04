import { parseForward, type ForwardSpec } from './forwards';
import type { ParsedConfig } from './parse';
import { concreteAliases, resolveHost } from './resolve';

export interface ImportCandidate {
  alias: string;
  hostName: string;
  port: number | null;
  user: string | null;
  /** Expanded paths (~ and %-tokens resolved). */
  identityFiles: string[];
  proxyJump: string | null;
  forwardAgent: boolean | null;
  forwards: ForwardSpec[];
  /** Keywords present but not imported (shown to the user). */
  unsupported: string[];
}

/** Keywords we map onto chh fields (or that are irrelevant to import). */
const HANDLED = new Set([
  'hostname', 'port', 'user', 'identityfile', 'proxyjump', 'forwardagent', 'localforward', 'remoteforward', 'dynamicforward',
  // Behaviour already covered by app defaults / not meaningful to import:
  'identitiesonly', 'addkeystoagent', 'usekeychain', 'serveraliveinterval', 'serveralivecountmax', 'connecttimeout',
  'stricthostkeychecking', 'userknownhostsfile', 'hashknownhosts', 'loglevel', 'compression', 'requesttty', 'tcpkeepalive',
]);

export interface ExpandContext {
  home: string;
  localUser: string;
}

/** Expands ~ and the %-tokens OpenSSH allows in IdentityFile and similar keywords. */
export function expandTokens(s: string, c: ExpandContext & { host: string; alias: string; port: number; user: string }): string {
  let out = s.startsWith('~/') || s === '~' ? c.home + s.slice(1) : s;
  out = out.replace(/%(.)/g, (m, t: string) => {
    switch (t) {
      case '%':
        return '%';
      case 'h':
        return c.host;
      case 'n':
        return c.alias;
      case 'p':
        return String(c.port);
      case 'r':
        return c.user;
      case 'u':
        return c.localUser;
      case 'd':
        return c.home;
      default:
        return m;
    }
  });
  return out;
}

export function importCandidates(config: ParsedConfig, ctx: ExpandContext): ImportCandidate[] {
  return concreteAliases(config).map((alias) => {
    const r = resolveHost(config, alias);
    const first = (k: string) => r.options.get(k)?.[0]?.[0] ?? null;
    const hostName = (first('hostname') ?? alias).replace(/%h/g, alias);
    const portStr = first('port');
    const port = portStr && /^\d+$/.test(portStr) ? Number(portStr) : null;
    const user = first('user');
    const tokenCtx = { ...ctx, host: hostName, alias, port: port ?? 22, user: user ?? ctx.localUser };
    const identityFiles = (r.options.get('identityfile') ?? [])
      .map((a) => a[0])
      .filter((x): x is string => !!x && x.toLowerCase() !== 'none')
      .map((x) => expandTokens(x, tokenCtx));
    const forwards: ForwardSpec[] = [];
    for (const [kw, kind] of [['localforward', 'local'], ['remoteforward', 'remote'], ['dynamicforward', 'dynamic']] as const) {
      for (const args of r.options.get(kw) ?? []) {
        const f = parseForward(kind, args);
        if (f) forwards.push(f);
      }
    }
    const fa = first('forwardagent');
    return {
      alias,
      hostName,
      port,
      user,
      identityFiles: [...new Set(identityFiles)],
      proxyJump: first('proxyjump'),
      forwardAgent: fa === null ? null : fa.toLowerCase() === 'yes',
      forwards,
      unsupported: [...r.options.keys()].filter((k) => !HANDLED.has(k)).sort(),
    };
  });
}
