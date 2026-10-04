import { useEffect } from 'react';
import { CommandPalette } from '../features/palette/CommandPalette';
import { GroupEditor } from '../features/hosts/GroupEditor';
import { HostEditor } from '../features/hosts/HostEditor';
import { HomeView } from '../features/home/HomeView';
import { Prompts } from '../features/prompts/Prompts';
import { SettingsDialog } from '../features/settings/SettingsDialog';
import { TabBar } from '../features/tabs/TabBar';
import { SftpView } from '../features/sftp/SftpView';
import { TerminalView } from '../features/terminal/TerminalView';
import { useVault } from '../stores/vault-store';
import { cn } from '../lib/cn';
import { useApp } from '../stores/app-store';
import { refreshAll } from '../stores/hosts-store';
import { usePrompts } from '../stores/prompts-store';
import { HOSTS_TAB, useTabs } from '../stores/tabs-store';
import { handleGlobalKey } from './commands';

export function App() {
  const theme = useApp((s) => s.resolvedTheme);
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    void refreshAll();
    void useVault.getState().refresh();
    const offs = [
      window.cy.on('hostkey.prompt', (data) => usePrompts.getState().push({ type: 'hostkey', data })),
      window.cy.on('auth.prompt', (data) => usePrompts.getState().push({ type: 'auth', data })),
      window.cy.on('prompt.dismiss', ({ promptId }) => usePrompts.getState().remove(promptId)),
      window.cy.on('session.status', ({ sessionId, status, message }) => useTabs.getState().setStatus(sessionId, status, message)),
      window.cy.on('data.changed', ({ kinds }) => {
        if (kinds.includes('hosts') || kinds.includes('groups')) void refreshAll();
      }),
    ];
    window.addEventListener('keydown', handleGlobalKey, true);
    return () => {
      offs.forEach((off) => off());
      window.removeEventListener('keydown', handleGlobalKey, true);
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <TabBar />
      <div className="relative min-h-0 flex-1">
        <div className={cn('absolute inset-0', activeId !== HOSTS_TAB && 'hidden')}>
          <HomeView />
        </div>
        {tabs.map((tab) => (
          <div key={tab.id} role="tabpanel" className={cn('absolute inset-0', activeId !== tab.id && 'hidden')}>
            {tab.kind === 'sftp' ? <SftpView hostId={tab.hostId!} hostLabel={tab.title} /> : <TerminalView tab={tab} active={activeId === tab.id} />}
          </div>
        ))}
      </div>
      <HostEditor />
      <GroupEditor />
      <SettingsDialog />
      <CommandPalette />
      <Prompts />
    </div>
  );
}
