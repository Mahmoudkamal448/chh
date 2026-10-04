import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConflictPolicy, Host, Transfer } from '@chh/shared';
import { Button, IconButton } from '../../components/ui';
import { cn } from '../../lib/cn';
import { formatBytes } from '../../lib/format';
import { useTransfers } from '../../stores/transfers-store';
import { ConflictDialog } from './ConflictDialog';
import { FilePane, type PaneDrop } from './FilePane';
import { HostPicker } from './HostPicker';
import { usePane, type Pane } from './use-pane';

const finished = (t: Transfer) => t.state === 'done' || t.state === 'cancelled' || t.state === 'error';

function TransferRow({ t }: { t: Transfer }) {
  const { t: tr } = useTranslation();
  const pct = t.totalBytes ? Math.round((t.doneBytes / t.totalBytes) * 100) : t.state === 'done' ? 100 : 0;
  const err = t.error?.split('::');
  return (
    <li className="flex items-center gap-3 px-3 py-1.5 text-[12px]" data-testid="transfer-row" data-state={t.state}>
      {t.src.endpoint === 'local' ? <ArrowUp size={13} className="shrink-0 text-muted" aria-label={tr('files.upload')} /> : <ArrowDown size={13} className="shrink-0 text-muted" aria-label={tr('files.download')} />}
      <span className="w-48 shrink-0 truncate" title={t.src.path}>
        {t.name}
      </span>
      <div className="h-1.5 min-w-16 flex-1 overflow-hidden rounded bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t.name}>
        <div className={cn('h-full transition-[width]', t.state === 'error' ? 'bg-danger' : 'bg-accent')} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-56 shrink-0 truncate text-right text-muted" title={err?.[1]}>
        {t.state === 'running' && `${formatBytes(t.doneBytes)} / ${formatBytes(t.totalBytes)}${t.rate ? ` · ${formatBytes(t.rate)}/s` : ''}`}
        {t.state === 'queued' && tr('files.state.queued')}
        {t.state === 'done' && tr('files.state.done', { count: t.files, size: formatBytes(t.totalBytes) })}
        {t.state === 'cancelled' && tr('files.state.cancelled')}
        {t.state === 'error' && tr(err?.[0] ?? 'errors.internal', { defaultValue: tr('errors.internal'), detail: err?.[1] ?? '' })}
      </span>
      {!finished(t) ? (
        <IconButton label={tr('files.cancelTransfer')} className="h-6 w-6" onClick={() => void window.chh.sftp.cancelTransfer({ id: t.id })}>
          <X size={12} />
        </IconButton>
      ) : (
        <span className="w-6" />
      )}
    </li>
  );
}

