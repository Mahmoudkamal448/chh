export type VersionVector = Readonly<Record<string, number>>;

export type VvOrder = 'equal' | 'before' | 'after' | 'concurrent';

/** Compare a to b: 'before' means a happened-before b (b dominates). */
export function compareVv(a: VersionVector, b: VersionVector): VvOrder {
  let aGreater = false;
  let bGreater = false;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k] ?? 0;
    const y = b[k] ?? 0;
    if (x > y) aGreater = true;
    else if (y > x) bGreater = true;
  }
  if (aGreater && bGreater) return 'concurrent';
  if (aGreater) return 'after';
  if (bGreater) return 'before';
  return 'equal';
}

export function incrementVv(v: VersionVector, node: string): VersionVector {
  return { ...v, [node]: (v[node] ?? 0) + 1 };
}

export function mergeVv(a: VersionVector, b: VersionVector): VersionVector {
  const out: Record<string, number> = { ...a };
  for (const [k, n] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, n);
  return out;
}
