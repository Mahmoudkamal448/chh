import { randomUUID } from 'node:crypto';
import type { Sealed, TeamRole } from '@chh/shared';
import { deriveSubkey, memzero, openString, randomKey, sealString, unwrapKey, wrapKey } from '@chh/vault-crypto';
import type { Db } from '../db/database';

const WRAP_CONTEXT = 'cylocal_';

export interface TeamVaultInfo {
  id: string;
  teamId: string;
  name: string;
  role: TeamRole;
  keyGen: number;
}

export class ReadOnlyError extends Error {
  readonly code = 'read_only';
}

/**
 * The vault keys of this device: the personal vault and any team vaults. Secret fields
 * (passwords, private keys) are sealed with the key of the vault their item lives in, inside the
 * item JSON, on top of whole-database encryption. Vault keys are stored wrapped by a key derived
 * from the local database key.
 */
export class LocalVault {
  private readonly teams = new Map<string, { info: TeamVaultInfo; key: Buffer }>();

  private constructor(
    private vaultId: string,
    private vaultKey: Buffer,
    private readonly db: Db,
    private readonly wrapLocalKey: (key: Buffer, id: string) => Buffer,
    private readonly unwrapLocalKey: (wrapped: Buffer, id: string) => Buffer,
  ) {
    const rows = db.prepare(`SELECT id, team_id, name, role, key_gen, vault_key_enc FROM vaults WHERE kind = 'team'`).all() as Array<{
      id: string;
      team_id: string;
      name: string;
      role: TeamRole;
      key_gen: number;
      vault_key_enc: Buffer;
    }>;
    for (const r of rows) {
      this.teams.set(r.id, { info: { id: r.id, teamId: r.team_id, name: r.name, role: r.role, keyGen: r.key_gen }, key: unwrapLocalKey(r.vault_key_enc, r.id) });
    }
  }

  /** The personal vault id. */
  get id(): string {
    return this.vaultId;
  }

  /** The raw personal vault key, for the sync engine (main process only). */
  get key(): Buffer {
    return this.vaultKey;
  }

  static openOrCreate(db: Db, localKey: Buffer): LocalVault {
    const wrapping = deriveSubkey(localKey, 1, WRAP_CONTEXT);
    // Keep a copy of the wrapping key so vaults can be added or re-keyed later without the local key.
    const wrapCopy = Buffer.from(wrapping);
    memzero(wrapping);
    const wrapLocal = (key: Buffer, id: string) => wrapKey(key, wrapCopy, adFor(id));
    const unwrapLocal = (wrapped: Buffer, id: string) => unwrapKey(wrapped, wrapCopy, adFor(id));
    const row = db.prepare(`SELECT id, vault_key_enc FROM vaults WHERE kind = 'personal' LIMIT 1`).get() as
      | { id: string; vault_key_enc: Buffer }
      | undefined;
    if (row) return new LocalVault(row.id, unwrapLocal(row.vault_key_enc, row.id), db, wrapLocal, unwrapLocal);
    const id = randomUUID();
    const key = randomKey();
    db.prepare(`INSERT INTO vaults (id, kind, name, vault_key_enc) VALUES (?, 'personal', 'Personal', ?)`).run(id, wrapLocal(key, id));
    return new LocalVault(id, key, db, wrapLocal, unwrapLocal);
  }

  /**
   * Replaces the personal vault with another one (id + key) — used when this device joins an
   * existing sync account. Every local item moves into the new vault and its sealed secrets are
   * re-sealed for the new vault, in one transaction.
   */
  adopt(newId: string, newKey: Buffer): void {
    if (newId === this.vaultId && newKey.equals(this.vaultKey)) return;
    const oldId = this.vaultId;
    this.db.transaction(() => {
      // New vault row first (items reference it), then move items, then drop the old row.
      const old = this.db.prepare('SELECT kind, name FROM vaults WHERE id = ?').get(oldId) as { kind: string; name: string };
      this.db.prepare('DELETE FROM vaults WHERE id = ?').run(newId);
      this.db.prepare('INSERT INTO vaults (id, kind, name, vault_key_enc, sync_cursor) VALUES (?, ?, ?, ?, 0)').run(newId, old.kind, old.name, this.wrapLocalKey(newKey, newId));
      this.resealVault(oldId, this.vaultKey, newId, newKey);
      if (oldId !== newId) this.db.prepare('DELETE FROM vaults WHERE id = ?').run(oldId);
    })();
    memzero(this.vaultKey);
    this.vaultId = newId;
    this.vaultKey = Buffer.from(newKey);
  }

  // --- team vaults -----------------------------------------------------------------------------

  teamVaults(): TeamVaultInfo[] {
    return [...this.teams.values()].map((t) => ({ ...t.info }));
  }

  teamVault(id: string): TeamVaultInfo | null {
    const t = this.teams.get(id);
    return t ? { ...t.info } : null;
  }

  teamVaultByTeam(teamId: string): TeamVaultInfo | null {
    for (const t of this.teams.values()) if (t.info.teamId === teamId) return { ...t.info };
    return null;
  }

  /** The key of any vault this device holds (main process only). */
  keyFor(vaultId: string): Buffer {
    if (vaultId === this.vaultId) return this.vaultKey;
    const t = this.teams.get(vaultId);
    if (!t) throw new Error('unknown vault');
    return t.key;
  }

  has(vaultId: string): boolean {
    return vaultId === this.vaultId || this.teams.has(vaultId);
  }

  /** Viewers of a team vault can't change its items. */
  canWrite(vaultId: string): boolean {
    if (vaultId === this.vaultId) return true;
    const t = this.teams.get(vaultId);
    return !!t && t.info.role !== 'viewer';
  }

