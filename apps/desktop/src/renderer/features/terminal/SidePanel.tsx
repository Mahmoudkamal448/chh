import { Play, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryEntry, Snippet } from '@chh/shared';
import { IconButton, Input } from '../../components/ui';
import { cn } from '../../lib/cn';
import { formatDate } from '../../lib/format';
import { useLibrary } from '../../stores/library-store';
import { needsVariables, runSnippet } from '../snippets/run-snippet';
import { VariablesDialog } from '../snippets/VariablesDialog';
import { writeToPane } from './registry';

/** Snippets and history next to the terminal: click to run a snippet or insert a past command. */
export function SidePanel({ focusedPaneId, onClose }: { focusedPaneId: string; onClose(): void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'snippets' | 'history'>('snippets');
  const [query, setQuery] = useState('');
  const snippets = useLibrary((s) => s.snippets);
  const refreshSnippets = useLibrary((s) => s.refreshSnippets);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [asking, setAsking] = useState<Snippet | null>(null);

  useEffect(() => {
    void refreshSnippets();
  }, [refreshSnippets]);

  useEffect(() => {
    if (tab !== 'history') return;
    const load = () => void window.chh.history.search({ query: query || undefined, limit: 300 }).then(setHistory);
    const h = setTimeout(load, 100);
    // Live-update as new commands are recorded.
    const off = window.chh.on('data.changed', ({ kinds }) => kinds.includes('history') && load());
    return () => {
      clearTimeout(h);
      off();
    };
  }, [tab, query]);

  const q = query.toLowerCase();
  const shownSnippets = snippets.filter((s) => !q || s.label.toLowerCase().includes(q) || s.script.toLowerCase().includes(q) || s.tags.some((x) => x.toLowerCase().includes(q)));

  const run = (s: Snippet) => {
    if (needsVariables(s).length) setAsking(s);
    else runSnippet(focusedPaneId, s);
  };

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-border bg-surface" aria-label={t('panel.label')} data-testid="side-panel">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        {(['snippets', 'history'] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-pressed={tab === id}
            className={cn('rounded px-2 py-1 text-[12px] font-medium', tab === id ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg')}
            data-testid={`panel-${id}`}
          >
            {t(`panel.${id}`)}
          </button>
        ))}
        <IconButton label={t('common.close')} className="ml-auto" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="p-2">
        <Input type="search" placeholder={t('panel.search')} aria-label={t('panel.search')} value={query} onChange={(e) => setQuery(e.target.value)} data-testid="panel-search" />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'snippets' &&
          (shownSnippets.length ? (
            shownSnippets.map((s) => (
              <li key={s.id} className="group flex items-start gap-2 border-b border-border/60 px-3 py-2 hover:bg-surface-2/60" data-testid="panel-snippet">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{s.label}</div>
                  <div className="truncate font-mono text-[11px] text-muted">{s.script.split('\n')[0]}</div>
                </div>
                <IconButton label={t('snippets.runIn')} onClick={() => run(s)} data-testid="panel-snippet-run">
                  <Play size={13} />
                </IconButton>
              </li>
            ))
          ) : (
            <li className="p-4 text-center text-[12px] text-muted">{t('panel.noSnippets')}</li>
          ))}
        {tab === 'history' &&
          (history.length ? (
            history.map((h) => (
              <li key={h.id} data-testid="panel-history">
                <button
                  type="button"
                  className="w-full border-b border-border/60 px-3 py-1.5 text-left hover:bg-surface-2/60"
                  title={t('panel.insertHint')}
                  onClick={() => writeToPane(focusedPaneId, h.command)}
                  onDoubleClick={() => writeToPane(focusedPaneId, '\r')}
                >
                  <div className="truncate font-mono text-[12px]">{h.command}</div>
                  <div className="truncate text-[11px] text-muted">
                    {h.source} · {formatDate(h.at)}
                  </div>
                </button>
              </li>
            ))
          ) : (
            <li className="p-4 text-center text-[12px] text-muted">{t('panel.noHistory')}</li>
          ))}
      </ul>
      <VariablesDialog
        snippet={asking}
        onCancel={() => setAsking(null)}
        onRun={(values) => {
          if (asking) runSnippet(focusedPaneId, asking, values);
          setAsking(null);
        }}
      />
    </aside>
  );
}
