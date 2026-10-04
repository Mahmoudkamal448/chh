import { randomUUID } from 'node:crypto';
import { DELETED_FIELD, Hlc, applyLocalPatch, incrementVv, type Replica, type VersionVector } from '@cy-ssh/sync-core';
import type { Db } from './database';

export type ItemType = 'host' | 'group' | 'known_host' | 'key' | 'identity' | 'forward' | 'snippet';

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
/** A full item as needed by the sync engine. */
export interface SyncRow {
  id: string;
  vaultId: string;
  type: ItemType;
  fields: Record<string, unknown>;
  clocks: Record<string, string>;
  vv: VersionVector;
  serverRev: number | null;
  dirty: boolean;
  deleted: boolean;
  updatedAt: number;
}

interface FullRow extends Row {
  server_rev: number | null;
  dirty: number;
  deleted: number;
}

const toSyncRow = (r: FullRow): SyncRow => ({
  id: r.id,
  vaultId: r.vault_id,
  type: r.type,
  fields: JSON.parse(r.fields),
  clocks: JSON.parse(r.clocks),
  vv: JSON.parse(r.vv),
  serverRev: r.server_rev,
  dirty: r.dirty === 1,
  deleted: r.deleted === 1,
  updatedAt: r.updated_at,
});

export class ItemStore {
  private readonly hlc: Hlc;
  private readonly listeners = new Set<(type: ItemType) => void>();
  private vaultIdValue: string;

  constructor(
    readonly db: Db,
    private readonly deviceId: string,
    /** Vault new items are written to (the personal vault until team vaults arrive). */
    vaultId: string,
  ) {
    this.hlc = new Hlc(deviceId.replace(/-/g, ''));
    this.vaultIdValue = vaultId;
  }

  get vaultId(): string {
    return this.vaultIdValue;
  }

  /** Called when the personal vault is replaced (joining an existing sync account). */
  setVaultId(id: string): void {
    this.vaultIdValue = id;
  }

  get device(): string {
    return this.deviceId;
  }

  /** Notified after every local write (used to schedule a sync push). */
  onLocalChange(fn: (type: ItemType) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(type: ItemType): void {
    for (const fn of this.listeners) fn(type);
  }

  // --- sync support --------------------------------------------------------------------------

  getSyncRow(id: string): SyncRow | null {
    const r = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as FullRow | undefined;
    return r ? toSyncRow(r) : null;
  }

  dirtyRows(vaultId: string, limit: number): SyncRow[] {
    return (this.db.prepare('SELECT * FROM items WHERE vault_id = ? AND dirty = 1 ORDER BY updated_at LIMIT ?').all(vaultId, limit) as FullRow[]).map(toSyncRow);
  }

  /** Keeps the HLC ahead of every clock seen from other devices. */
  observeClocks(clocks: Record<string, string>): void {
    for (const c of Object.values(clocks)) {
      try {
        this.hlc.receive(c);
      } catch {
        // absurd remote clock: ignore (merge still orders deterministically)
      }
    }
  }

  /** Writes a merged/remote version of an item. */
  writeSynced(row: { id: string; vaultId: string; type: ItemType; replica: Replica; serverRev: number; dirty: boolean }): void {
    const deleted = row.replica.fields[DELETED_FIELD] === true;
    const fields = deleted ? { [DELETED_FIELD]: true } : row.replica.fields;
    this.db
      .prepare(
        `INSERT INTO items (id, vault_id, type, fields, clocks, vv, server_rev, dirty, deleted, updated_at)
         VALUES (@id, @vault, @type, @fields, @clocks, @vv, @rev, @dirty, @deleted, @now)
         ON CONFLICT(id) DO UPDATE SET vault_id = @vault, type = @type, fields = @fields, clocks = @clocks, vv = @vv,
           server_rev = @rev, dirty = @dirty, deleted = @deleted, updated_at = @now`,
      )
      .run({
        id: row.id,
        vault: row.vaultId,
        type: row.type,
        fields: JSON.stringify(fields),
        clocks: JSON.stringify(row.replica.clocks),
        vv: JSON.stringify(row.replica.vv),
        rev: row.serverRev,
        dirty: row.dirty ? 1 : 0,
        deleted: deleted ? 1 : 0,
        now: Date.now(),
      });
  }

  /** After a successful push: record the revision; clear `dirty` unless the item changed meanwhile. */
  markPushed(id: string, rev: number, pushedUpdatedAt: number): void {
    this.db.prepare('UPDATE items SET server_rev = ?, dirty = CASE WHEN updated_at = ? THEN 0 ELSE dirty END WHERE id = ?').run(rev, pushedUpdatedAt, id);
  }

  /** Bumps this device's counter (used when a merge produces a new version). */
  bumpVv(vv: VersionVector): VersionVector {
    return incrementVv(vv, this.deviceId);
  }

  /** Forget all server state (signing out): everything becomes "local, never pushed". */
  resetSyncState(): void {
    this.db.prepare('UPDATE items SET server_rev = NULL, dirty = 1').run();
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
    this.changed(type);
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
    this.changed(type);
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
    this.changed(type);
    return true;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

function toItem<F>(r: Row): StoredItem<F> {
  return { id: r.id, vaultId: r.vault_id, type: r.type, fields: JSON.parse(r.fields) as F, updatedAt: r.updated_at };
}
