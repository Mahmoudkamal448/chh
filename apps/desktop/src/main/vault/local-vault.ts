import { randomUUID } from 'node:crypto';
import type { Sealed } from '@chh/shared';
import { deriveSubkey, memzero, openString, randomKey, sealString, unwrapKey, wrapKey } from '@chh/vault-crypto';
import type { Db } from '../db/database';

const WRAP_CONTEXT = 'cylocal_';

/**
 * The personal vault and its key. Secret fields (passwords, later private keys) are sealed with
 * the vault key inside item JSON, on top of whole-database encryption. In Phase 4 the same vault
 * key is wrapped by the account key for sync, so items don't need re-encryption.
 */
export class LocalVault {
  private constructor(
    private vaultId: string,
    private vaultKey: Buffer,
    private readonly db: Db,
    private readonly wrapLocalKey: (key: Buffer, id: string) => Buffer,
  ) {}

  get id(): string {
    return this.vaultId;
  }

  /** The raw vault key, for the sync engine (main process only). */
  get key(): Buffer {
    return this.vaultKey;
  }

  static openOrCreate(db: Db, localKey: Buffer): LocalVault {
    const wrapping = deriveSubkey(localKey, 1, WRAP_CONTEXT);
    // Keep a copy of the wrapping key so the vault can be re-keyed later (adopt) without the local key.
    const wrapCopy = Buffer.from(wrapping);
    memzero(wrapping);
    const wrapLocal = (key: Buffer, id: string) => wrapKey(key, wrapCopy, adFor(id));
    const row = db.prepare(`SELECT id, vault_key_enc FROM vaults WHERE kind = 'personal' LIMIT 1`).get() as
      | { id: string; vault_key_enc: Buffer }
      | undefined;
    if (row) return new LocalVault(row.id, unwrapKey(row.vault_key_enc, wrapCopy, adFor(row.id)), db, wrapLocal);
    const id = randomUUID();
    const key = randomKey();
    db.prepare(`INSERT INTO vaults (id, kind, name, vault_key_enc) VALUES (?, 'personal', 'Personal', ?)`).run(id, wrapLocal(key, id));
    return new LocalVault(id, key, db, wrapLocal);
  }

  /**
   * Replaces the personal vault with another one (id + key) — used when this device joins an
   * existing sync account. Every local item moves into the new vault and its sealed secrets are
   * re-sealed for the new vault, in one transaction.
   */
  adopt(newId: string, newKey: Buffer): void {
    if (newId === this.vaultId && newKey.equals(this.vaultKey)) return;
    const oldId = this.vaultId;
    const rows = this.db.prepare('SELECT id, fields FROM items WHERE vault_id = ?').all(oldId) as Array<{ id: string; fields: string }>;
    const update = this.db.prepare('UPDATE items SET vault_id = ?, fields = ? WHERE id = ?');
    this.db.transaction(() => {
      // New vault row first (items reference it), then move items, then drop the old row.
      const old = this.db.prepare('SELECT kind, name FROM vaults WHERE id = ?').get(oldId) as { kind: string; name: string };
      this.db.prepare('DELETE FROM vaults WHERE id = ?').run(newId);
      this.db.prepare('INSERT INTO vaults (id, kind, name, vault_key_enc, sync_cursor) VALUES (?, ?, ?, ?, 0)').run(newId, old.kind, old.name, this.wrapLocalKey(newKey, newId));
      for (const r of rows) {
        const fields = JSON.parse(r.fields) as Record<string, unknown>;
        for (const [name, value] of Object.entries(fields)) {
          if (!isSealed(value)) continue;
          const plain = openString(value, this.vaultKey, secretAd(oldId, { itemId: r.id, field: name }));
          fields[name] = sealString(plain, newKey, secretAd(newId, { itemId: r.id, field: name }));
        }
        update.run(newId, JSON.stringify(fields), r.id);
      }
      if (oldId !== newId) this.db.prepare('DELETE FROM vaults WHERE id = ?').run(oldId);
    })();
    memzero(this.vaultKey);
    this.vaultId = newId;
    this.vaultKey = Buffer.from(newKey);
  }

  /** Seals device-local secrets (sync tokens, account key) that aren't items. */
  sealLocal(value: string, context: string): Sealed {
    return sealString(value, this.vaultKey, `cy/local/v1|${this.vaultId}|${context}`);
  }

  openLocal(sealed: Sealed, context: string): string {
    return openString(sealed, this.vaultKey, `cy/local/v1|${this.vaultId}|${context}`);
  }

  /** `context` binds the ciphertext to one item field so it can't be moved elsewhere. */
  seal(value: string, context: SecretContext): Sealed {
    return sealString(value, this.vaultKey, secretAd(this.id, context));
  }

  open(sealed: Sealed, context: SecretContext): string {
    return openString(sealed, this.vaultKey, secretAd(this.id, context));
  }

  dispose(): void {
    memzero(this.vaultKey);
  }
}

export interface SecretContext {
  itemId: string;
  field: string;
}

const adFor = (vaultId: string) => `cy/vaultkey/v1|${vaultId}`;
const isSealed = (v: unknown): v is Sealed =>
  !!v && typeof v === 'object' && (v as Sealed).v === 1 && typeof (v as Sealed).n === 'string' && typeof (v as Sealed).c === 'string';
const secretAd = (vaultId: string, c: SecretContext) => `cy/secret/v1|${vaultId}|${c.itemId}|${c.field}`;
