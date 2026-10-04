import {
  IdentityFieldsSchema,
  IdentityInputSchema,
  IdentityPatchSchema,
  type GroupFields,
  type HostFields,
  type Identity,
  type IdentityFields,
  type IdentityInput,
  type IdentityPatch,
} from '@chh/shared';
import type { LocalVault } from '../vault/local-vault';
import { ValidationError } from './groups-repo';
import { NotFoundError } from './hosts-repo';
import { uuidv7, type ItemStore, type StoredItem } from './item-store';

const PASSWORD_FIELD = 'password';

export class IdentitiesRepo {
  constructor(
    private readonly store: ItemStore,
    private readonly vault: LocalVault,
  ) {}

  list(): Identity[] {
    return this.store.query<IdentityFields>('identity').map(toIdentity);
  }

  get(id: string): Identity {
    return toIdentity(this.getStored(id));
  }

  create(input: IdentityInput): Identity {
    const data = IdentityInputSchema.parse(input);
    if (data.keyId) this.assertKey(data.keyId);
    const id = uuidv7();
    const vaultId = data.vaultId ?? this.store.vaultId;
    const fields = IdentityFieldsSchema.parse({
      label: data.label,
      username: data.username,
      keyId: data.keyId,
      password: data.password ? this.vault.seal(data.password, { itemId: id, field: PASSWORD_FIELD, vaultId }) : null,
    });
    return toIdentity(this.store.insert('identity', fields, id, vaultId));
  }

  update(id: string, input: IdentityPatch): Identity {
    const patch = IdentityPatchSchema.parse(input);
    if (patch.keyId) this.assertKey(patch.keyId);
    const { password, ...rest } = patch;
    const next: Partial<IdentityFields> = { ...rest };
    if (password === null) next.password = null;
    else if (typeof password === 'string') next.password = this.vault.seal(password, { itemId: id, field: PASSWORD_FIELD, vaultId: this.getStored(id).vaultId });
    const updated = this.store.update<IdentityFields>(id, 'identity', next);
    if (!updated) throw new NotFoundError();
    return toIdentity(updated);
  }

  /** Deletes identities and unlinks them from hosts and groups. */
  remove(ids: string[]): void {
    const gone = new Set(ids);
    this.store.transaction(() => {
      for (const type of ['host', 'group'] as const) {
        for (const item of this.store.query<HostFields | GroupFields>(type, `json_extract(fields, '$.settings.identityId') IS NOT NULL`)) {
          if (gone.has(item.fields.settings.identityId ?? '')) {
            this.store.update(item.id, type, { settings: { ...item.fields.settings, identityId: undefined } });
          }
        }
      }
      for (const id of ids) this.store.remove(id, 'identity');
    });
  }

  /** Main-process only. */
  getSecrets(id: string): { username: string; password: string | null; keyId: string | null } | null {
    const item = this.store.get<IdentityFields>(id, 'identity');
    if (!item) return null;
    const f = item.fields;
    return {
      username: f.username,
      password: f.password ? this.vault.open(f.password, { itemId: id, field: PASSWORD_FIELD, vaultId: item.vaultId }) : null,
      keyId: f.keyId,
    };
  }

  private assertKey(keyId: string): void {
    if (!this.store.get(keyId, 'key')) throw new ValidationError('key not found');
  }

  private getStored(id: string): StoredItem<IdentityFields> {
    const item = this.store.get<IdentityFields>(id, 'identity');
    if (!item) throw new NotFoundError();
    return item;
  }
}

function toIdentity(item: StoredItem<IdentityFields>): Identity {
  const { password, ...rest } = item.fields;
  return { ...rest, id: item.id, vaultId: item.vaultId, hasPassword: !!password, updatedAt: item.updatedAt };
}
