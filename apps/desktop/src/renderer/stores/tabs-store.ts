import { create } from 'zustand';
import type { SessionStatus } from '@chh/shared';
import { paneIds, removePane, setRatio, splitPane, type LayoutNode, type SplitDir } from './layout';

export const HOSTS_TAB = 'hosts';

export type PaneSource =
  | { kind: 'host'; hostId: string }
  | { kind: 'local'; shellId?: string }
  /** Quick connect: an unsaved user@host:port. */
  | { kind: 'quick'; host: string; port: number; username: string };

/** One terminal session shown in a pane. */
export interface TermPane {
  id: string;
  source: PaneSource;
  sessionId: string;
  title: string;
  status: SessionStatus;
  message?: string;
}

export interface TerminalTab {
  id: string;
  kind: 'terminal';
  root: LayoutNode;
  focusedPaneId: string;
}

export interface FilesTab {
  id: string;
  kind: 'sftp';
  hostId: string;
  title: string;
}

export interface RunTab {
  id: string;
  kind: 'run';
  runId: string;
  title: string;
}

export type Tab = TerminalTab | FilesTab | RunTab;

interface TabsState {
  tabs: Tab[];
  panes: Record<string, TermPane>;
  activeId: string;
  openHost(hostId: string, title: string): Promise<void>;
  openLocal(shellId?: string): Promise<void>;
  /** Quick connect to an unsaved host. */
  openQuick(target: { host: string; port: number; username: string }): Promise<void>;
  openSftp(hostId: string, title: string): void;
  /** Shows the results of a multi-host run. */
  openRun(runId: string, title: string): void;
  /** Splits the focused pane of the active tab, opening the same host/shell in the new pane. */
  splitFocused(dir: SplitDir): Promise<void>;
  /** Closes the focused pane if the tab is split, otherwise the tab. */
  closeFocused(): void;
  closePane(paneId: string): void;
  close(tabId: string): void;
  activate(id: string): void;
  focusPane(paneId: string): void;
  focusNeighbor(delta: 1 | -1): void;
  resize(tabId: string, splitId: string, ratio: number): void;
  cycle(dir: 1 | -1): void;
  setStatus(sessionId: string, status: SessionStatus, message?: string): void;
  reconnect(paneId: string): Promise<void>;
}

/** Initial size; the terminal view resizes to fit as soon as it mounts. */
const INITIAL = { cols: 100, rows: 30 };
const uid = () => crypto.randomUUID();

async function openSession(source: PaneSource, title: string): Promise<TermPane> {
  if (source.kind === 'host') {
    const { sessionId } = await window.chh.sessions.openHost({ hostId: source.hostId, ...INITIAL });
    return { id: uid(), source, sessionId, title, status: 'connecting' };
  }
  if (source.kind === 'quick') {
    const { sessionId } = await window.chh.sessions.openQuick({ host: source.host, port: source.port, username: source.username, ...INITIAL });
    return { id: uid(), source, sessionId, title, status: 'connecting' };
  }
  const res = await window.chh.sessions.openLocal({ shellId: source.shellId, ...INITIAL });
  return { id: uid(), source, sessionId: res.sessionId, title: res.title, status: 'connecting' };
}

