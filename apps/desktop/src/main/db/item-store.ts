import { randomUUID } from 'node:crypto';
import { DELETED_FIELD, Hlc, applyLocalPatch, incrementVv, type Replica, type VersionVector } from '@chh/sync-core';
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

export class ReadOnlyItemError extends Error {
  readonly code = 'read_only';
}

/** Marks a tombstone left in a vault an item was moved out of. */
export const MOVED_FIELD = '_moved';

export class ItemStore {
  private readonly hlc: Hlc;
  private readonly listeners = new Set<(type: ItemType) => void>();
  private vaultIdValue: string;
  private canWrite: (vaultId: string) => boolean = () => true;

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

  /** Which vaults this device may change (team viewers are read-only). */
  setWritePolicy(fn: (vaultId: string) => boolean): void {
    this.canWrite = fn;
  }

  private assertWritable(vaultId: string): void {
    if (!this.canWrite(vaultId)) throw new ReadOnlyItemError();
  }

  /** Vault an item lives in (null if unknown). */
  vaultOf(id: string): string | null {
    const r = this.db.prepare('SELECT vault_id FROM items WHERE id = ?').get(id) as { vault_id: string } | undefined;
    return r?.vault_id ?? null;
  }

  /**
   * Moves an item to another vault: its sealed fields are re-sealed by `reseal`, it is uploaded
   * there as a new item, and a tombstone is queued for the old vault (if the server had it).
   */
  moveToVault(id: string, target: string, reseal: (fields: Record<string, unknown>, from: string) => Record<string, unknown>): boolean {
    const row = this.getSyncRow(id);
    if (!row || row.deleted || row.vaultId === target) return false;
    this.assertWritable(row.vaultId);
    this.assertWritable(target);
    const vv = incrementVv(row.vv, this.deviceId);
    const fields = reseal(row.fields, row.vaultId);
    this.db.transaction(() => {
      if (row.serverRev !== null) {
        this.db
          .prepare(
            `INSERT INTO vault_moves (vault_id, item_id, type, base_rev, vv) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(vault_id, item_id) DO UPDATE SET base_rev = excluded.base_rev, vv = excluded.vv, type = excluded.type`,
          )
          .run(row.vaultId, id, row.type, row.serverRev, JSON.stringify(vv));
      }
      // Moving back into a vault it was moved out of earlier: nothing to tombstone there any more.
      this.db.prepare('DELETE FROM vault_moves WHERE vault_id = ? AND item_id = ?').run(target, id);
      this.db
        .prepare('UPDATE items SET vault_id = ?, fields = ?, vv = ?, server_rev = NULL, dirty = 1, updated_at = ? WHERE id = ?')
        .run(target, JSON.stringify(fields), JSON.stringify(vv), Date.now(), id);
    })();
    this.changed(row.type);
    return true;
  }

  /** Tombstones waiting to be uploaded to vaults items were moved out of. */
  pendingMoves(vaultId: string): Array<{ itemId: string; type: ItemType; baseRev: number; vv: VersionVector }> {
    return (this.db.prepare('SELECT item_id, type, base_rev, vv FROM vault_moves WHERE vault_id = ?').all(vaultId) as Array<{ item_id: string; type: ItemType; base_rev: number; vv: string }>).map(
      (r) => ({ itemId: r.item_id, type: r.type, baseRev: r.base_rev, vv: JSON.parse(r.vv) }),
    );
  }

  /** The move tombstone was stored on the server (or a newer revision must be overwritten). */
  resolveMove(vaultId: string, itemId: string, nextBaseRev?: number): void {
    if (nextBaseRev === undefined) this.db.prepare('DELETE FROM vault_moves WHERE vault_id = ? AND item_id = ?').run(vaultId, itemId);
    else this.db.prepare('UPDATE vault_moves SET base_rev = ? WHERE vault_id = ? AND item_id = ?').run(nextBaseRev, vaultId, itemId);
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

  /** Records the server revision of an item without changing it (it stays dirty). */
  setServerRev(id: string, rev: number): void {
    this.db.prepare('UPDATE items SET server_rev = ? WHERE id = ?').run(rev, id);
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

  insert<F extends object>(type: ItemType, fields: F, id: string = uuidv7(), vaultId: string = this.vaultId): StoredItem<F> {
    this.assertWritable(vaultId);
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
    this.assertWritable(row.vault_id);
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
      .prepare('SELECT vault_id, clocks, vv FROM items WHERE id = ? AND type = ? AND deleted = 0')
      .get(id, type) as Pick<Row, 'vault_id' | 'clocks' | 'vv'> | undefined;
    if (!row) return false;
    this.assertWritable(row.vault_id);
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
