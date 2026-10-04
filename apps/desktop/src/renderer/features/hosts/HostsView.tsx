import { FolderPlus, Plus, Search } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Host } from '@cy-ssh/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Button, Input } from '../../components/ui';
import { refreshAll, useHosts } from '../../stores/hosts-store';
import { useTabs } from '../../stores/tabs-store';
import { HostList } from './HostList';
import { Sidebar } from './Sidebar';

export const HOST_SEARCH_ID = 'host-search';

export function HostsView() {
  const { t } = useTranslation();
  const hosts = useHosts((s) => s.hosts);
  const total = useHosts((s) => s.total);
  const groups = useHosts((s) => s.groups);
  const filter = useHosts((s) => s.filter);
  const setFilter = useHosts((s) => s.setFilter);
  const openEditor = useHosts((s) => s.openEditor);
  const openSsh = useTabs((s) => s.openSsh);
  const [deleting, setDeleting] = useState<Host | null>(null);
  const [query, setQuery] = useState(filter.query);
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);

  const groupLabels = useMemo(() => new Map(groups.map((g) => [g.id, g.label])), [groups]);
  const currentGroup = typeof filter.groupId === 'string' ? filter.groupId : null;

  const onSearch = (v: string) => {
    setQuery(v);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setFilter({ query: v }), 120);
  };

  const title =
    filter.favoritesOnly
      ? t('sidebar.favorites')
      : filter.tag
        ? `#${filter.tag}`
        : filter.groupId === null
          ? t('sidebar.ungrouped')
          : filter.groupId
            ? (groupLabels.get(filter.groupId) ?? '')
            : t('sidebar.allHosts');

  return (
    <div className="flex h-full min-h-0">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <h1 className="mr-2 truncate text-[15px] font-semibold">{title}</h1>
          <span className="text-[12px] text-muted" aria-live="polite">
            {t('hosts.count', { count: total })}
          </span>
          <div className="relative ml-auto w-72 max-w-[40%]">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <Input
              id={HOST_SEARCH_ID}
              type="search"
              className="pl-8"
              placeholder={t('hosts.searchPlaceholder')}
              aria-label={t('hosts.searchPlaceholder')}
              value={query}
              onChange={(e) => onSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  document.querySelector<HTMLElement>('[data-testid="host-list"]')?.focus();
                }
              }}
              data-testid="host-search"
            />
          </div>
          <Button onClick={() => openEditor({ kind: 'group', id: null, parentId: currentGroup })}>
            <FolderPlus size={14} /> {t('sidebar.newGroup')}
          </Button>
          <Button variant="primary" onClick={() => openEditor({ kind: 'host', id: null, groupId: currentGroup })} data-testid="new-host">
            <Plus size={14} /> {t('hosts.new')}
          </Button>
        </div>

        {hosts.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted">
            <p>{filter.query || filter.groupId !== undefined || filter.tag || filter.favoritesOnly ? t('hosts.noMatches') : t('hosts.empty')}</p>
            {!filter.query && (
              <Button variant="primary" onClick={() => openEditor({ kind: 'host', id: null, groupId: currentGroup })}>
                <Plus size={14} /> {t('hosts.new')}
              </Button>
            )}
          </div>
        ) : (
          <HostList
            hosts={hosts}
            groupLabel={(id) => (id ? (groupLabels.get(id) ?? null) : null)}
            onConnect={(h) => void openSsh(h.id, h.label)}
            onEdit={(h) => openEditor({ kind: 'host', id: h.id })}
            onDuplicate={async (h) => {
              await window.cy.hosts.duplicate({ id: h.id });
              await refreshAll();
            }}
            onToggleFavorite={async (h) => {
              await window.cy.hosts.update({ id: h.id, patch: { favorite: !h.favorite } });
              await refreshAll();
            }}
            onDelete={(h) => setDeleting(h)}
          />
        )}
      </main>

      <ConfirmDialog
        open={!!deleting}
        title={t('hosts.deleteTitle')}
        message={t('hosts.deleteMessage', { label: deleting?.label ?? '' })}
        confirmLabel={t('common.delete')}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          const h = deleting!;
          setDeleting(null);
          await window.cy.hosts.remove({ ids: [h.id] });
          await refreshAll();
        }}
      />
    </div>
  );
}
