import { compareHlc } from './hlc';
import { compareVv, mergeVv, type VersionVector } from './version-vector';

/**
 * A replicated record: arbitrary top-level fields, each stamped with the HLC of its last write.
 * Deletion is modelled as the field `_deleted` so it resolves like any other write.
 */
export interface Replica {
  fields: Record<string, unknown>;
  clocks: Record<string, string>;
  vv: VersionVector;
}

export const DELETED_FIELD = '_deleted';

/** Apply a local edit: changed fields get a fresh clock; returns which fields changed. */
export function applyLocalPatch(
  r: Replica,
  patch: Record<string, unknown>,
  stamp: () => string,
): { replica: Replica; changed: string[] } {
  const fields = { ...r.fields };
  const clocks = { ...r.clocks };
  const changed: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k in fields && stableEqual(fields[k], v)) continue;
    fields[k] = v;
    clocks[k] = stamp();
    changed.push(k);
  }
  return { replica: { fields, clocks, vv: r.vv }, changed };
}

/**
 * Merge two replicas of the same item.
 * - If one version vector dominates, take that side wholesale.
 * - If they're concurrent, merge field by field: the write with the greater HLC wins.
 * Deterministic and commutative, so all replicas converge.
 */
export function mergeReplicas(local: Replica, remote: Replica): Replica {
  const order = compareVv(local.vv, remote.vv);
  if (order === 'after' || order === 'equal') return local;
  if (order === 'before') return remote;

  const fields: Record<string, unknown> = {};
  const clocks: Record<string, string> = {};
  for (const k of new Set([...Object.keys(local.fields), ...Object.keys(remote.fields)])) {
    const lc = local.clocks[k];
    const rc = remote.clocks[k];
    const takeRemote = rc !== undefined && (lc === undefined || compareHlc(rc, lc) > 0);
    const src = takeRemote ? remote : local;
    if (k in src.fields) fields[k] = src.fields[k];
    const c = src.clocks[k];
    if (c !== undefined) clocks[k] = c;
  }
  return { fields, clocks, vv: mergeVv(local.vv, remote.vv) };
}

export function isDeleted(r: Replica): boolean {
  return r.fields[DELETED_FIELD] === true;
}

/** Structural equality for JSON-like values (key order independent). */
export function stableEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => stableEqual(x, b[i]));
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => stableEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
