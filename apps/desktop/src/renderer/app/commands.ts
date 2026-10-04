import type { Host, Snippet } from '@chh/shared';
import { needsVariables, runSnippet } from '../features/snippets/run-snippet';
import { COMMAND_IDS, effectiveKeymap, matches, type CommandId } from '../lib/keymap';
import { useApp } from '../stores/app-store';
import { useSecurity } from '../stores/lock-store';
import { useHosts } from '../stores/hosts-store';
import { HOSTS_TAB, useTabs } from '../stores/tabs-store';
import { HOST_SEARCH_ID } from '../features/hosts/HostsView';

export type Action =
  | { type: 'command'; id: CommandId }
  | { type: 'connect'; host: Host }
  | { type: 'files'; host: Host }
  | { type: 'snippet'; snippet: Snippet };

/**
 * The focused pane of the active terminal tab. With `fallback`, uses the most recently opened
 * terminal tab when the active tab isn't a terminal (e.g. running a snippet from the home screen).
 */
export function activePaneId(fallback = false): string | null {
  const { tabs, activeId } = useTabs.getState();
  const active = tabs.find((t) => t.id === activeId);
  if (active?.kind === 'terminal') return active.focusedPaneId;
  if (!fallback) return null;
  const last = [...tabs].reverse().find((t) => t.kind === 'terminal');
  return last?.kind === 'terminal' ? last.focusedPaneId : null;
}

export function runCommand(a: Action): void {
  const tabs = useTabs.getState();
  if (a.type === 'connect') {
    void tabs.openHost(a.host.id, a.host.label);
    return;
  }
  if (a.type === 'snippet') {
    const pane = activePaneId(true);
    if (!pane) return;
    // Snippets with {{variables}} are run from the Snippets screen or side panel, which ask for values.
    if (needsVariables(a.snippet).length) {
      tabs.activate(HOSTS_TAB);
      useApp.getState().setSection('snippets');
      return;
    }
    runSnippet(pane, a.snippet);
    return;
  }
  if (a.type === 'files') {
    tabs.openSftp(a.host.id, a.host.label);
    return;
  }
  switch (a.id) {
    case 'palette.open':
      useApp.getState().setPaletteOpen(true);
      break;
    case 'tab.newLocal':
      void tabs.openLocal();
      break;
    case 'tab.close':
      if (tabs.activeId !== HOSTS_TAB) tabs.closeFocused();
      break;
    case 'pane.splitRight':
      void tabs.splitFocused('row');
      break;
    case 'pane.splitDown':
      void tabs.splitFocused('column');
      break;
    case 'pane.focusNext':
      tabs.focusNeighbor(1);
      break;
    case 'pane.focusPrev':
      tabs.focusNeighbor(-1);
      break;
    case 'app.lock':
      void window.chh.lock.lockNow({});
      break;
    case 'panel.toggle':
      window.dispatchEvent(new Event('chh:toggle-panel'));
      break;
    case 'tab.next':
      tabs.cycle(1);
      break;
    case 'tab.prev':
      tabs.cycle(-1);
      break;
    case 'tab.hosts':
      tabs.activate(HOSTS_TAB);
      break;
    case 'host.new':
      tabs.activate(HOSTS_TAB);
      useApp.getState().setSection('hosts');
      useHosts.getState().openEditor({ kind: 'host', id: null });
      break;
    case 'hosts.search':
      tabs.activate(HOSTS_TAB);
      useApp.getState().setSection('hosts');
      requestAnimationFrame(() => document.getElementById(HOST_SEARCH_ID)?.focus());
      break;
    case 'terminal.find':
      window.dispatchEvent(new Event('chh:terminal-find'));
      break;
    case 'settings.open':
      useApp.getState().setSettingsOpen(true);
      break;
    case 'terminal.copy':
    case 'terminal.paste':
      // Handled inside the terminal's key handler.
      break;
  }
}

/** Global keydown handler (capture phase). */
export function handleGlobalKey(e: KeyboardEvent): void {
  // Nothing but the lock screen reacts to keys while locked.
  if (useSecurity.getState().lock?.locked !== 'no') return;
  if (useApp.getState().settingsOpen && (e.target as HTMLElement)?.dataset?.recording === 'true') return;
  const km = effectiveKeymap(useApp.getState().settings.keymap);
  const onHostsTab = useTabs.getState().activeId === HOSTS_TAB;
  for (const id of COMMAND_IDS) {
    if (id === 'terminal.copy' || id === 'terminal.paste') continue;
    // The same keys mean "search hosts" on the hosts tab and "find in terminal" elsewhere.
    if (id === 'hosts.search' && !onHostsTab) continue;
    if (id === 'terminal.find' && onHostsTab) continue;
    if (matches(e, km[id])) {
      e.preventDefault();
      e.stopPropagation();
      runCommand({ type: 'command', id });
      return;
    }
  }
}
