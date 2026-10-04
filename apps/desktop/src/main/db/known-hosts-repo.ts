import type { KnownHostFields } from '@cy-ssh/shared';
import type { ItemStore } from './item-store';

export type HostKeyVerdict =
  | { kind: 'match' }
  | { kind: 'unknown' }
  /** A different key of the SAME type is on record — possible man-in-the-middle. */
  | { kind: 'changed'; previous: KnownHostFields }
  /** Only keys of other types are on record (e.g. server added ed25519). */
  | { kind: 'new-type'; previous: KnownHostFields };

export class KnownHostsRepo {
  constructor(private readonly store: ItemStore) {}

  check(hostPattern: string, keyType: string, publicKey: string): HostKeyVerdict {
    const entries = this.store.query<KnownHostFields>('known_host', 'pattern = ?', [hostPattern]).map((i) => i.fields);
    if (entries.some((e) => e.keyType === keyType && e.publicKey === publicKey)) return { kind: 'match' };
    const sameType = entries.find((e) => e.keyType === keyType);
    if (sameType) return { kind: 'changed', previous: sameType };
    if (entries[0]) return { kind: 'new-type', previous: entries[0] };
    return { kind: 'unknown' };
  }

  /** Saves the key, replacing any previous key of the same type for this host. */
  save(entry: Omit<KnownHostFields, 'addedAt'>): void {
    this.store.transaction(() => {
      for (const old of this.store.query<KnownHostFields>('known_host', 'pattern = ?', [entry.hostPattern])) {
        if (old.fields.keyType === entry.keyType) this.store.remove(old.id, 'known_host');
      }
      this.store.insert<KnownHostFields>('known_host', { ...entry, addedAt: Date.now() });
    });
  }
}
