import * as CM from '@radix-ui/react-context-menu';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowUp, File, Folder, FolderPlus, HardDrive, Link2, RefreshCw, Server } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileEntry } from '@chh/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PromptDialog } from '../../components/PromptDialog';
import { Button, IconButton, Input } from '../../components/ui';
import { cn } from '../../lib/cn';
import { formatBytes, formatDate, modeString } from '../../lib/format';
import { PermissionsDialog } from './PermissionsDialog';
import type { Pane } from './use-pane';

export const DRAG_TYPE = 'application/x-chh-files';
const ROW = 30;

const isDirLike = (e: FileEntry) => e.type === 'dir' || (e.type === 'symlink' && e.targetIsDir);
const menuItem = 'flex h-7 cursor-default items-center rounded px-2 text-[13px] outline-none data-[highlighted]:bg-surface-2 data-[disabled]:opacity-40';

export interface PaneDrop {
  fromSide: 'left' | 'right';
  paths: string[];
}

export function FilePane({
  pane,
  side,
  active,
  onActivate,
  onCopyToOther,
  onDrop,
  onDropOsFiles,
  onChangeSource,
}: {
  pane: Pane;
  side: 'left' | 'right';
  active: boolean;
  onActivate(): void;
  onCopyToOther(paths: string[]): void;
  /** Items dragged from either pane, dropped into `targetDir` of this pane. */
  onDrop(drop: PaneDrop, targetDir: string): void;
  onDropOsFiles(localPaths: string[], targetDir: string): void;
  onChangeSource(): void;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [anchor, setAnchor] = useState(0);
  const [pathInput, setPathInput] = useState(pane.path);
  const [renaming, setRenaming] = useState<FileEntry | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const [perms, setPerms] = useState<{ names: string[]; paths: string[]; mode: number; hasDir: boolean } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const entries = pane.entries;
  const showMode = entries.some((e) => e.mode !== null);
  const virtualizer = useVirtualizer({ count: entries.length, getScrollElement: () => listRef.current, estimateSize: () => ROW, overscan: 20 });

  useEffect(() => {
    setPathInput(pane.path);
    setSelected(new Set());
    setCursor(0);
    setAnchor(0);
    listRef.current?.scrollTo({ top: 0 });
  }, [pane.path, pane.endpoint]);

  // Keep selection valid after refreshes.
  useEffect(() => {
    const valid = new Set(entries.map((e) => e.path));
    setSelected((sel) => new Set([...sel].filter((p) => valid.has(p))));
    setCursor((c) => Math.min(c, Math.max(0, entries.length - 1)));
  }, [entries]);

  const selection = useMemo(() => entries.filter((e) => selected.has(e.path)), [entries, selected]);
  const targets = (e?: FileEntry): FileEntry[] => (e && !selected.has(e.path) ? [e] : selection.length ? selection : e ? [e] : []);

  const open = (e: FileEntry) => {
    if (isDirLike(e)) void pane.navigate(e.path);
  };

  const select = (i: number, ev: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    const e = entries[i];
    if (!e) return;
    setCursor(i);
    if (ev.shiftKey) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      setSelected(new Set(entries.slice(a, b + 1).map((x) => x.path)));
    } else if (ev.ctrlKey || ev.metaKey) {
      const next = new Set(selected);
      if (next.has(e.path)) next.delete(e.path);
      else next.add(e.path);
      setSelected(next);
      setAnchor(i);
    } else {
      setSelected(new Set([e.path]));
      setAnchor(i);
    }
  };

  const move = (i: number, shift: boolean) => {
    const n = Math.max(0, Math.min(entries.length - 1, i));
    select(n, { shiftKey: shift, ctrlKey: false, metaKey: false });
    virtualizer.scrollToIndex(n, { align: 'auto' });
  };

  const askPermissions = (list: FileEntry[]) => {
    if (!list.length || list[0]!.mode === null) return;
    setPerms({ names: list.map((x) => x.name), paths: list.map((x) => x.path), mode: list[0]!.mode ?? 0o644, hasDir: list.some((x) => x.type === 'dir') });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const cur = entries[cursor];
    const mod = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case 'ArrowDown':
        move(cursor + 1, e.shiftKey);
        break;
      case 'ArrowUp':
        move(cursor - 1, e.shiftKey);
        break;
      case 'Home':
        move(0, e.shiftKey);
        break;
      case 'End':
        move(entries.length - 1, e.shiftKey);
        break;
      case 'Enter':
        if (cur) open(cur);
        break;
      case 'Backspace':
        if (pane.parent !== null) void pane.navigate(pane.parent);
        break;
      case 'Delete':
        if (targets(cur).length) setDeleting(targets(cur).map((x) => x.path));
        break;
      case 'F2':
        if (cur) setRenaming(cur);
        break;
      case 'F5':
        if (targets(cur).length) onCopyToOther(targets(cur).map((x) => x.path));
        break;
      case 'F7':
        setCreating(true);
        break;
      case 'a':
      case 'A':
        if (!mod) return;
        setSelected(new Set(entries.map((x) => x.path)));
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // --- drag and drop ---------------------------------------------------------------------------

  const onDragStart = (e: React.DragEvent, entry: FileEntry) => {
    const paths = selected.has(entry.path) ? selection.map((x) => x.path) : [entry.path];
    if (!selected.has(entry.path)) setSelected(new Set([entry.path]));
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ fromSide: side, paths } satisfies PaneDrop));
    e.dataTransfer.effectAllowed = 'copyMove';
  };

  const acceptDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(DRAG_TYPE) || e.dataTransfer.types.includes('Files');

  const handleDrop = (e: React.DragEvent, targetDir: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (raw) {
      const drop = JSON.parse(raw) as PaneDrop;
      // Dropping onto itself is a no-op.
      if (drop.fromSide === side && drop.paths.includes(targetDir)) return;
      onDrop(drop, targetDir);
      return;
    }
    const files = [...e.dataTransfer.files].map((f) => window.chh.pathForFile(f)).filter(Boolean);
    if (files.length) onDropOsFiles(files, targetDir);
  };

  // --------------------------------------------------------------------------------------------

  const sourceLabel = pane.source.kind === 'local' ? t('files.thisComputer') : pane.source.label;
  const canWrite = pane.status === 'ready' && pane.path !== '';

  return (
    <section
      aria-label={sourceLabel}
      onMouseDown={onActivate}
      onFocus={onActivate}
      className={cn('flex min-w-0 flex-1 flex-col', active ? 'bg-bg' : 'bg-bg/60')}
      data-testid={`pane-${side}`}
    >
      <div className={cn('flex items-center gap-1.5 border-b px-2 py-1.5', active ? 'border-accent/60' : 'border-border')}>
        <Button variant="ghost" className="h-7 max-w-[40%] px-2" onClick={onChangeSource} title={t('files.changeLocation')} data-testid={`pane-${side}-source`}>
          {pane.source.kind === 'local' ? <HardDrive size={14} /> : <Server size={14} />}
          <span className="truncate">{sourceLabel}</span>
        </Button>
        <IconButton label={t('files.up')} disabled={pane.parent === null} onClick={() => pane.parent !== null && void pane.navigate(pane.parent)}>
          <ArrowUp size={14} />
        </IconButton>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            void pane.navigate(pathInput);
          }}
        >
          <Input
            className="h-7 font-mono text-[12px]"
            aria-label={t('files.path')}
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            disabled={pane.status !== 'ready'}
            data-testid={`pane-${side}-path`}
          />
        </form>
        <IconButton label={t('files.refresh')} onClick={() => void pane.refresh()}>
          <RefreshCw size={14} className={pane.loading ? 'animate-spin' : ''} />
        </IconButton>
        <IconButton label={t('files.newFolder')} disabled={!canWrite} onClick={() => setCreating(true)} data-testid={`pane-${side}-mkdir`}>
          <FolderPlus size={14} />
        </IconButton>
      </div>

      {pane.error && (
        <div role="alert" className="flex items-center gap-2 border-b border-border bg-warning-bg px-3 py-1.5 text-[12px] text-warning-fg">
          <span className="min-w-0 flex-1 truncate" title={pane.error.detail}>
            {t(pane.error.key, { defaultValue: t('errors.internal'), detail: pane.error.detail ?? '' })}
          </span>
          <button type="button" className="underline" onClick={pane.clearError}>
            {t('common.dismiss')}
          </button>
        </div>
      )}

      {pane.status === 'connecting' && <div className="flex flex-1 items-center justify-center text-muted">{t('session.connecting')}</div>}
      {(pane.status === 'error' || pane.status === 'closed') && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted">
          <p>{pane.status === 'closed' ? t('files.disconnected') : t('files.connectFailed')}</p>
          <Button variant="primary" onClick={() => void pane.connect(pane.source)}>
            {t('session.reconnect')}
          </Button>
        </div>
      )}

      {pane.status === 'ready' && (
        <CM.Root>
          <CM.Trigger asChild>
            <div
              ref={listRef}
              role="listbox"
              aria-multiselectable
              tabIndex={0}
              aria-label={t('files.listLabel', { location: sourceLabel })}
              onKeyDown={onKeyDown}
              onDragOver={(e) => {
                if (!acceptDrag(e) || !canWrite) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                if (dropTarget !== pane.path) setDropTarget(pane.path);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null);
              }}
              onDrop={(e) => canWrite && handleDrop(e, pane.path)}
              className={cn('min-h-0 flex-1 overflow-y-auto focus:outline-none', dropTarget === pane.path && 'ring-2 ring-inset ring-accent')}
              data-testid={`pane-${side}-list`}
            >
              <div className="sticky top-0 z-10 flex h-7 items-center gap-2 border-b border-border bg-surface px-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
                <span className="flex-1">{t('files.name')}</span>
                <span className="w-20 text-right">{t('files.size')}</span>
                <span className="hidden w-36 lg:block">{t('files.modified')}</span>
                {showMode && <span className="hidden w-24 xl:block">{t('files.permissions')}</span>}
              </div>
              {entries.length === 0 && <p className="p-6 text-center text-muted">{t('files.empty')}</p>}
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((row) => {
                  const e = entries[row.index]!;
                  const isSel = selected.has(e.path);
                  const dirLike = isDirLike(e);
                  return (
                    <div
                      key={e.path}
                      role="option"
                      aria-selected={isSel}
                      draggable={pane.path !== ''}
                      onDragStart={(ev) => onDragStart(ev, e)}
                      onDragOver={(ev) => {
                        if (!dirLike || !acceptDrag(ev)) return;
                        ev.preventDefault();
                        ev.stopPropagation();
                        if (dropTarget !== e.path) setDropTarget(e.path);
                      }}
                      onDrop={(ev) => dirLike && handleDrop(ev, e.path)}
                      onClick={(ev) => select(row.index, ev)}
                      onDoubleClick={() => open(e)}
                      onContextMenu={() => !isSel && select(row.index, { shiftKey: false, ctrlKey: false, metaKey: false })}
                      className={cn(
                        'absolute left-0 right-0 flex cursor-default items-center gap-2 px-3 text-[13px]',
                        isSel ? 'bg-accent/15' : 'hover:bg-surface-2/60',
                        row.index === cursor && 'outline outline-1 -outline-offset-1 outline-accent/40',
                        dropTarget === e.path && 'bg-accent/25',
                      )}
                      style={{ top: row.start, height: ROW }}
                      data-testid="file-row"
                      data-name={e.name}
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        {dirLike ? <Folder size={14} className="shrink-0 text-accent" /> : <File size={14} className="shrink-0 text-muted" />}
                        <span className="truncate">{e.name}</span>
                        {e.type === 'symlink' && <Link2 size={11} className="shrink-0 text-muted" aria-label={t('files.symlink')} />}
                      </span>
                      <span className="w-20 shrink-0 text-right text-[12px] text-muted">{dirLike ? '' : formatBytes(e.size)}</span>
                      <span className="hidden w-36 shrink-0 truncate text-[12px] text-muted lg:block">{formatDate(e.mtime)}</span>
                      {showMode && <span className="hidden w-24 shrink-0 font-mono text-[11px] text-muted xl:block">{modeString(e.mode)}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          </CM.Trigger>
          <CM.Portal>
            <CM.Content className="z-50 min-w-[200px] rounded-md border border-border bg-surface p-1 shadow-xl">
              <CM.Item className={menuItem} disabled={selection.length !== 1 || !isDirLike(selection[0]!)} onSelect={() => selection[0] && open(selection[0])}>
                {t('files.open')}
              </CM.Item>
              <CM.Item className={menuItem} disabled={!selection.length} onSelect={() => onCopyToOther(selection.map((x) => x.path))}>
                {t('files.copyToOther')} <span className="ml-auto pl-4 text-[11px] text-muted">F5</span>
              </CM.Item>
              <CM.Separator className="my-1 h-px bg-border" />
              <CM.Item className={menuItem} disabled={selection.length !== 1} onSelect={() => selection[0] && setRenaming(selection[0])}>
                {t('files.rename')} <span className="ml-auto pl-4 text-[11px] text-muted">F2</span>
              </CM.Item>
              <CM.Item className={menuItem} disabled={!selection.length || selection[0]!.mode === null} onSelect={() => askPermissions(selection)}>
                {t('files.permissions')}…
              </CM.Item>
              <CM.Item className={menuItem} disabled={!canWrite} onSelect={() => setCreating(true)}>
                {t('files.newFolder')} <span className="ml-auto pl-4 text-[11px] text-muted">F7</span>
              </CM.Item>
              <CM.Item className={menuItem} onSelect={() => void pane.refresh()}>
                {t('files.refresh')}
              </CM.Item>
              <CM.Separator className="my-1 h-px bg-border" />
              <CM.Item className={cn(menuItem, 'text-danger')} disabled={!selection.length} onSelect={() => setDeleting(selection.map((x) => x.path))}>
                {t('common.delete')} <span className="ml-auto pl-4 text-[11px] text-muted">Del</span>
              </CM.Item>
            </CM.Content>
          </CM.Portal>
        </CM.Root>
      )}

      <PromptDialog
        open={!!renaming}
        title={t('files.rename')}
        label={t('files.name')}
        initial={renaming?.name ?? ''}
        confirmLabel={t('files.rename')}
        onCancel={() => setRenaming(null)}
        onSubmit={(name) => {
          const from = renaming!.path;
          setRenaming(null);
          if (name !== renaming!.name) void pane.run((endpoint) => window.chh.sftp.rename({ endpoint, from, to: pane.join(name) }));
        }}
      />
      <PromptDialog
        open={creating}
        title={t('files.newFolder')}
        label={t('files.name')}
        confirmLabel={t('files.create')}
        testId="mkdir-dialog"
        onCancel={() => setCreating(false)}
        onSubmit={(name) => {
          setCreating(false);
          void pane.run((endpoint) => window.chh.sftp.mkdir({ endpoint, path: pane.join(name) }));
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        title={t('files.deleteTitle')}
        message={t('files.deleteMessage', { count: deleting?.length ?? 0 })}
        confirmLabel={t('common.delete')}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const paths = deleting!;
          setDeleting(null);
          void pane.run((endpoint) => window.chh.sftp.remove({ endpoint, paths }));
        }}
      />
      <PermissionsDialog
        target={perms}
        onCancel={() => setPerms(null)}
        onSubmit={(mode, recursive) => {
          const paths = perms!.paths;
          setPerms(null);
          void pane.run((endpoint) => window.chh.sftp.chmod({ endpoint, paths, mode, recursive }));
        }}
      />
    </section>
  );
}