  /**
   * Adds a team vault or updates it. A different key (after a rotation) re-seals the vault's local
   * secrets and resets its sync cursor so everything is pulled again under the new key.
   */
  upsertTeamVault(info: TeamVaultInfo, key: Buffer): 'added' | 'rekeyed' | 'updated' | 'same' {
    const cur = this.teams.get(info.id);
    if (!cur) {
      this.db
        .prepare(`INSERT INTO vaults (id, kind, name, team_id, role, key_gen, vault_key_enc, sync_cursor) VALUES (?, 'team', ?, ?, ?, ?, ?, 0)`)
        .run(info.id, info.name, info.teamId, info.role, info.keyGen, this.wrapLocalKey(key, info.id));
      this.teams.set(info.id, { info: { ...info }, key: Buffer.from(key) });
      return 'added';
    }
    if (!cur.key.equals(key)) {
      this.db.transaction(() => {
        this.resealVault(info.id, cur.key, info.id, key);
        this.db
          .prepare('UPDATE vaults SET name = ?, role = ?, key_gen = ?, vault_key_enc = ?, sync_cursor = 0 WHERE id = ?')
          .run(info.name, info.role, info.keyGen, this.wrapLocalKey(key, info.id), info.id);
        // Every server revision changed with the rotation; pulling again re-establishes them.
        this.db.prepare('UPDATE items SET server_rev = NULL WHERE vault_id = ? AND dirty = 0').run(info.id);
      })();
      memzero(cur.key);
      this.teams.set(info.id, { info: { ...info }, key: Buffer.from(key) });
      return 'rekeyed';
    }
    const changed = cur.info.name !== info.name || cur.info.role !== info.role || cur.info.keyGen !== info.keyGen;
    if (!changed) return 'same';
    this.db.prepare('UPDATE vaults SET name = ?, role = ?, key_gen = ? WHERE id = ?').run(info.name, info.role, info.keyGen, info.id);
    cur.info = { ...info };
    return 'updated';
  }

  /** Forgets a team vault and every local copy of its items (left, removed, or signed out). */
  removeTeamVault(id: string): void {
    const t = this.teams.get(id);
    if (!t) return;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM items WHERE vault_id = ?').run(id);
      this.db.prepare('DELETE FROM vault_moves WHERE vault_id = ?').run(id);
      this.db.prepare('DELETE FROM audit_outbox WHERE vault_id = ?').run(id);
      this.db.prepare('DELETE FROM vaults WHERE id = ?').run(id);
    })();
    memzero(t.key);
    this.teams.delete(id);
  }

  /**
   * Moves one item's sealed fields from one vault to another (caller updates the row). Returns
   * the re-sealed fields.
   */
  resealFields(fields: Record<string, unknown>, itemId: string, fromVault: string, toVault: string): Record<string, unknown> {
    return resealFields(fields, itemId, fromVault, this.keyFor(fromVault), toVault, this.keyFor(toVault));
  }

  /** Seals device-local secrets (sync tokens, account key) that aren't items. */
  sealLocal(value: string, context: string): Sealed {
    return sealString(value, this.vaultKey, `cy/local/v1|${this.vaultId}|${context}`);
  }

  openLocal(sealed: Sealed, context: string): string {
    return openString(sealed, this.vaultKey, `cy/local/v1|${this.vaultId}|${context}`);
  }

  /** `context` binds the ciphertext to one item field (and vault) so it can't be moved elsewhere. */
  seal(value: string, context: SecretContext): Sealed {
    const vaultId = context.vaultId ?? this.vaultId;
    return sealString(value, this.keyFor(vaultId), secretAd(vaultId, context));
  }

  open(sealed: Sealed, context: SecretContext): string {
    const vaultId = context.vaultId ?? this.vaultId;
    return openString(sealed, this.keyFor(vaultId), secretAd(vaultId, context));
  }

  dispose(): void {
    memzero(this.vaultKey);
    for (const t of this.teams.values()) memzero(t.key);
    this.teams.clear();
  }

  /** Re-seals every item of `fromId` for (`toId`, `toKey`) and moves the rows there. */
  private resealVault(fromId: string, fromKey: Buffer, toId: string, toKey: Buffer): void {
    const rows = this.db.prepare('SELECT id, fields FROM items WHERE vault_id = ?').all(fromId) as Array<{ id: string; fields: string }>;
    const update = this.db.prepare('UPDATE items SET vault_id = ?, fields = ? WHERE id = ?');
    for (const r of rows) {
      const fields = resealFields(JSON.parse(r.fields), r.id, fromId, fromKey, toId, toKey);
      update.run(toId, JSON.stringify(fields), r.id);
    }
  }
}

export interface SecretContext {
  itemId: string;
  field: string;
  /** Defaults to the personal vault. */
  vaultId?: string;
}

/** Re-seals the top-level sealed fields of an item for another vault/key. */
export function resealFields(
  fields: Record<string, unknown>,
  itemId: string,
  fromVault: string,
  fromKey: Buffer,
  toVault: string,
  toKey: Buffer,
): Record<string, unknown> {
  const out = { ...fields };
  for (const [name, value] of Object.entries(out)) {
    if (!isSealed(value)) continue;
    const plain = openString(value, fromKey, secretAd(fromVault, { itemId, field: name }));
    out[name] = sealString(plain, toKey, secretAd(toVault, { itemId, field: name }));
  }
  return out;
}

const adFor = (vaultId: string) => `cy/vaultkey/v1|${vaultId}`;
const isSealed = (v: unknown): v is Sealed =>
  !!v && typeof v === 'object' && (v as Sealed).v === 1 && typeof (v as Sealed).n === 'string' && typeof (v as Sealed).c === 'string';
const secretAd = (vaultId: string, c: SecretContext) => `cy/secret/v1|${vaultId}|${c.itemId}|${c.field}`;
