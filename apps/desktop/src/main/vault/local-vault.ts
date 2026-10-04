import { randomUUID } from 'node:crypto';
import type { Sealed } from '@cy-ssh/shared';
import { deriveSubkey, memzero, openString, randomKey, sealString, unwrapKey, wrapKey } from '@cy-ssh/vault-crypto';
import type { Db } from '../db/database';

const WRAP_CONTEXT = 'cylocal_';

/**
 * The personal vault and its key. Secret fields (passwords, later private keys) are sealed with
 * the vault key inside item JSON, on top of whole-database encryption. In Phase 4 the same vault
 * key is wrapped by the account key for sync, so items don't need re-encryption.
 */
export class LocalVault {
  private constructor(
    readonly id: string,
    private readonly vaultKey: Buffer,
  ) {}

  static openOrCreate(db: Db, localKey: Buffer): LocalVault {
    const wrapping = deriveSubkey(localKey, 1, WRAP_CONTEXT);
    try {
      const row = db.prepare(`SELECT id, vault_key_enc FROM vaults WHERE kind = 'personal' LIMIT 1`).get() as
        | { id: string; vault_key_enc: Buffer }
        | undefined;
      if (row) return new LocalVault(row.id, unwrapKey(row.vault_key_enc, wrapping, adFor(row.id)));
      const id = randomUUID();
      const key = randomKey();
      db.prepare(`INSERT INTO vaults (id, kind, name, vault_key_enc) VALUES (?, 'personal', 'Personal', ?)`).run(
        id,
        wrapKey(key, wrapping, adFor(id)),
      );
      return new LocalVault(id, key);
    } finally {
      memzero(wrapping);
    }
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
const secretAd = (vaultId: string, c: SecretContext) => `cy/secret/v1|${vaultId}|${c.itemId}|${c.field}`;
