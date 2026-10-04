import { Search, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { KnownHost } from '@chh/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Button, Input } from '../../components/ui';
import { cn } from '../../lib/cn';
import { errorKey } from '../../lib/errors';
import { formatDate } from '../../lib/format';

export function KnownHostsView() {
  const { t } = useTranslation();
  const [items, setItems] = useState<KnownHost[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async (q = query) => setItems(await window.chh.knownHosts.list({ query: q || undefined }));

  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: string, multi: boolean) => {
    const next = new Set(multi ? selected : []);
    if (next.has(id) && multi) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const importFile = async () => {
    try {
      const res = await window.chh.knownHosts.importFile({});
      if (!res) return;
      setNotice(t('knownHosts.imported', { imported: res.imported, skipped: res.skipped }));
      await load();
    } catch (err) {
      setNotice(t(errorKey(err)));
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h1 className="text-[15px] font-semibold">{t('knownHosts.title')}</h1>
        <span className="text-[12px] text-muted">{t('knownHosts.count', { count: items.length })}</span>
        <div className="relative ml-auto w-64">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
          <Input
            type="search"
            className="pl-8"
            placeholder={t('knownHosts.search')}
            aria-label={t('knownHosts.search')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              void load(e.target.value);
            }}
          />
        </div>
        <Button onClick={() => setConfirming(true)} disabled={selected.size === 0} data-testid="known-hosts-delete">
          <Trash2 size={14} /> {t('knownHosts.remove', { count: selected.size })}
        </Button>
        <Button variant="primary" onClick={() => void importFile()}>
          <Upload size={14} /> {t('knownHosts.import')}
        </Button>
      </div>
      {notice && (
        <p role="status" className="border-b border-border bg-surface-2 px-4 py-2 text-[12px]">
          {notice}
        </p>
      )}
      {items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted">
          <ShieldCheck size={28} />
          <p className="max-w-sm">{t('knownHosts.empty')}</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full table-fixed text-[13px]">
            <thead className="sticky top-0 bg-surface text-left text-[11px] uppercase tracking-wide text-muted">
              <tr className="border-b border-border">
                <th className="w-[30%] px-4 py-2 font-semibold">{t('knownHosts.host')}</th>
                <th className="w-[16%] px-2 py-2 font-semibold">{t('hostKey.keyType')}</th>
                <th className="px-2 py-2 font-semibold">{t('hostKey.fingerprint')}</th>
                <th className="w-[16%] px-2 py-2 font-semibold">{t('knownHosts.added')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((k) => (
                <tr
                  key={k.id}
                  aria-selected={selected.has(k.id)}
                  onClick={(e) => toggle(k.id, e.ctrlKey || e.metaKey)}
                  className={cn('cursor-default border-b border-border/60', selected.has(k.id) ? 'bg-surface-2' : 'hover:bg-surface-2/60')}
                  data-testid="known-host-row"
                >
                  <td className="selectable truncate px-4 py-2 font-mono text-[12px]" title={k.hostPattern}>
                    {k.hostPattern.startsWith('|1|') ? <span className="text-muted">{t('knownHosts.hashed')}</span> : k.hostPattern}
                    {k.source === 'imported' && <span className="ml-2 rounded bg-surface-2 px-1 text-[10px] text-muted">{t('knownHosts.importedBadge')}</span>}
                  </td>
                  <td className="truncate px-2 py-2 font-mono text-[12px]">{k.keyType}</td>
                  <td className="selectable truncate px-2 py-2 font-mono text-[12px]" title={k.fingerprint}>
                    {k.fingerprint}
                  </td>
                  <td className="truncate px-2 py-2 text-[12px] text-muted">{formatDate(k.addedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title={t('knownHosts.removeTitle')}
        message={t('knownHosts.removeMessage', { count: selected.size })}
        confirmLabel={t('common.delete')}
        danger
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          await window.chh.knownHosts.remove({ ids: [...selected] });
          setSelected(new Set());
          setConfirming(false);
          await load();
        }}
      />
    </div>
  );
}
