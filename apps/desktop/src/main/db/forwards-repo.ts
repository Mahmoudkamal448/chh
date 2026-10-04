import { ForwardFieldsSchema, ForwardInputSchema, ForwardPatchSchema, type Forward, type ForwardFields, type ForwardInput, type ForwardPatch } from '@cy-ssh/shared';
import { ValidationError } from './groups-repo';
import { NotFoundError } from './hosts-repo';
import type { ItemStore, StoredItem } from './item-store';

export class ForwardsRepo {
  constructor(private readonly store: ItemStore) {}

  list(): Forward[] {
    return this.store.query<ForwardFields>('forward').map(toForward);
  }

  get(id: string): Forward {
    const item = this.store.get<ForwardFields>(id, 'forward');
    if (!item) throw new NotFoundError();
    return toForward(item);
  }

  create(input: ForwardInput): Forward {
    const data = ForwardFieldsSchema.parse(normalize(ForwardInputSchema.parse(input)));
    this.assertHost(data.hostId);
    return toForward(this.store.insert('forward', data));
  }

  update(id: string, input: ForwardPatch): Forward {
    const patch = ForwardPatchSchema.parse(input);
    const { id: _id, updatedAt: _updatedAt, ...current } = this.get(id);
    const fields = ForwardFieldsSchema.parse(normalize({ ...current, ...patch }));
    if (patch.hostId) this.assertHost(patch.hostId);
    const updated = this.store.update<ForwardFields>(id, 'forward', fields);
    if (!updated) throw new NotFoundError();
    return toForward(updated);
  }

  remove(ids: string[]): void {
    this.store.transaction(() => {
      for (const id of ids) this.store.remove(id, 'forward');
    });
  }

  /** Forward ids belonging to the given hosts (removed along with them). */
  idsForHosts(hostIds: string[]): string[] {
    const set = new Set(hostIds);
    return this.list().filter((f) => set.has(f.hostId)).map((f) => f.id);
  }

  private assertHost(hostId: string): void {
    if (!this.store.get(hostId, 'host')) throw new ValidationError('host not found');
  }
}

/** Dynamic forwards have no destination. */
function normalize<T extends { kind: string; destHost?: string | null; destPort?: number | null }>(f: T): T {
  return f.kind === 'dynamic' ? { ...f, destHost: null, destPort: null } : f;
}

function toForward(item: StoredItem<ForwardFields>): Forward {
  return { ...item.fields, id: item.id, updatedAt: item.updatedAt };
}
