import type { Host } from '@cy-ssh/shared';
import { COMMAND_IDS, effectiveKeymap, matches, type CommandId } from '../lib/keymap';
import { useApp } from '../stores/app-store';
import { useHosts } from '../stores/hosts-store';
import { HOSTS_TAB, useTabs } from '../stores/tabs-store';
import { HOST_SEARCH_ID } from '../features/hosts/HostsView';

export type Action = { type: 'command'; id: CommandId } | { type: 'connect'; host: Host } | { type: 'files'; host: Host };

export function runCommand(a: Action): void {
  const tabs = useTabs.getState();
  if (a.type === 'connect') {
    void tabs.openSsh(a.host.id, a.host.label);
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
      if (tabs.activeId !== HOSTS_TAB) tabs.close(tabs.activeId);
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
      window.dispatchEvent(new Event('cy:terminal-find'));
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
