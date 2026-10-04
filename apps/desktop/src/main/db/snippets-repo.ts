import { SnippetFieldsSchema, SnippetInputSchema, SnippetPatchSchema, type Snippet, type SnippetFields, type SnippetInput, type SnippetPatch } from '@chh/shared';
import { NotFoundError } from './hosts-repo';
import type { ItemStore, StoredItem } from './item-store';

export class SnippetsRepo {
  constructor(private readonly store: ItemStore) {}

  list(): Snippet[] {
    return this.store.query<SnippetFields>('snippet').map(toSnippet);
  }

  create(input: SnippetInput): Snippet {
    const data = SnippetFieldsSchema.parse(SnippetInputSchema.parse(input));
    return toSnippet(this.store.insert('snippet', { ...data, tags: [...new Set(data.tags)] }));
  }

  update(id: string, input: SnippetPatch): Snippet {
    const patch = SnippetPatchSchema.parse(input);
    const updated = this.store.update<SnippetFields>(id, 'snippet', patch.tags ? { ...patch, tags: [...new Set(patch.tags)] } : patch);
    if (!updated) throw new NotFoundError();
    return toSnippet(updated);
  }

  remove(ids: string[]): void {
    this.store.transaction(() => {
      for (const id of ids) this.store.remove(id, 'snippet');
    });
  }
}

function toSnippet(item: StoredItem<SnippetFields>): Snippet {
  return { ...item.fields, id: item.id, updatedAt: item.updatedAt };
}
