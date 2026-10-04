import { ChevronRight, Folder, FolderPlus, Hash, Layers, Pencil, Star, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Group } from '@cy-ssh/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { IconButton } from '../../components/ui';
import { cn } from '../../lib/cn';
import { refreshAll, useHosts } from '../../stores/hosts-store';

interface TreeNode {
  group: Group;
  children: TreeNode[];
}

function buildTree(groups: Group[]): TreeNode[] {
  const byId = new Map(groups.map((g) => [g.id, { group: g, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.group.parentId ? byId.get(node.group.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

function NavItem({
  active,
  icon,
  label,
  count,
  depth = 0,
  onClick,
  actions,
  expander,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  count?: number;
  depth?: number;
  onClick(): void;
  actions?: React.ReactNode;
  expander?: React.ReactNode;
}) {
  return (
    <div
      className={cn('group flex h-7 items-center rounded-md pr-1 text-[13px]', active ? 'bg-surface-2 text-fg' : 'text-muted hover:bg-surface-2/70 hover:text-fg')}
      style={{ paddingLeft: 6 + depth * 14 }}
    >
      <span className="flex w-4 justify-center">{expander}</span>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onClick} aria-current={active ? 'true' : undefined}>
        {icon}
        <span className="truncate">{label}</span>
        {count !== undefined && <span className="ml-auto text-[11px] text-muted">{count}</span>}
      </button>
      {actions && <span className="hidden items-center group-focus-within:flex group-hover:flex">{actions}</span>}
    </div>
  );
}

export function Sidebar() {
  const { t } = useTranslation();
  const groups = useHosts((s) => s.groups);
  const tags = useHosts((s) => s.tags);
  const filter = useHosts((s) => s.filter);
  const setFilter = useHosts((s) => s.setFilter);
  const openEditor = useHosts((s) => s.openEditor);
  const tree = useMemo(() => buildTree(groups), [groups]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<Group | null>(null);

  const show = (patch: Partial<typeof filter>) =>
    setFilter({ groupId: undefined, tag: undefined, favoritesOnly: false, ...patch });

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const g = node.group;
    const isCollapsed = collapsed.has(g.id);
    return (
      <div key={g.id}>
        <NavItem
          depth={depth}
          active={filter.groupId === g.id}
          icon={<Folder size={14} />}
          label={g.label}
          onClick={() => show({ groupId: g.id })}
          expander={
            node.children.length > 0 && (
              <button
                type="button"
                aria-label={isCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
                aria-expanded={!isCollapsed}
                onClick={() => {
                  const next = new Set(collapsed);
                  if (isCollapsed) next.delete(g.id);
                  else next.add(g.id);
                  setCollapsed(next);
                }}
              >
                <ChevronRight size={12} className={cn('transition-transform', !isCollapsed && 'rotate-90')} />
              </button>
            )
          }
          actions={
            <>
              <IconButton label={t('sidebar.newSubgroup')} className="h-6 w-6" onClick={() => openEditor({ kind: 'group', id: null, parentId: g.id })}>
                <FolderPlus size={13} />
              </IconButton>
              <IconButton label={t('common.edit')} className="h-6 w-6" onClick={() => openEditor({ kind: 'group', id: g.id })}>
                <Pencil size={13} />
              </IconButton>
              <IconButton label={t('common.delete')} className="h-6 w-6" onClick={() => setDeleting(g)}>
                <Trash2 size={13} />
              </IconButton>
            </>
          }
        />
        {!isCollapsed && node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <nav aria-label={t('sidebar.label')} className="flex h-full w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-surface px-2 py-3">
      <div className="flex flex-col gap-0.5">
        <NavItem
          active={filter.groupId === undefined && !filter.tag && !filter.favoritesOnly}
          icon={<Layers size={14} />}
          label={t('sidebar.allHosts')}
          onClick={() => show({})}
        />
        <NavItem active={filter.favoritesOnly} icon={<Star size={14} />} label={t('sidebar.favorites')} onClick={() => show({ favoritesOnly: true })} />
      </div>

      <section>
        <div className="mb-1 flex items-center justify-between px-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted">{t('sidebar.groups')}</h2>
          <IconButton label={t('sidebar.newGroup')} className="h-6 w-6" onClick={() => openEditor({ kind: 'group', id: null })}>
            <FolderPlus size={14} />
          </IconButton>
        </div>
        <div className="flex flex-col gap-0.5">
          {tree.map((n) => renderNode(n, 0))}
          {groups.length > 0 && (
            <NavItem active={filter.groupId === null} icon={<Folder size={14} className="opacity-50" />} label={t('sidebar.ungrouped')} onClick={() => show({ groupId: null })} />
          )}
          {groups.length === 0 && <p className="px-2 text-[12px] text-muted">{t('sidebar.noGroups')}</p>}
        </div>
      </section>

      {tags.length > 0 && (
        <section>
          <h2 className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{t('sidebar.tags')}</h2>
          <div className="flex flex-col gap-0.5">
            {tags.map(({ tag, count }) => (
              <NavItem key={tag} active={filter.tag === tag} icon={<Hash size={14} />} label={tag} count={count} onClick={() => show({ tag })} />
            ))}
          </div>
        </section>
      )}

      <ConfirmDialog
        open={!!deleting}
        title={t('groups.deleteTitle')}
        message={t('groups.deleteMessage', { label: deleting?.label ?? '' })}
        confirmLabel={t('common.delete')}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          const g = deleting!;
          setDeleting(null);
          await window.cy.groups.remove({ id: g.id });
          if (filter.groupId === g.id) setFilter({ groupId: undefined });
          await refreshAll();
        }}
      />
    </nav>
  );
}
