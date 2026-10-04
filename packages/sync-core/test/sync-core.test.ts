import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  Hlc,
  applyLocalPatch,
  compareHlc,
  compareVv,
  formatHlc,
  incrementVv,
  mergeReplicas,
  parseHlc,
  type Replica,
} from '../src';

describe('Hlc', () => {
  it('is strictly monotonic even when the wall clock stalls or goes backwards', () => {
    let t = 1000;
    const clock = new Hlc('a', () => t);
    const a = clock.tick();
    const b = clock.tick();
    t = 500;
    const c = clock.tick();
    expect(compareHlc(a, b)).toBe(-1);
    expect(compareHlc(b, c)).toBe(-1);
  });

  it('orders local events after received remote events', () => {
    const local = new Hlc('a', () => 1000);
    const remote = new Hlc('b', () => 5000);
    const r = remote.tick();
    local.receive(r);
    expect(compareHlc(local.tick(), r)).toBe(1);
  });

  it('round-trips formatting', () => {
    const t = { wall: 1_700_000_000_000, counter: 42, node: 'dev1' };
    expect(parseHlc(formatHlc(t))).toEqual(t);
  });

  it('rejects absurd remote drift', () => {
    const local = new Hlc('a', () => 0);
    expect(() => local.receive(formatHlc({ wall: 10 ** 13, counter: 0, node: 'b' }))).toThrow();
  });
});

describe('version vectors', () => {
  it('detects dominance and concurrency', () => {
    expect(compareVv({ a: 1 }, { a: 1 })).toBe('equal');
    expect(compareVv({ a: 1 }, { a: 2 })).toBe('before');
    expect(compareVv({ a: 2, b: 1 }, { a: 2 })).toBe('after');
    expect(compareVv({ a: 2 }, { b: 1 })).toBe('concurrent');
  });
});

describe('mergeReplicas', () => {
  const c0 = formatHlc({ wall: 0, counter: 0, node: 'origin' });
  const base: Replica = { fields: { label: 'x', port: 22 }, clocks: { label: c0, port: c0 }, vv: {} };

  it('merges concurrent edits field by field', () => {
    let wall = 1;
    const ha = new Hlc('a', () => wall++);
    const hb = new Hlc('b', () => wall++);
    const a = applyLocalPatch(base, { label: 'from-a' }, () => ha.tick()).replica;
    const b = applyLocalPatch(base, { port: 2222 }, () => hb.tick()).replica;
    const ra = { ...a, vv: incrementVv(base.vv, 'a') };
    const rb = { ...b, vv: incrementVv(base.vv, 'b') };
    const m1 = mergeReplicas(ra, rb);
    const m2 = mergeReplicas(rb, ra);
    expect(m1.fields).toEqual({ label: 'from-a', port: 2222 });
    expect(m2).toEqual(m1);
  });

  it('takes the dominating side wholesale', () => {
    const older: Replica = { fields: { a: 1 }, clocks: { a: 'z' }, vv: { a: 1 } };
    const newer: Replica = { fields: { a: 2 }, clocks: { a: 'a' }, vv: { a: 2 } };
    expect(mergeReplicas(older, newer)).toBe(newer);
  });

  it('converges for any interleaving of concurrent edits (property)', () => {
    const fieldArb = fc.constantFrom('label', 'port', 'notes', '_deleted');
    const editArb = fc.record({ node: fc.constantFrom('a', 'b', 'c'), field: fieldArb, value: fc.integer() });
    fc.assert(
      fc.property(fc.array(editArb, { minLength: 1, maxLength: 30 }), (edits) => {
        let wall = 0;
        const clocks = { a: new Hlc('a', () => wall), b: new Hlc('b', () => wall), c: new Hlc('c', () => wall) };
        const replicas: Record<string, Replica> = {
          a: { fields: {}, clocks: {}, vv: {} },
          b: { fields: {}, clocks: {}, vv: {} },
          c: { fields: {}, clocks: {}, vv: {} },
        };
        for (const e of edits) {
          wall += 1;
          const node = e.node as 'a' | 'b' | 'c';
          const r = applyLocalPatch(replicas[node]!, { [e.field]: e.value }, () => clocks[node].tick()).replica;
          replicas[node] = { ...r, vv: incrementVv(r.vv, node) };
        }
        const [a, b, c] = [replicas.a!, replicas.b!, replicas.c!];
        const m1 = mergeReplicas(mergeReplicas(a, b), c);
        const m2 = mergeReplicas(c, mergeReplicas(b, a));
        const m3 = mergeReplicas(mergeReplicas(b, c), a);
        expect(m2.fields).toEqual(m1.fields);
        expect(m3.fields).toEqual(m1.fields);
        expect(compareVv(m1.vv, m2.vv)).toBe('equal');
      }),
    );
  });
});
