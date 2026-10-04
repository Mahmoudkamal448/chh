import { z } from 'zod';

/**
 * Settings that can be set on a group and inherited by every host (and sub-group) inside it.
 * Resolution order: built-in defaults ← root group … leaf group ← host.
 */
export const ProxySchema = z.object({
  type: z.enum(['none', 'socks5', 'socks4', 'http']),
  host: z.string().max(255),
  port: z.number().int().min(1).max(65535),
  /** Optional; the password is asked for when connecting (never stored). */
  username: z.string().max(255),
});
export type ProxyConfig = z.infer<typeof ProxySchema>;

export const SerialSettingsSchema = z.object({
  baudRate: z.number().int().min(50).max(4_000_000),
  dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]),
  parity: z.enum(['none', 'even', 'odd', 'mark', 'space']),
  stopBits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]),
  flowControl: z.enum(['none', 'rtscts', 'xonxoff']),
  /** What Enter sends. */
  newline: z.enum(['cr', 'lf', 'crlf']),
  /** Echo typed characters locally (for devices that don't echo). */
  localEcho: z.boolean(),
});
export type SerialSettings = z.infer<typeof SerialSettingsSchema>;

/**
 * How to log in. "auto" tries everything configured (key and certificate, agent, default keys, then the
 * password); the others use only that method, plus a password prompt if the server asks for one.
 */
export const AuthMethodSchema = z.enum(['auto', 'password', 'key', 'certificate', 'agent', 'identity', 'ask']);
export type AuthMethod = z.infer<typeof AuthMethodSchema>;

export const HostSettingsSchema = z.object({
  authMethod: AuthMethodSchema,
  username: z.string().max(255),
  /** Identity (username + password/key) to use; null = none. */
  identityId: z.string().max(64).nullable(),
  /** Key to authenticate with; null = none (agent and default keys still apply). */
  keyId: z.string().max(64).nullable(),
  port: z.number().int().min(1).max(65535),
  useAgent: z.boolean(),
  tryDefaultKeys: z.boolean(),
  keepAliveSec: z.number().int().min(0).max(3600),
  connectTimeoutSec: z.number().int().min(1).max(300),
  terminalTheme: z.string().max(64),
  fontFamily: z.string().max(256),
  fontSize: z.number().int().min(6).max(48),
  cursorStyle: z.enum(['block', 'bar', 'underline']),
  cursorBlink: z.boolean(),
  scrollback: z.number().int().min(0).max(200_000),
  /** Remote command used to start Mosh (e.g. a full path if it's not on PATH). */
  moshServer: z.string().max(1024),
  /** Record commands typed on this host in the command history. */
  recordHistory: z.boolean(),
  /** Jump hosts (ids), nearest first: we connect to [0], then through it to [1], …, then the target. */
  jumpHosts: z.array(z.string().max(64)).max(8),
  /** Proxy for the first hop. */
  proxy: ProxySchema,
  /** Forward the local SSH agent to the server (only enable for servers you trust). */
  agentForwarding: z.boolean(),
  /** Environment variables for the session. Groups and hosts are merged (host wins per variable). */
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128), z.string().max(4096)),
  /** "request": SSH env requests (server must AcceptEnv them); "export": typed as `export` after login. */
  envMethod: z.enum(['request', 'export']),
  /** "openssh" runs the system ssh client in the terminal (FIDO2 security keys, post-quantum KEX). */
  sshEngine: z.enum(['builtin', 'openssh']),
  /** Private key / security-key handle path for the OpenSSH engine (-i). */
  identityFile: z.string().max(4096),
  serial: SerialSettingsSchema,
});
export type HostSettings = z.infer<typeof HostSettingsSchema>;

export const HostSettingsOverridesSchema = HostSettingsSchema.partial();
export type HostSettingsOverrides = z.infer<typeof HostSettingsOverridesSchema>;

export const DEFAULT_FONT_FAMILY =
  'ui-monospace, "SF Mono", Menlo, Consolas, "Cascadia Mono", "DejaVu Sans Mono", "Liberation Mono", monospace';

export const DEFAULT_HOST_SETTINGS: HostSettings = {
  authMethod: 'auto',
  username: '',
  identityId: null,
  keyId: null,
  port: 22,
  useAgent: true,
  tryDefaultKeys: true,
  keepAliveSec: 30,
  connectTimeoutSec: 20,
  terminalTheme: 'chh-dark',
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: 14,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 10_000,
  moshServer: 'mosh-server',
  recordHistory: true,
  jumpHosts: [],
  proxy: { type: 'none', host: '', port: 1080, username: '' },
  agentForwarding: false,
  env: {},
  envMethod: 'request',
  sshEngine: 'builtin',
  identityFile: '',
  serial: { baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none', newline: 'cr', localEcho: false },
};

/** Settings that make sense as app-wide terminal defaults (Settings → Terminal). */
export const TERMINAL_DEFAULT_KEYS = ['terminalTheme', 'fontFamily', 'fontSize', 'cursorStyle', 'cursorBlink', 'scrollback'] as const;

/** Remove keys whose value is undefined so spreads don't clobber inherited values. */
function defined<T extends object>(o: T | undefined): Partial<T> {
  const out: Partial<T> = {};
  if (!o) return out;
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export interface GroupLike {
  id: string;
  parentId: string | null;
  settings: HostSettingsOverrides;
}

/** Returns the group chain from root to `groupId` (inclusive). Cycles and dangling ids are cut. */
export function groupChain(groupId: string | null, groups: ReadonlyMap<string, GroupLike>): GroupLike[] {
  const chain: GroupLike[] = [];
  const seen = new Set<string>();
  let cur = groupId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const g = groups.get(cur);
    if (!g) break;
    chain.unshift(g);
    cur = g.parentId;
  }
  return chain;
}

export function resolveSettings(
  groupId: string | null,
  own: HostSettingsOverrides,
  groups: ReadonlyMap<string, GroupLike>,
  defaults: HostSettings = DEFAULT_HOST_SETTINGS,
): HostSettings {
  let s: HostSettings = { ...defaults };
  // Environment variables accumulate down the tree (a deeper level overrides a variable, not the set).
  let env = { ...defaults.env };
  const layers = [...groupChain(groupId, groups).map((g) => g.settings), own];
  for (const layer of layers) {
    s = { ...s, ...defined(layer) };
    if (layer.env) env = { ...env, ...layer.env };
  }
  return { ...s, env };
}

/** Like resolveSettings but excluding the host's own overrides (shown as "inherited" hints in editors). */
export function inheritedSettings(
  groupId: string | null,
  groups: ReadonlyMap<string, GroupLike>,
  defaults: HostSettings = DEFAULT_HOST_SETTINGS,
): HostSettings {
  return resolveSettings(groupId, {}, groups, defaults);
}
