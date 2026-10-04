import * as DM from '@radix-ui/react-context-menu';
import { Circle, Cloud, CloudOff, Columns2, FolderOpen, PlayCircle, Home, Lock, Plus, RefreshCw, Terminal as TermIcon, X } from 'lucide-react';
import { useApp } from '../../stores/app-store';
import { useSecurity } from '../../stores/lock-store';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalShell } from '@chh/shared';
import { IconButton } from '../../components/ui';
import { cn } from '../../lib/cn';
import { HOSTS_TAB, tabInfo, useTabs } from '../../stores/tabs-store';

const statusColor: Record<string, string> = {
  connecting: 'text-warning-fg',
  authenticating: 'text-warning-fg',
  ready: 'text-success',
  closed: 'text-muted',
  error: 'text-danger',
};

export function TabBar() {
  const { t } = useTranslation();
  const tabs = useTabs((s) => s.tabs);
  const panes = useTabs((s) => s.panes);
  const activeId = useTabs((s) => s.activeId);
  const activate = useTabs((s) => s.activate);
  const close = useTabs((s) => s.close);
  const openLocal = useTabs((s) => s.openLocal);
  const [shells, setShells] = useState<LocalShell[]>([]);
  const sync = useSecurity((s) => s.sync);
  const lockConfigured = useSecurity((s) => !!s.lock && (s.lock.settings.enabled || s.lock.masterPassword));
  const openSettings = useApp((s) => s.setSettingsOpen);

  useEffect(() => {
    void window.chh.sessions.localShells({}).then(setShells);
  }, []);

  const tabClass = (active: boolean) =>
    cn(
      'group flex h-full max-w-[220px] shrink-0 items-center gap-2 border-r border-border px-3 text-[13px]',
      active ? 'bg-bg text-fg shadow-[inset_0_-2px_0_var(--accent)]' : 'text-muted hover:bg-surface-2 hover:text-fg',
    );

  return (
    <div role="tablist" aria-label={t('tabs.label')} className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-surface">
      <button role="tab" aria-selected={activeId === HOSTS_TAB} className={tabClass(activeId === HOSTS_TAB)} onClick={() => activate(HOSTS_TAB)} data-testid="tab-hosts">
        <Home size={14} />
        {t('tabs.hosts')}
      </button>
      {tabs.map((tab) => {
        const info = tabInfo(tab, panes);
        return (
        <div key={tab.id} className={tabClass(tab.id === activeId)} data-testid="session-tab">
          <button
            role="tab"
            aria-selected={tab.id === activeId}
            className="flex min-w-0 items-center gap-2"
            onClick={() => activate(tab.id)}
            onAuxClick={(e) => e.button === 1 && close(tab.id)}
          >
            {tab.kind === 'run' ? (
              <PlayCircle size={13} className="shrink-0 text-muted" aria-label={t('tabs.run')} />
            ) : tab.kind === 'sftp' ? (
              <FolderOpen size={13} className="shrink-0 text-muted" aria-label={t('tabs.files')} />
            ) : (
              <Circle size={8} className={cn('shrink-0 fill-current', statusColor[info.status ?? 'closed'])} aria-label={t(`session.status.${info.status ?? 'closed'}`)} />
            )}
            <span className="truncate">{info.title}</span>
            {info.split && <Columns2 size={12} className="shrink-0 text-muted" aria-label={t('tabs.split')} />}
          </button>
          <IconButton label={t('tabs.close')} className="h-5 w-5 opacity-60 hover:opacity-100" onClick={() => close(tab.id)}>
            <X size={12} />
          </IconButton>
        </div>
        );
      })}
      <DM.Root>
        <DM.Trigger asChild>
          <button
            type="button"
            className="flex w-9 shrink-0 items-center justify-center text-muted hover:bg-surface-2 hover:text-fg"
            aria-label={t('tabs.newLocal')}
            title={t('tabs.newLocalHint')}
            onClick={() => void openLocal()}
            data-testid="new-local"
          >
            <Plus size={15} />
          </button>
        </DM.Trigger>
        <DM.Portal>
          <DM.Content className="z-50 min-w-[200px] rounded-md border border-border bg-surface p-1 shadow-xl">
            {shells.map((s) => (
              <DM.Item
                key={s.id}
                onSelect={() => void openLocal(s.id)}
                className="flex h-7 cursor-default items-center gap-2 rounded px-2 text-[13px] outline-none data-[highlighted]:bg-surface-2"
              >
                <TermIcon size={13} /> {s.label}
              </DM.Item>
            ))}
          </DM.Content>
        </DM.Portal>
      </DM.Root>
      <div className="ml-auto flex shrink-0 items-center gap-1 px-2">
        {lockConfigured && (
          <IconButton label={t('commands.app.lock')} onClick={() => void window.chh.lock.lockNow({})} data-testid="tabbar-lock">
            <Lock size={14} />
          </IconButton>
        )}
        <IconButton
          label={sync?.signedIn ? t(`sync.state.${sync.state}`) : t('sync.notSignedIn')}
          onClick={() => openSettings(true, 'sync')}
          data-testid="tabbar-sync"
          data-state={sync?.state ?? 'off'}
        >
          {!sync?.signedIn ? (
            <CloudOff size={14} />
          ) : sync.state === 'syncing' ? (
            <RefreshCw size={14} className="animate-spin" />
          ) : sync.state === 'error' || sync.state === 'offline' ? (
            <CloudOff size={14} className="text-danger" />
          ) : (
            <Cloud size={14} className="text-accent" />
          )}
        </IconButton>
      </div>
    </div>
  );
}