/** Dual-pane file browser: each side is this computer or any host. */
export function SftpView({ hostId, hostLabel }: { hostId: string; hostLabel: string }) {
  const { t } = useTranslation();
  const left = usePane({ kind: 'local' });
  const right = usePane({ kind: 'host', hostId, label: hostLabel });
  const [activeSide, setActiveSide] = useState<'left' | 'right'>('right');
  const [picking, setPicking] = useState<'left' | 'right' | null>(null);
  const [conflict, setConflict] = useState<{ names: string[]; resolve(p: ConflictPolicy | null): void } | null>(null);
  const transfers = useTransfers((s) => s.transfers);
  const clearFinished = useTransfers((s) => s.clearFinished);
  const panes = { left, right } as const;
  const panesRef = useRef(panes);
  panesRef.current = panes;

  const endpoints = [left.endpoint, right.endpoint].filter((e): e is string => !!e && e !== 'local');
  const mine = useMemo(
    () => transfers.filter((x) => endpoints.includes(x.src.endpoint) || endpoints.includes(x.dst.endpoint) || (x.src.endpoint === 'local' && x.dst.endpoint === 'local')),
    [transfers, endpoints.join('|')], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Refresh a pane when a transfer into the folder it shows completes.
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const x of transfers) {
      if (!finished(x) || seen.current.has(x.id)) continue;
      seen.current.add(x.id);
      for (const p of [panesRef.current.left, panesRef.current.right]) {
        if (p.endpoint === x.dst.endpoint && x.dst.path.startsWith(p.path)) void p.refresh();
      }
    }
  }, [transfers]);

  const askConflict = (names: string[]) => new Promise<ConflictPolicy | null>((resolve) => setConflict({ names, resolve }));

  /** Copies `paths` from `src` (endpoint) into `dst` pane folder `dir`, asking about conflicts first. */
  const transfer = async (srcEndpoint: string, paths: string[], dst: Pane, dir: string) => {
    if (!dst.endpoint || !paths.length) return;
    const names = paths.map((p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p);
    let policy: ConflictPolicy = 'overwrite';
    try {
      const existing = await window.chh.sftp.existing({ endpoint: dst.endpoint, dir, names });
      if (existing.length) {
        const choice = await askConflict(existing);
        if (!choice) return;
        policy = choice;
      }
      await window.chh.sftp.transfer({ src: { endpoint: srcEndpoint, paths }, dst: { endpoint: dst.endpoint, dir }, conflict: policy });
    } catch (err) {
      void dst.run(() => Promise.reject(err));
    }
  };

  const other = (side: 'left' | 'right') => (side === 'left' ? right : left);

  const renderPane = (side: 'left' | 'right') => {
    const pane = panes[side];
    return (
      <FilePane
        pane={pane}
        side={side}
        active={activeSide === side}
        onActivate={() => setActiveSide(side)}
        onChangeSource={() => setPicking(side)}
        onCopyToOther={(paths) => {
          const dst = other(side);
          if (pane.endpoint && dst.status === 'ready') void transfer(pane.endpoint, paths, dst, dst.path);
        }}
        onDrop={(drop: PaneDrop, targetDir) => {
          const src = panes[drop.fromSide];
          if (!src.endpoint) return;
          if (drop.fromSide === side) {
            // Same pane: move into the folder.
            void pane.run(async (endpoint) => {
              for (const p of drop.paths) {
                const name = p.split(/[\\/]/).filter(Boolean).pop()!;
                await window.chh.sftp.rename({ endpoint, from: p, to: pane.join(name, targetDir) });
              }
            });
          } else {
            void transfer(src.endpoint, drop.paths, pane, targetDir);
          }
        }}
        onDropOsFiles={(paths, targetDir) => void transfer('local', paths, pane, targetDir)}
      />
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="sftp-view">
      <div className="flex min-h-0 flex-1">
        {renderPane('left')}
        <div className="w-px shrink-0 bg-border" />
        {renderPane('right')}
      </div>

      {mine.length > 0 && (
        <section aria-label={t('files.transfers')} className="max-h-48 shrink-0 overflow-y-auto border-t border-border bg-surface" data-testid="transfers">
          <div className="sticky top-0 flex items-center bg-surface px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
            {t('files.transfers')}
            <Button variant="ghost" className="ml-auto h-6 px-2 text-[11px] normal-case" onClick={() => clearFinished([...endpoints, 'local'])}>
              {t('files.clearFinished')}
            </Button>
          </div>
          <ul>
            {mine.map((x) => (
              <TransferRow key={x.id} t={x} />
            ))}
          </ul>
        </section>
      )}

      <HostPicker
        open={!!picking}
        onCancel={() => setPicking(null)}
        onPick={(choice: 'local' | Host) => {
          const pane = panes[picking!];
          setPicking(null);
          void pane.connect(choice === 'local' ? { kind: 'local' } : { kind: 'host', hostId: choice.id, label: choice.label });
        }}
      />
      <ConflictDialog
        names={conflict?.names ?? null}
        onChoose={(p) => {
          conflict?.resolve(p);
          setConflict(null);
        }}
      />
    </div>
  );
}
