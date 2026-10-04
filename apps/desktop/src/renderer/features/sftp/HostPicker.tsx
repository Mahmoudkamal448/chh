import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Host } from '@chh/shared';
import { Dialog } from '../../components/Dialog';
import { Input } from '../../components/ui';

/** Choose "This computer" or a host for a file pane. */
export function HostPicker({ open, onPick, onCancel }: { open: boolean; onPick(choice: 'local' | Host): void; onCancel(): void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [hosts, setHosts] = useState<Host[]>([]);
  useEffect(() => {
    if (!open) return;
    void window.chh.hosts.list({ query: query || undefined, limit: 200 }).then((r) => setHosts(r.items));
  }, [open, query]);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  const item = 'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] hover:bg-surface-2 focus:bg-surface-2 focus:outline-none';
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()} title={t('files.chooseLocation')} width="w-[460px]">
      <Input autoFocus placeholder={t('hosts.searchPlaceholder')} aria-label={t('hosts.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="mt-2 max-h-[50vh] overflow-y-auto">
        <button type="button" className={item} onClick={() => onPick('local')}>
          {t('files.thisComputer')}
        </button>
        {hosts.map((h) => (
          <button key={h.id} type="button" className={item} onClick={() => onPick(h)}>
            <span className="truncate">{h.label}</span>
            <span className="ml-auto truncate text-[12px] text-muted">{h.address}</span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}
