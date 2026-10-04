import { randomUUID } from 'node:crypto';
import { DELETED_FIELD, Hlc, applyLocalPatch, incrementVv, type Replica } from '@cy-ssh/sync-core';
import type { Db } from './database';

export type ItemType = 'host' | 'group' | 'known_host' | 'key' | 'identity';

export interface StoredItem<F> {
  id: string;
  vaultId: string;
  type: ItemType;
  fields: F;
  updatedAt: number;
}

interface Row {
  id: string;
  vault_id: string;
  type: ItemType;
  fields: string;
  clocks: string;
  vv: string;
  updated_at: number;
}

/** UUIDv7: time-ordered ids keep inserts append-mostly in the primary-key index. */
export function uuidv7(now = Date.now()): string {
  const b = Buffer.from(randomUUID().replace(/-/g, ''), 'hex');
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Generic storage for synced entities. Every write stamps changed fields with an HLC and bumps
 * this device's entry in the version vector, so Phase 4 sync can merge without a schema change.
 */
export class ItemStore {
  private readonly hlc: Hlc;

  constructor(
    readonly db: Db,
    private readonly deviceId: string,
    /** Vault new items are written to (the personal vault until team vaults arrive). */
    private readonly vaultId: string,
  ) {
    this.hlc = new Hlc(deviceId.replace(/-/g, ''));
  }

  get<F>(id: string, type?: ItemType): StoredItem<F> | null {
    const row = this.db
      .prepare('SELECT id, vault_id, type, fields, clocks, vv, updated_at FROM items WHERE id = ? AND deleted = 0')
      .get(id) as Row | undefined;
    if (!row || (type && row.type !== type)) return null;
    return toItem<F>(row);
  }

  /** Raw SELECT over non-deleted items of one type; `where` must use bound params. */
  query<F>(type: ItemType, where = '1', params: unknown[] = [], order = 'label COLLATE NOCASE, id', limit = -1, offset = 0) {
    const rows = this.db
      .prepare(
        `SELECT id, vault_id, type, fields, clocks, vv, updated_at FROM items
         WHERE type = ? AND deleted = 0 AND (${where}) ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(type, ...params, limit, offset) as Row[];
    return rows.map((r) => toItem<F>(r));
  }

  count(type: ItemType, where = '1', params: unknown[] = []): number {
    const r = this.db
      .prepare(`SELECT count(*) AS n FROM items WHERE type = ? AND deleted = 0 AND (${where})`)
      .get(type, ...params) as { n: number };
    return r.n;
  }

  insert<F extends object>(type: ItemType, fields: F, id: string = uuidv7()): StoredItem<F> {
    const vaultId = this.vaultId;
    const { replica } = applyLocalPatch({ fields: {}, clocks: {}, vv: {} }, fields as Record<string, unknown>, () =>
      this.hlc.tick(),
    );
    const vv = incrementVv(replica.vv, this.deviceId);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO items (id, vault_id, type, fields, clocks, vv, dirty, deleted, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)`,
      )
      .run(id, vaultId, type, JSON.stringify(replica.fields), JSON.stringify(replica.clocks), JSON.stringify(vv), now);
    return { id, vaultId, type, fields, updatedAt: now };
  }

  /** Applies a partial update. Returns null if the item doesn't exist. */
  update<F>(id: string, type: ItemType, patch: Partial<F>): StoredItem<F> | null {
    const row = this.db
      .prepare('SELECT id, vault_id, type, fields, clocks, vv, updated_at FROM items WHERE id = ? AND type = ? AND deleted = 0')
      .get(id, type) as Row | undefined;
    if (!row) return null;
    const current: Replica = { fields: JSON.parse(row.fields), clocks: JSON.parse(row.clocks), vv: JSON.parse(row.vv) };
    const { replica, changed } = applyLocalPatch(current, patch as Record<string, unknown>, () => this.hlc.tick());
    if (changed.length === 0) return toItem<F>(row);
    const vv = incrementVv(replica.vv, this.deviceId);
    const now = Date.now();
    this.db
      .prepare('UPDATE items SET fields = ?, clocks = ?, vv = ?, dirty = 1, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(replica.fields), JSON.stringify(replica.clocks), JSON.stringify(vv), now, id);
    return { id, vaultId: row.vault_id, type, fields: replica.fields as F, updatedAt: now };
  }

  /** Soft delete (tombstone) so the deletion can sync; payload fields are cleared. */
  remove(id: string, type: ItemType): boolean {
    const row = this.db
      .prepare('SELECT clocks, vv FROM items WHERE id = ? AND type = ? AND deleted = 0')
      .get(id, type) as Pick<Row, 'clocks' | 'vv'> | undefined;
    if (!row) return false;
    const stamp = this.hlc.tick();
    const clocks = { ...JSON.parse(row.clocks), [DELETED_FIELD]: stamp };
    const vv = incrementVv(JSON.parse(row.vv), this.deviceId);
    this.db
      .prepare(`UPDATE items SET fields = ?, clocks = ?, vv = ?, deleted = 1, dirty = 1, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify({ [DELETED_FIELD]: true }), JSON.stringify(clocks), JSON.stringify(vv), Date.now(), id);
    return true;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

function toItem<F>(r: Row): StoredItem<F> {
  return { id: r.id, vaultId: r.vault_id, type: r.type, fields: JSON.parse(r.fields) as F, updatedAt: r.updated_at };
}
