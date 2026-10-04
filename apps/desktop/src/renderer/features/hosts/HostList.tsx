import * as CM from '@radix-ui/react-context-menu';
import { useVirtualizer } from '@tanstack/react-virtual';
import { FolderOpen, KeyRound, Pencil, Star, TerminalSquare } from 'lucide-react';
import { OsBadge } from '../../components/OsBadge';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Host } from '@chh/shared';
import { cn } from '../../lib/cn';
import { VaultBadge } from '../teams/VaultBadge';
import { useTabs } from '../../stores/tabs-store';

const ROW_HEIGHT = 48;

const rowAction = 'flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-fg';
const kbd = 'ml-auto pl-6 font-sans text-[11px] text-muted';
const menuItem = 'flex h-7 cursor-default items-center rounded px-2 text-[13px] outline-none data-[highlighted]:bg-surface-2';

export function HostList({
  hosts,
  groupLabel,
  onConnect,
  onOpenFiles,
  onEdit,
  onDuplicate,
  onToggleFavorite,
  onDelete,
  onMove,
}: {
  hosts: Host[];
  groupLabel(id: string | null): string | null;
  onConnect(h: Host): void;
  onOpenFiles(h: Host): void;
  onEdit(h: Host): void;
  onDuplicate(h: Host): void;
  onToggleFavorite(h: Host): void;
  onDelete(h: Host): void;
  /** Absent when there's no other vault to move to. */
  onMove?(h: Host): void;
}) {
  const { t } = useTranslation();
  const parentRef = useRef<HTMLDivElement>(null);
  const panes = useTabs((s) => s.panes);
  // Hosts with an open terminal: connected beats connecting.
  const live = useMemo(() => {
    const m = new Map<string, 'connected' | 'connecting'>();
    for (const p of Object.values(panes)) {
      if (p.source.kind !== 'host') continue;
      if (p.status === 'ready') m.set(p.source.hostId, 'connected');
      else if ((p.status === 'connecting' || p.status === 'authenticating') && !m.has(p.source.hostId)) m.set(p.source.hostId, 'connecting');
    }
    return m;
  }, [panes]);
  const [active, setActive] = useState(0);
  const virtualizer = useVirtualizer({
    count: hosts.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  useEffect(() => {
    if (active >= hosts.length) setActive(Math.max(0, hosts.length - 1));
  }, [hosts.length, active]);

  const move = (to: number) => {
    const i = Math.max(0, Math.min(hosts.length - 1, to));
    setActive(i);
    virtualizer.scrollToIndex(i, { align: 'auto' });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const h = hosts[active];
    const page = Math.max(1, Math.floor((parentRef.current?.clientHeight ?? 400) / ROW_HEIGHT) - 1);
    switch (e.key) {
      case 'ArrowDown':
        move(active + 1);
        break;
      case 'ArrowUp':
        move(active - 1);
        break;
      case 'PageDown':
        move(active + page);
        break;
      case 'PageUp':
        move(active - page);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(hosts.length - 1);
        break;
      case 'Enter':
        if (h) onConnect(h);
        break;
      case 'Delete':
        if (h) onDelete(h);
        break;
      case 'F2':
        if (h) onEdit(h);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const activeHost = hosts[active];

  return (
    <div
      ref={parentRef}
      role="listbox"
      tabIndex={0}
      aria-label={t('hosts.listLabel')}
      aria-activedescendant={activeHost ? `host-${activeHost.id}` : undefined}
      data-testid="host-list"
      onKeyDown={onKeyDown}
      className="min-h-0 flex-1 overflow-y-auto focus:outline-none"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => {
          const h = hosts[row.index]!;
          const user = h.settings.username;
          const port = h.settings.port;
          const group = groupLabel(h.groupId);
          return (
            <CM.Root key={h.id}>
              <CM.Trigger asChild>
                <div
                  id={`host-${h.id}`}
                  role="option"
                  aria-selected={row.index === active}
                  data-testid="host-row"
                  onClick={() => setActive(row.index)}
                  onDoubleClick={() => onConnect(h)}
                  onContextMenu={() => setActive(row.index)}
                  className={cn(
                    'group absolute left-0 right-0 flex items-center gap-3 border-b border-border/60 px-4',
                    row.index === active ? 'bg-surface-2' : 'hover:bg-surface-2/60',
                  )}
                  style={{ top: row.start, height: ROW_HEIGHT }}
                >
                  <div className="relative shrink-0">
                    <OsBadge os={h.osHint} protocol={h.protocol} />
                    {live.has(h.id) && (
                      <span
                        className={cn('absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-surface', live.get(h.id) === 'connected' ? 'bg-success' : 'bg-warning-fg')}
                        title={t(live.get(h.id) === 'connected' ? 'hosts.statusConnected' : 'hosts.statusConnecting')}
                        aria-label={t(live.get(h.id) === 'connected' ? 'hosts.statusConnected' : 'hosts.statusConnecting')}
                        data-testid="host-live"
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{h.label}</span>
                      {h.favorite && <Star size={12} className="shrink-0 fill-current text-[#d29b00]" aria-label={t('hosts.favorite')} />}
                      {h.hasPassword && <KeyRound size={12} className="shrink-0 text-muted" aria-label={t('hosts.passwordSaved')} />}
                      <VaultBadge vaultId={h.vaultId} />
                    </div>
                    <div className="truncate text-[12px] text-muted">
                      {user ? `${user}@` : ''}
                      {h.address}
                      {port && port !== 22 ? `:${port}` : ''}
                      {group ? ` · ${group}` : ''}
                    </div>
                  </div>
                  <div className="hidden max-w-[40%] shrink gap-1 overflow-hidden group-focus-within:!hidden group-hover:!hidden md:flex">
                    {h.tags.slice(0, 4).map((tag) => (
                      <span key={tag} className="truncate rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">
                        {tag}
                      </span>
                    ))}
                  </div>
                  {/* Quick actions on hover (and for the selected row). */}
                  <div className="hidden shrink-0 items-center gap-1 group-focus-within:flex group-hover:flex" onDoubleClick={(e) => e.stopPropagation()}>
                    {h.protocol !== 'serial' && h.protocol !== 'telnet' && (
                      <button type="button" className={rowAction} title={t('hosts.openFiles')} aria-label={t('hosts.openFiles')} onClick={() => onOpenFiles(h)} data-testid="host-action-files">
                        <FolderOpen size={14} />
                      </button>
                    )}
                    <button type="button" className={rowAction} title={`${t('common.edit')} (F2)`} aria-label={t('common.edit')} onClick={() => onEdit(h)} data-testid="host-action-edit">
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[12px] font-medium text-accent-fg hover:opacity-90"
                      title={`${t('hosts.connect')} (Enter)`}
                      onClick={() => onConnect(h)}
                      data-testid="host-action-connect"
                    >
                      <TerminalSquare size={13} /> {t('hosts.connect')}
                    </button>
                  </div>
                </div>
              </CM.Trigger>
              <CM.Portal>
                <CM.Content className="z-50 min-w-[180px] rounded-md border border-border bg-surface p-1 shadow-xl">
                  <CM.Item className={menuItem} onSelect={() => onConnect(h)}>
                    {t('hosts.connect')}
                    <kbd className={kbd}>Enter</kbd>
                  </CM.Item>
                  <CM.Item className={menuItem} onSelect={() => onOpenFiles(h)} data-testid="host-open-files">
                    {t('hosts.openFiles')}
                  </CM.Item>
                  <CM.Item className={menuItem} onSelect={() => onEdit(h)}>
                    {t('common.edit')}
                    <kbd className={kbd}>F2</kbd>
                  </CM.Item>
                  <CM.Item className={menuItem} onSelect={() => onDuplicate(h)}>
                    {t('hosts.duplicate')}
                  </CM.Item>
                  <CM.Item className={menuItem} onSelect={() => onToggleFavorite(h)}>
                    {h.favorite ? t('hosts.unfavorite') : t('hosts.makeFavorite')}
                  </CM.Item>
                  {onMove && (
                    <CM.Item className={menuItem} onSelect={() => onMove(h)} data-testid="host-move">
                      {t('teams.move.menu')}
                    </CM.Item>
                  )}
                  <CM.Separator className="my-1 h-px bg-border" />
                  <CM.Item className={cn(menuItem, 'text-danger')} onSelect={() => onDelete(h)}>
                    {t('common.delete')}
                    <kbd className={kbd}>Del</kbd>
                  </CM.Item>
                </CM.Content>
              </CM.Portal>
            </CM.Root>
          );
        })}
      </div>
    </div>
  );
}
