import { entryMatches, parseKnownHosts, type KnownHostEntry } from '@cy-ssh/key-formats';
import type { KnownHost, KnownHostFields } from '@cy-ssh/shared';
import { createHash } from 'node:crypto';
import type { ItemStore, StoredItem } from './item-store';

export type HostKeyVerdict =
  | { kind: 'match' }
  | { kind: 'unknown' }
  /** A different key of the SAME type is on record — possible man-in-the-middle. */
  | { kind: 'changed'; previous: KnownHostFields }
  /** Only keys of other types are on record (e.g. server added ed25519). */
  | { kind: 'new-type'; previous: KnownHostFields };

/** Patterns that need matching logic instead of an exact lookup (hashed, wildcard, list, negated). */
const isPattern = (p: string) => p.startsWith('|1|') || /[*?!,]/.test(p);

function asEntry(f: KnownHostFields): KnownHostEntry {
  const hm = /^\|1\|([^|]+)\|([^|]+)$/.exec(f.hostPattern);
  return {
    marker: null,
    patterns: hm ? [] : f.hostPattern.split(','),
    hashed: hm ? { salt: Buffer.from(hm[1]!, 'base64'), hash: Buffer.from(hm[2]!, 'base64') } : null,
    keyType: f.keyType as KnownHostEntry['keyType'],
    publicKey: f.publicKey,
    comment: '',
  };
}

export class KnownHostsRepo {
  constructor(private readonly store: ItemStore) {}

  /** Entries that apply to `hostPattern` (exact entries plus matching hashed/wildcard ones). */
  private entriesFor(hostPattern: string): KnownHostFields[] {
    const exact = this.store.query<KnownHostFields>('known_host', 'pattern = ?', [hostPattern]).map((i) => i.fields);
    const patterned = this.store
      .query<KnownHostFields>('known_host', `pattern LIKE '|1|%' OR pattern GLOB '*[*?!,]*'`)
      .map((i) => i.fields)
      .filter((f) => isPattern(f.hostPattern) && entryMatches(asEntry(f), hostPattern));
    return [...exact, ...patterned];
  }

  check(hostPattern: string, keyType: string, publicKey: string): HostKeyVerdict {
    const entries = this.entriesFor(hostPattern);
    if (entries.some((e) => e.keyType === keyType && e.publicKey === publicKey)) return { kind: 'match' };
    const sameType = entries.find((e) => e.keyType === keyType);
    if (sameType) return { kind: 'changed', previous: sameType };
    if (entries[0]) return { kind: 'new-type', previous: entries[0] };
    return { kind: 'unknown' };
  }

  /** Saves a trusted key, replacing any previous exact entry of the same type for this host. */
  save(entry: Omit<KnownHostFields, 'addedAt' | 'source'>): void {
    this.store.transaction(() => {
      for (const old of this.store.query<KnownHostFields>('known_host', 'pattern = ?', [entry.hostPattern])) {
        if (old.fields.keyType === entry.keyType) this.store.remove(old.id, 'known_host');
      }
      this.store.insert<KnownHostFields>('known_host', { ...entry, addedAt: Date.now(), source: 'trusted' });
    });
  }

  list(query?: string): KnownHost[] {
    const q = query?.trim();
    const where = q ? `pattern LIKE ? ESCAPE '\\' OR json_extract(fields, '$.fingerprint') LIKE ? ESCAPE '\\'` : '1';
    const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : '';
    return this.store
      .query<KnownHostFields>('known_host', where, q ? [like, like] : [], 'pattern COLLATE NOCASE, id')
      .map(toKnownHost);
  }

  remove(ids: string[]): void {
    this.store.transaction(() => {
      for (const id of ids) this.store.remove(id, 'known_host');
    });
  }

  /**
   * Imports an OpenSSH known_hosts file. Entries already present (same pattern + key) are skipped,
   * as are @revoked / @cert-authority lines (not supported yet).
   */
  importText(text: string): { imported: number; skipped: number } {
    let imported = 0;
    let skipped = 0;
    const existing = new Set(
      this.store.query<KnownHostFields>('known_host').map((i) => `${i.fields.hostPattern} ${i.fields.keyType} ${i.fields.publicKey}`),
    );
    this.store.transaction(() => {
      for (const e of parseKnownHosts(text)) {
        if (e.marker) {
          skipped++;
          continue;
        }
        const pattern = e.hashed
          ? `|1|${e.hashed.salt.toString('base64')}|${e.hashed.hash.toString('base64')}`
          : e.patterns.join(',');
        const sig = `${pattern} ${e.keyType} ${e.publicKey}`;
        if (existing.has(sig)) {
          skipped++;
          continue;
        }
        existing.add(sig);
        const blob = Buffer.from(e.publicKey, 'base64');
        this.store.insert<KnownHostFields>('known_host', {
          hostPattern: pattern,
          keyType: e.keyType,
          fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`,
          publicKey: e.publicKey,
          addedAt: Date.now(),
          source: 'imported',
        });
        imported++;
      }
    });
    return { imported, skipped };
  }
}

function toKnownHost(item: StoredItem<KnownHostFields>): KnownHost {
  const { publicKey: _pk, ...rest } = item.fields;
  return { ...rest, id: item.id };
}
