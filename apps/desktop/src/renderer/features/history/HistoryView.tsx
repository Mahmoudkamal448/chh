import { Copy, History, Save, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../../components/EmptyState';
import type { HistoryEntry } from '@chh/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Button, IconButton, Input } from '../../components/ui';
import { formatDate } from '../../lib/format';
import { useApp } from '../../stores/app-store';
import { SnippetEditor } from '../snippets/SnippetsView';

export function HistoryView() {
  const { t } = useTranslation();
  const enabled = useApp((s) => s.settings.historyEnabled);
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [clearing, setClearing] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  const load = async () => setItems(await window.chh.history.search({ query: query || undefined, limit: 1000 }));

  useEffect(() => {
    const h = setTimeout(() => void load(), 100);
    const off = window.chh.on('data.changed', ({ kinds }) => kinds.includes('history') && void load());
    return () => {
      clearTimeout(h);
      off();
    };
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h1 className="text-[15px] font-semibold">{t('history.title')}</h1>
        <Input
          type="search"
          className="ml-auto w-72"
          placeholder={t('history.search')}
          aria-label={t('history.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="history-search"
        />
        <Button onClick={() => setClearing(true)} disabled={!items.length}>
          <Trash2 size={14} /> {t('history.clear')}
        </Button>
      </div>
      {!enabled && <p className="border-b border-border bg-warning-bg px-4 py-2 text-[12px] text-warning-fg">{t('history.disabled')}</p>}
      {items.length === 0 ? (
        <EmptyState icon={History}>{query ? t('history.noMatches') : t('history.empty')}</EmptyState>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {items.map((h) => (
            <li key={h.id} className="group flex items-center gap-3 border-b border-border/60 px-4 py-1.5 hover:bg-surface-2/60" data-testid="history-row">
              <div className="min-w-0 flex-1">
                <div className="selectable truncate font-mono text-[12px]">{h.command}</div>
                <div className="truncate text-[11px] text-muted">
                  {h.source} · {formatDate(h.at)}
                </div>
              </div>
              <IconButton label={t('history.copy')} onClick={() => void navigator.clipboard.writeText(h.command)}>
                <Copy size={13} />
              </IconButton>
              <IconButton label={t('history.saveAsSnippet')} onClick={() => setSaving(h.command)}>
                <Save size={13} />
              </IconButton>
              <IconButton
                label={t('common.delete')}
                onClick={async () => {
                  await window.chh.history.remove({ ids: [h.id] });
                  await load();
                }}
              >
                <Trash2 size={13} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <SnippetEditor editing={saving !== null ? 'new' : null} initialScript={saving ?? ''} onClose={() => setSaving(null)} />
      <ConfirmDialog
        open={clearing}
        title={t('history.clearTitle')}
        message={t('history.clearMessage')}
        confirmLabel={t('history.clear')}
        danger
        onCancel={() => setClearing(false)}
        onConfirm={async () => {
          await window.chh.history.clear({});
          setClearing(false);
          await load();
        }}
      />
    </div>
  );
}
