import { z } from 'zod';

/**
 * Settings that can be set on a group and inherited by every host (and sub-group) inside it.
 * Resolution order: built-in defaults ← root group … leaf group ← host.
 */
export const HostSettingsSchema = z.object({
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
});
export type HostSettings = z.infer<typeof HostSettingsSchema>;

export const HostSettingsOverridesSchema = HostSettingsSchema.partial();
export type HostSettingsOverrides = z.infer<typeof HostSettingsOverridesSchema>;

export const DEFAULT_FONT_FAMILY =
  'ui-monospace, "SF Mono", Menlo, Consolas, "Cascadia Mono", "DejaVu Sans Mono", "Liberation Mono", monospace';

export const DEFAULT_HOST_SETTINGS: HostSettings = {
  username: '',
  identityId: null,
  keyId: null,
  port: 22,
  useAgent: true,
  tryDefaultKeys: true,
  keepAliveSec: 30,
  connectTimeoutSec: 20,
  terminalTheme: 'cy-dark',
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: 14,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 10_000,
};

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
  for (const g of groupChain(groupId, groups)) s = { ...s, ...defined(g.settings) };
  return { ...s, ...defined(own) };
}

/** Like resolveSettings but excluding the host's own overrides (shown as "inherited" hints in editors). */
export function inheritedSettings(
  groupId: string | null,
  groups: ReadonlyMap<string, GroupLike>,
  defaults: HostSettings = DEFAULT_HOST_SETTINGS,
): HostSettings {
  return resolveSettings(groupId, {}, groups, defaults);
}
