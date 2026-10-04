import {
  GroupFieldsSchema,
  GroupInputSchema,
  GroupPatchSchema,
  type Group,
  type GroupFields,
  type GroupInput,
  type GroupLike,
  type GroupPatch,
  type HostFields,
} from '@chh/shared';
import type { ItemStore, StoredItem } from './item-store';

export class ValidationError extends Error {
  readonly code = 'validation';
}

export class GroupsRepo {
  constructor(private readonly store: ItemStore) {}

  list(): Group[] {
    return this.store.query<GroupFields>('group').map(toGroup);
  }

  map(): Map<string, GroupLike> {
    return new Map(this.list().map((g) => [g.id, g]));
  }

  assertExists(id: string): void {
    if (!this.store.get(id, 'group')) throw new ValidationError('group not found');
  }

  /** The group itself plus every group nested beneath it. */
  descendantIds(id: string): string[] {
    const children = new Map<string, string[]>();
    for (const g of this.list()) {
      if (!g.parentId) continue;
      const arr = children.get(g.parentId) ?? [];
      arr.push(g.id);
      children.set(g.parentId, arr);
    }
    const out: string[] = [];
    const stack = [id];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      out.push(cur);
      stack.push(...(children.get(cur) ?? []));
    }
    return out;
  }

  create(input: GroupInput): Group {
    const data = GroupInputSchema.parse(input);
    if (data.parentId) this.assertExists(data.parentId);
    return toGroup(this.store.insert('group', GroupFieldsSchema.parse(data)));
  }

  update(id: string, input: GroupPatch): Group {
    const patch = GroupPatchSchema.parse(input);
    if (patch.parentId) {
      this.assertExists(patch.parentId);
      if (this.descendantIds(id).includes(patch.parentId)) throw new ValidationError('group cycle');
    }
    const updated = this.store.update<GroupFields>(id, 'group', patch);
    if (!updated) throw new ValidationError('group not found');
    return toGroup(updated);
  }

  /** Deletes a group; its hosts and child groups move up to the group's parent. */
  remove(id: string): void {
    const g = this.store.get<GroupFields>(id, 'group');
    if (!g) return;
    const parent = g.fields.parentId;
    this.store.transaction(() => {
      for (const child of this.store.query<GroupFields>('group', 'parent_id = ?', [id])) {
        this.store.update<GroupFields>(child.id, 'group', { parentId: parent });
      }
      for (const host of this.store.query<HostFields>('host', 'group_id = ?', [id])) {
        this.store.update<HostFields>(host.id, 'host', { groupId: parent });
      }
      this.store.remove(id, 'group');
    });
  }
}

function toGroup(item: StoredItem<GroupFields>): Group {
  return { ...item.fields, id: item.id, updatedAt: item.updatedAt };
}
