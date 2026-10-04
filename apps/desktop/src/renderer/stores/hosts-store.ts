import { create } from 'zustand';
import type { Group, Host } from '@chh/shared';

/** Which slice of hosts the list shows. groupId: undefined = all, null = ungrouped. */
export interface HostFilter {
  query: string;
  groupId: string | null | undefined;
  tag: string | undefined;
  favoritesOnly: boolean;
}

export type EditorState =
  | { kind: 'host'; id: string | null; groupId?: string | null }
  | { kind: 'group'; id: string | null; parentId?: string | null }
  | null;

interface HostsState {
  hosts: Host[];
  total: number;
  groups: Group[];
  tags: Array<{ tag: string; count: number }>;
  filter: HostFilter;
  loading: boolean;
  editor: EditorState;
  setFilter(patch: Partial<HostFilter>): void;
  refresh(): Promise<void>;
  refreshMeta(): Promise<void>;
  openEditor(e: EditorState): void;
}

let seq = 0;

export const useHosts = create<HostsState>((set, get) => ({
  hosts: [],
  total: 0,
  groups: [],
  tags: [],
  filter: { query: '', groupId: undefined, tag: undefined, favoritesOnly: false },
  loading: false,
  editor: null,
  setFilter(patch) {
    set({ filter: { ...get().filter, ...patch } });
    void get().refresh();
  },
  async refresh() {
    const my = ++seq;
    const f = get().filter;
    set({ loading: true });
    const res = await window.chh.hosts.list({
      query: f.query || undefined,
      groupId: f.groupId,
      tag: f.tag,
      favoritesOnly: f.favoritesOnly || undefined,
    });
    // Ignore stale responses when the user types quickly.
    if (my === seq) set({ hosts: res.items, total: res.total, loading: false });
  },
  async refreshMeta() {
    const [groups, tags] = await Promise.all([window.chh.groups.list({}), window.chh.hosts.tags({})]);
    set({ groups, tags });
  },
  openEditor: (editor) => set({ editor }),
}));

export async function refreshAll(): Promise<void> {
  await Promise.all([useHosts.getState().refresh(), useHosts.getState().refreshMeta()]);
}
