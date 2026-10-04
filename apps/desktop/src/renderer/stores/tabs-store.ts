import { create } from 'zustand';
import type { SessionStatus } from '@cy-ssh/shared';

export const HOSTS_TAB = 'hosts';

export interface SessionTab {
  id: string;
  kind: 'ssh' | 'local';
  sessionId: string;
  title: string;
  hostId: string | null;
  shellId?: string;
  status: SessionStatus;
  message?: string;
}

interface TabsState {
  tabs: SessionTab[];
  activeId: string;
  openSsh(hostId: string, title: string): Promise<void>;
  openLocal(shellId?: string): Promise<void>;
  close(id: string): void;
  activate(id: string): void;
  cycle(dir: 1 | -1): void;
  setStatus(sessionId: string, status: SessionStatus, message?: string): void;
  /** Opens a fresh session in an existing tab (same host or shell). */
  reconnect(tabId: string): Promise<void>;
}

/** Initial size; the terminal view resizes to fit as soon as it mounts. */
const INITIAL = { cols: 100, rows: 30 };

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: HOSTS_TAB,
  async openSsh(hostId, title) {
    const { sessionId } = await window.cy.sessions.openSsh({ hostId, ...INITIAL });
    const tab: SessionTab = { id: crypto.randomUUID(), kind: 'ssh', sessionId, title, hostId, status: 'connecting' };
    set({ tabs: [...get().tabs, tab], activeId: tab.id });
  },
  async openLocal(shellId) {
    const { sessionId, title } = await window.cy.sessions.openLocal({ shellId, ...INITIAL });
    const tab: SessionTab = { id: crypto.randomUUID(), kind: 'local', sessionId, title, hostId: null, shellId, status: 'connecting' };
    set({ tabs: [...get().tabs, tab], activeId: tab.id });
  },
  close(id) {
    const { tabs, activeId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    void window.cy.sessions.close({ sessionId: tabs[idx]!.sessionId });
    const next = tabs.filter((t) => t.id !== id);
    let nextActive = activeId;
    if (activeId === id) nextActive = next[Math.min(idx, next.length - 1)]?.id ?? HOSTS_TAB;
    set({ tabs: next, activeId: nextActive });
  },
  activate: (activeId) => set({ activeId }),
  cycle(dir) {
    const ids = [HOSTS_TAB, ...get().tabs.map((t) => t.id)];
    const i = ids.indexOf(get().activeId);
    set({ activeId: ids[(i + dir + ids.length) % ids.length]! });
  },
  async reconnect(tabId) {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    void window.cy.sessions.close({ sessionId: tab.sessionId });
    const { sessionId } =
      tab.kind === 'ssh' && tab.hostId
        ? await window.cy.sessions.openSsh({ hostId: tab.hostId, ...INITIAL })
        : await window.cy.sessions.openLocal({ shellId: tab.shellId, ...INITIAL });
    set({ tabs: get().tabs.map((t) => (t.id === tabId ? { ...t, sessionId, status: 'connecting', message: undefined } : t)) });
  },
  setStatus(sessionId, status, message) {
    set({ tabs: get().tabs.map((t) => (t.sessionId === sessionId ? { ...t, status, message } : t)) });
  },
}));
