import {
  HostFieldsSchema,
  HostInputSchema,
  HostPatchSchema,
  HostQuerySchema,
  type Host,
  type HostFields,
  type HostInput,
  type HostPatch,
  type HostQuery,
} from '@chh/shared';
import type { LocalVault } from '../vault/local-vault';
import type { GroupsRepo } from './groups-repo';
import { uuidv7, type ItemStore, type StoredItem } from './item-store';

export class NotFoundError extends Error {
  readonly code = 'not_found';
}

const PASSWORD_FIELD = 'password';

export class HostsRepo {
  constructor(
    private readonly store: ItemStore,
    private readonly vault: LocalVault,
    private readonly groups: GroupsRepo,
  ) {}

  list(q: HostQuery): { items: Host[]; total: number } {
    const query = HostQuerySchema.parse(q);
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.groupId === null) {
      where.push('group_id IS NULL');
    } else if (query.groupId !== undefined) {
      const ids = query.includeSubgroups ? this.groups.descendantIds(query.groupId) : [query.groupId];
      where.push(`group_id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    if (query.favoritesOnly) where.push('favorite = 1');
    if (query.vaultId) {
      where.push('vault_id = ?');
      params.push(query.vaultId);
    }
    if (query.tag) {
      where.push(`EXISTS (SELECT 1 FROM json_each(items.fields, '$.tags') WHERE value = ?)`);
      params.push(query.tag);
    }
    const text = query.query?.trim();
    if (text) {
      // Every whitespace-separated term must match label, address, username or a tag.
      for (const term of text.split(/\s+/).slice(0, 8)) {
        const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        where.push(`(label LIKE ? ESCAPE '\\' OR address LIKE ? ESCAPE '\\'
          OR json_extract(fields, '$.settings.username') LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM json_each(items.fields, '$.tags') WHERE value LIKE ? ESCAPE '\\'))`);
        params.push(like, like, like, like);
      }
    }
    const w = where.length ? where.join(' AND ') : '1';
    const items = this.store
      .query<HostFields>('host', w, params, 'favorite DESC, label COLLATE NOCASE, id', query.limit, query.offset)
      .map(toHost);
    const total = query.offset === 0 && items.length < query.limit ? items.length : this.store.count('host', w, params);
    return { items, total };
  }

  get(id: string): Host {
    return toHost(this.getStored(id));
  }

  create(input: HostInput): Host {
    const data = HostInputSchema.parse(input);
    if (data.groupId) this.groups.assertExists(data.groupId);
    const id = uuidv7();
    const vaultId = data.vaultId ?? this.store.vaultId;
    const fields: HostFields = HostFieldsSchema.parse({
      label: data.label,
      address: data.address,
      protocol: data.protocol,
      groupId: data.groupId,
      tags: dedupe(data.tags),
      favorite: data.favorite,
      notes: data.notes,
      osHint: null,
      settings: data.settings,
      password: data.password ? this.vault.seal(data.password, { itemId: id, field: PASSWORD_FIELD, vaultId }) : null,
      externalId: data.externalId ?? null,
    });
    return toHost(this.store.insert('host', fields, id, vaultId));
  }

  update(id: string, input: HostPatch): Host {
    const patch = HostPatchSchema.parse(input);
    if (patch.groupId) this.groups.assertExists(patch.groupId);
    const { password, ...rest } = patch;
    const next: Partial<HostFields> = { ...rest };
    if (rest.tags) next.tags = dedupe(rest.tags);
    if (password === null) next.password = null;
    else if (typeof password === 'string') next.password = this.vault.seal(password, { itemId: id, field: PASSWORD_FIELD, vaultId: this.getStored(id).vaultId });
    const updated = this.store.update<HostFields>(id, 'host', next);
    if (!updated) throw new NotFoundError();
    return toHost(updated);
  }

  duplicate(id: string): Host {
    const stored = this.getStored(id);
    const src = stored.fields;
    const password = this.getPassword(id);
    return this.create({
      label: `${src.label} (copy)`.slice(0, 200),
      address: src.address,
      protocol: src.protocol,
      groupId: src.groupId,
      tags: src.tags,
      favorite: false,
      notes: src.notes,
      settings: src.settings,
      password,
      vaultId: this.vault.canWrite(stored.vaultId) ? stored.vaultId : undefined,
    });
  }

  remove(ids: string[]): void {
    this.store.transaction(() => {
      for (const id of ids) this.store.remove(id, 'host');
    });
  }

  tags(): Array<{ tag: string; count: number }> {
    return this.store.db
      .prepare(
        `SELECT j.value AS tag, count(*) AS count FROM items, json_each(items.fields, '$.tags') AS j
         WHERE items.type = 'host' AND items.deleted = 0 GROUP BY j.value ORDER BY j.value COLLATE NOCASE`,
      )
      .all() as Array<{ tag: string; count: number }>;
  }

  /** Main-process only: decrypts the saved password for connecting. */
  getPassword(id: string): string | null {
    const item = this.getStored(id);
    return item.fields.password ? this.vault.open(item.fields.password, { itemId: id, field: PASSWORD_FIELD, vaultId: item.vaultId }) : null;
  }

  setPassword(id: string, password: string | null): void {
    this.update(id, { password });
  }

  /** Hosts imported from a cloud provider, by external id ("aws:i-…"). */
  byExternalId(): Map<string, string> {
    const out = new Map<string, string>();
    for (const item of this.store.query<HostFields>('host', `json_extract(fields, '$.externalId') IS NOT NULL`)) {
      out.set(item.fields.externalId!, item.id);
    }
    return out;
  }

  /** Updates fields that cloud imports manage (address/label/tags/os). */
  updateFromCloud(id: string, patch: { label: string; address: string; tags: string[]; osHint: string | null }): void {
    this.store.update<HostFields>(id, 'host', { ...patch, tags: dedupe(patch.tags) });
  }

  /** Records the detected operating system (shown as an icon in the host list). */
  setOsHint(id: string, os: string): void {
    const item = this.store.get<HostFields>(id, 'host');
    // Team viewers can't change shared hosts; the hint is cosmetic, so skip it.
    if (!item || item.fields.osHint === os.slice(0, 32) || !this.vault.canWrite(item.vaultId)) return;
    this.store.update<HostFields>(id, 'host', { osHint: os.slice(0, 32) });
  }

  getFields(id: string): HostFields {
    return this.getStored(id).fields;
  }

  /** Bulk insert for performance testing (test mode only). */
  seed(count: number): number {
    const groups = this.groups.list();
    this.store.transaction(() => {
      for (let i = 0; i < count; i++) {
        const n = String(i).padStart(5, '0');
        this.store.insert('host', {
          label: `seed-${n}`,
          address: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`,
          protocol: 'ssh',
          groupId: groups.length ? groups[i % groups.length]!.id : null,
          tags: [i % 3 === 0 ? 'prod' : 'dev', `rack-${i % 20}`],
          favorite: i % 97 === 0,
          notes: '',
          osHint: null,
          settings: {},
          password: null,
        } satisfies HostFields);
      }
    });
    return count;
  }

  private getStored(id: string): StoredItem<HostFields> {
    const item = this.store.get<HostFields>(id, 'host');
    if (!item) throw new NotFoundError();
    return item;
  }
}

function dedupe(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
}

function toHost(item: StoredItem<HostFields>): Host {
  const { password, ...rest } = item.fields;
  return { ...rest, id: item.id, vaultId: item.vaultId, hasPassword: !!password, updatedAt: item.updatedAt };
}
