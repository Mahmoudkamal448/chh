import * as DM from '@radix-ui/react-dropdown-menu';
import { ChevronDown, FolderPlus, Plus, Search } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Host } from '@chh/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Button, Input } from '../../components/ui';
import { refreshAll, useHosts } from '../../stores/hosts-store';
import { useTabs } from '../../stores/tabs-store';
import { CloudImportDialog } from '../cloud/CloudImportDialog';
import { SshImportDialog } from '../ssh-config/SshImportDialog';
import { MoveToVaultDialog, type MoveRequest } from '../teams/MoveToVaultDialog';
import { useTeams } from '../../stores/teams-store';
import { HostList } from './HostList';
import { Sidebar } from './Sidebar';
import { QuickConnect, Welcome } from './Welcome';

export const HOST_SEARCH_ID = 'host-search';

const menuItem = 'flex h-8 cursor-default items-center rounded px-2 text-[13px] outline-none data-[highlighted]:bg-surface-2';

export function HostsView() {
  const { t } = useTranslation();
  const hosts = useHosts((s) => s.hosts);
  const total = useHosts((s) => s.total);
  const groups = useHosts((s) => s.groups);
  const filter = useHosts((s) => s.filter);
  const setFilter = useHosts((s) => s.setFilter);
  const openEditor = useHosts((s) => s.openEditor);
  const openHost = useTabs((s) => s.openHost);
  const openSftp = useTabs((s) => s.openSftp);
  const [deleting, setDeleting] = useState<Host | null>(null);
  const [moving, setMoving] = useState<MoveRequest | null>(null);
  const canMove = useTeams((s) => s.vaults.length > 1);
  const [importing, setImporting] = useState<'default' | 'pick' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cloud, setCloud] = useState<'aws' | 'do' | null>(null);
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
    <div className="flex h-full min-h-0 min-w-0 flex-1">
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
          <DM.Root>
            <DM.Trigger asChild>
              <Button data-testid="ssh-config-menu">
                {t('hosts.importExport')} <ChevronDown size={12} />
              </Button>
            </DM.Trigger>
            <DM.Portal>
              <DM.Content align="end" className="z-50 min-w-[230px] rounded-md border border-border bg-surface p-1 shadow-xl">
                <DM.Item className={menuItem} onSelect={() => setImporting('default')} data-testid="ssh-import-default">
                  {t('sshConfig.importDefault')}
                </DM.Item>
                <DM.Item className={menuItem} onSelect={() => setImporting('pick')}>
                  {t('sshConfig.importFile')}
                </DM.Item>
                <DM.Item className={menuItem} onSelect={() => setCloud('aws')} data-testid="import-aws">
                  {t('cloud.menuAws')}
                </DM.Item>
                <DM.Item className={menuItem} onSelect={() => setCloud('do')} data-testid="import-do">
                  {t('cloud.menuDo')}
                </DM.Item>
                <DM.Separator className="my-1 h-px bg-border" />
                <DM.Item
                  className={menuItem}
                  onSelect={async () => {
                    const ids = hosts.map((h) => h.id);
                    const { saved } = await window.chh.sshConfig.exportFile({ hostIds: ids });
                    if (saved) setNotice(t('sshConfig.exported', { count: ids.length }));
                  }}
                >
                  {t('sshConfig.exportFile')}
                </DM.Item>
                <DM.Item
                  className={menuItem}
                  onSelect={async () => {
                    await navigator.clipboard.writeText(await window.chh.sshConfig.exportText({ hostIds: hosts.map((h) => h.id) }));
                    setNotice(t('sshConfig.copied', { count: hosts.length }));
                  }}
                  data-testid="ssh-export-copy"
                >
                  {t('sshConfig.exportCopy')}
                </DM.Item>
              </DM.Content>
            </DM.Portal>
          </DM.Root>
          <Button onClick={() => openEditor({ kind: 'group', id: null, parentId: currentGroup })}>
            <FolderPlus size={14} /> {t('sidebar.newGroup')}
          </Button>
          <Button variant="primary" onClick={() => openEditor({ kind: 'host', id: null, groupId: currentGroup })} data-testid="new-host">
            <Plus size={14} /> {t('hosts.new')}
          </Button>
        </div>

        <QuickConnect />
        {notice && (
          <p role="status" className="flex items-center border-b border-border bg-surface-2 px-4 py-1.5 text-[12px]">
            {notice}
            <button type="button" className="ml-auto underline" onClick={() => setNotice(null)}>
              {t('common.dismiss')}
            </button>
          </p>
        )}
        {hosts.length === 0 && total === 0 && !filter.query && filter.groupId === undefined && !filter.tag && !filter.favoritesOnly ? (
          <Welcome onNewHost={() => openEditor({ kind: 'host', id: null, groupId: null })} onImport={() => setImporting('default')} />
        ) : hosts.length === 0 ? (
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
            onConnect={(h) => void openHost(h.id, h.label)}
            onOpenFiles={(h) => openSftp(h.id, h.label)}
            onEdit={(h) => openEditor({ kind: 'host', id: h.id })}
            onDuplicate={async (h) => {
              await window.chh.hosts.duplicate({ id: h.id });
              await refreshAll();
            }}
            onToggleFavorite={async (h) => {
              await window.chh.hosts.update({ id: h.id, patch: { favorite: !h.favorite } });
              await refreshAll();
            }}
            onDelete={(h) => setDeleting(h)}
            onMove={canMove ? (h) => setMoving({ kind: 'host', ids: [h.id], label: h.label, vaultId: h.vaultId }) : undefined}
          />
        )}
      </main>

      <MoveToVaultDialog request={moving} onClose={() => setMoving(null)} onMoved={() => void refreshAll()} />
      <CloudImportDialog provider={cloud} onClose={() => setCloud(null)} />
      <SshImportDialog open={!!importing} pickFile={importing === 'pick'} onClose={() => setImporting(null)} />
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
          await window.chh.hosts.remove({ ids: [h.id] });
          await refreshAll();
        }}
      />
    </div>
  );
}