export const useTabs = create<TabsState>((set, get) => {
  const addTab = (pane: TermPane) => {
    const tab: TerminalTab = { id: uid(), kind: 'terminal', root: { type: 'pane', paneId: pane.id }, focusedPaneId: pane.id };
    set({ tabs: [...get().tabs, tab], panes: { ...get().panes, [pane.id]: pane }, activeId: tab.id });
  };
  const tabOfPane = (paneId: string) =>
    get().tabs.find((t): t is TerminalTab => t.kind === 'terminal' && paneIds(t.root).includes(paneId));
  const updateTab = (tab: Tab) => set({ tabs: get().tabs.map((t) => (t.id === tab.id ? tab : t)) });
  const closeSession = (pane: TermPane | undefined) => pane && void window.chh.sessions.close({ sessionId: pane.sessionId });

  return {
    tabs: [],
    panes: {},
    activeId: HOSTS_TAB,

    async openHost(hostId, title) {
      addTab(await openSession({ kind: 'host', hostId }, title));
    },
    async openLocal(shellId) {
      addTab(await openSession({ kind: 'local', shellId }, ''));
    },
    async openQuick(target) {
      const title = `${target.username ? `${target.username}@` : ''}${target.host}${target.port !== 22 ? `:${target.port}` : ''}`;
      addTab(await openSession({ kind: 'quick', ...target }, title));
    },
    openRun(runId, title) {
      const tab: RunTab = { id: uid(), kind: 'run', runId, title };
      set({ tabs: [...get().tabs, tab], activeId: tab.id });
    },
    openSftp(hostId, title) {
      const tab: FilesTab = { id: uid(), kind: 'sftp', hostId, title };
      set({ tabs: [...get().tabs, tab], activeId: tab.id });
    },

    async splitFocused(dir) {
      const tab = get().tabs.find((t) => t.id === get().activeId);
      if (tab?.kind !== 'terminal') return;
      const focused = get().panes[tab.focusedPaneId];
      if (!focused) return;
      const pane = await openSession(focused.source, focused.title);
      const fresh = get().tabs.find((t) => t.id === tab.id);
      if (fresh?.kind !== 'terminal') return closeSession(pane);
      set({ panes: { ...get().panes, [pane.id]: pane } });
      updateTab({ ...fresh, root: splitPane(fresh.root, focused.id, pane.id, dir, uid()), focusedPaneId: pane.id });
    },

    closeFocused() {
      const tab = get().tabs.find((t) => t.id === get().activeId);
      if (!tab) return;
      if (tab.kind === 'terminal' && paneIds(tab.root).length > 1) get().closePane(tab.focusedPaneId);
      else get().close(tab.id);
    },

    closePane(paneId) {
      const tab = tabOfPane(paneId);
      if (!tab) return;
      const root = removePane(tab.root, paneId);
      closeSession(get().panes[paneId]);
      const { [paneId]: _gone, ...panes } = get().panes;
      set({ panes });
      if (!root) {
        get().close(tab.id);
        return;
      }
      const ids = paneIds(root);
      updateTab({ ...tab, root, focusedPaneId: ids.includes(tab.focusedPaneId) ? tab.focusedPaneId : ids[ids.length - 1]! });
    },

    close(tabId) {
      const { tabs, activeId } = get();
      const idx = tabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return;
      const tab = tabs[idx]!;
      const panes = { ...get().panes };
      if (tab.kind === 'terminal') {
        for (const id of paneIds(tab.root)) {
          closeSession(panes[id]);
          delete panes[id];
        }
      }
      const next = tabs.filter((t) => t.id !== tabId);
      let nextActive = activeId;
      if (activeId === tabId) nextActive = next[Math.min(idx, next.length - 1)]?.id ?? HOSTS_TAB;
      set({ tabs: next, panes, activeId: nextActive });
    },

    activate: (activeId) => set({ activeId }),

    focusPane(paneId) {
      const tab = tabOfPane(paneId);
      if (tab && tab.focusedPaneId !== paneId) updateTab({ ...tab, focusedPaneId: paneId });
    },

    focusNeighbor(delta) {
      const tab = get().tabs.find((t) => t.id === get().activeId);
      if (tab?.kind !== 'terminal') return;
      const ids = paneIds(tab.root);
      const i = ids.indexOf(tab.focusedPaneId);
      updateTab({ ...tab, focusedPaneId: ids[(i + delta + ids.length) % ids.length]! });
    },

    resize(tabId, splitId, ratio) {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (tab?.kind === 'terminal') updateTab({ ...tab, root: setRatio(tab.root, splitId, ratio) });
    },

    cycle(dir) {
      const ids = [HOSTS_TAB, ...get().tabs.map((t) => t.id)];
      const i = ids.indexOf(get().activeId);
      set({ activeId: ids[(i + dir + ids.length) % ids.length]! });
    },

    setStatus(sessionId, status, message) {
      const pane = Object.values(get().panes).find((p) => p.sessionId === sessionId);
      if (!pane) return;
      // A failed session is closed right after reporting why; keep the reason on screen.
      if (pane.status === 'error' && status === 'closed') return;
      set({ panes: { ...get().panes, [pane.id]: { ...pane, status, message } } });
    },

    async reconnect(paneId) {
      const pane = get().panes[paneId];
      if (!pane) return;
      closeSession(pane);
      const fresh = await openSession(pane.source, pane.title);
      if (!get().panes[paneId]) return closeSession(fresh);
      set({ panes: { ...get().panes, [paneId]: { ...pane, sessionId: fresh.sessionId, status: 'connecting', message: undefined } } });
    },
  };
});

/** Title and status shown on a tab: those of its focused pane. */
export function tabInfo(tab: Tab, panes: Record<string, TermPane>): { title: string; status: SessionStatus | null; split: boolean } {
  if (tab.kind === 'sftp' || tab.kind === 'run') return { title: tab.title, status: null, split: false };
  const p = panes[tab.focusedPaneId];
  return { title: p?.title ?? '', status: p?.status ?? null, split: paneIds(tab.root).length > 1 };
}
