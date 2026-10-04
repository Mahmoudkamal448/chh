import { CheckCircle2, ChevronDown, ChevronRight, Copy, Loader2, MinusCircle, RotateCcw, Square, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, IconButton } from '../../components/ui';
import { cn } from '../../lib/cn';
import { splitStatusMessage } from '../../lib/errors';
import { startRun, useRuns, type RunHost } from '../../stores/runs-store';
import { useTabs } from '../../stores/tabs-store';

function StatusIcon({ h }: { h: RunHost }) {
  if (h.status === 'done' && h.exitCode === 0) return <CheckCircle2 size={15} className="text-[#2f9e44]" />;
  if (h.status === 'done' || h.status === 'error') return <XCircle size={15} className="text-danger" />;
  if (h.status === 'cancelled' || h.status === 'skipped') return <MinusCircle size={15} className="text-muted" />;
  return <Loader2 size={15} className="animate-spin text-muted" />;
}

/** Results of running a script on many hosts: per-host status, exit code and output. */
export function RunView({ runId }: { runId: string }) {
  const { t } = useTranslation();
  const run = useRuns((s) => s.runs[runId]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<'all' | 'failed'>('all');
  if (!run) return null;
  const hosts = run.hostIds.map((id) => run.hosts[id]!).filter(Boolean);
  const finished = (h: RunHost) => ['done', 'error', 'cancelled', 'skipped'].includes(h.status);
  const failed = hosts.filter((h) => h.status === 'error' || (h.status === 'done' && h.exitCode !== 0));
  const ok = hosts.filter((h) => h.status === 'done' && h.exitCode === 0);
  const running = hosts.some((h) => !finished(h));
  const shown = filter === 'failed' ? failed : hosts;

  const message = (h: RunHost) => {
    if (h.skipped) return t(h.skipped);
    if (h.status === 'error') {
      const m = splitStatusMessage(h.error);
      return m ? t(m.key, { defaultValue: t('session.error.generic'), detail: m.detail ?? '' }) : t('errors.internal');
    }
    if (h.status === 'done') return t('run.exit', { code: h.exitCode ?? '?' });
    return t(`run.status.${h.status}`);
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="run-view">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-semibold">{run.title}</h1>
          <p className="truncate font-mono text-[11px] text-muted">{run.script.split('\n')[0]}</p>
        </div>
        <span className="ml-auto text-[12px] text-muted" data-testid="run-summary">
          {t('run.summary', { ok: ok.length, failed: failed.length, total: hosts.length })}
        </span>
        <Button variant={filter === 'failed' ? 'secondary' : 'ghost'} onClick={() => setFilter(filter === 'failed' ? 'all' : 'failed')} disabled={!failed.length}>
          {t('run.onlyFailed')}
        </Button>
        {running ? (
          <Button onClick={() => void window.cy.run.cancel({ runId })} data-testid="run-cancel">
            <Square size={13} /> {t('run.cancel')}
          </Button>
        ) : (
          <Button
            disabled={!failed.length}
            onClick={async () => {
              const id = await startRun(
                failed.map((h) => h.hostId),
                run.script,
                t('run.retryTitle', { title: run.title }),
              );
              useTabs.getState().openRun(id, t('run.retryTitle', { title: run.title }));
            }}
          >
            <RotateCcw size={13} /> {t('run.retryFailed')}
          </Button>
        )}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {shown.map((h) => {
          const expanded = open.has(h.hostId);
          const text = h.output.map((o) => (o.stream === 'info' ? `\n[${t(o.data)}]\n` : o.data)).join('');
          return (
            <li key={h.hostId} className="border-b border-border/60" data-testid="run-host" data-status={h.status} data-exit={h.exitCode ?? ''}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-surface-2/60"
                aria-expanded={expanded}
                onClick={() => {
                  const next = new Set(open);
                  expanded ? next.delete(h.hostId) : next.add(h.hostId);
                  setOpen(next);
                }}
              >
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <StatusIcon h={h} />
                <span className="truncate font-medium">{h.label}</span>
                <span className={cn('ml-auto truncate text-[12px]', h.status === 'error' ? 'text-danger' : 'text-muted')}>{message(h)}</span>
              </button>
              {expanded && (
                <div className="relative bg-surface-2/50 px-4 pb-3">
                  <IconButton label={t('history.copy')} className="absolute right-3 top-1" onClick={() => void navigator.clipboard.writeText(text)}>
                    <Copy size={13} />
                  </IconButton>
                  <pre className="selectable max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-[12px]" data-testid="run-output">
                    {h.output.length ? (
                      h.output.map((o, i) => (
                        <span key={i} className={o.stream === 'stderr' ? 'text-danger' : o.stream === 'info' ? 'text-muted' : undefined}>
                          {o.stream === 'info' ? `\n[${t(o.data)}]\n` : o.data}
                        </span>
                      ))
                    ) : (
                      <span className="text-muted">{t('run.noOutput')}</span>
                    )}
                  </pre>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
