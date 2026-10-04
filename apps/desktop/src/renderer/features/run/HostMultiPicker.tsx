import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Group, Host } from '@chh/shared';
import { Dialog } from '../../components/Dialog';
import { Button, Input, Select } from '../../components/ui';

/** Choose many hosts quickly: search, filter by group or tag, select all visible. */
export function HostMultiPicker({ open, title, confirmLabel, onConfirm, onCancel }: { open: boolean; title: string; confirmLabel: string; onConfirm(ids: string[]): void; onCancel(): void }) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<Host[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [query, setQuery] = useState('');
  const [groupId, setGroupId] = useState('');
  const [tag, setTag] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setQuery('');
    void window.chh.hosts.list({}).then((r) => setHosts(r.items.filter((h) => h.protocol === 'ssh' || h.protocol === 'mosh')));
    void window.chh.groups.list({}).then(setGroups);
  }, [open]);

  const tags = useMemo(() => [...new Set(hosts.flatMap((h) => h.tags))].sort(), [hosts]);
  const shown = hosts.filter(
    (h) =>
      (!query || `${h.label} ${h.address} ${h.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase())) &&
      (!groupId || h.groupId === groupId) &&
      (!tag || h.tags.includes(tag)),
  );
  const allShown = shown.length > 0 && shown.every((h) => selected.has(h.id));

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onCancel()}
      title={title}
      width="w-[640px]"
      testId="host-multi-picker"
      footer={
        <>
          <span className="mr-auto self-center text-[12px] text-muted">{t('run.selected', { count: selected.size })}</span>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!selected.size} onClick={() => onConfirm([...selected])} data-testid="picker-confirm">
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="mb-2 flex gap-2">
        <Input type="search" placeholder={t('hosts.searchPlaceholder')} aria-label={t('hosts.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <Select aria-label={t('hostEditor.group')} value={groupId} onChange={(e) => setGroupId(e.target.value)} className="w-40">
          <option value="">{t('run.allGroups')}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </Select>
        <Select aria-label={t('sidebar.tags')} value={tag} onChange={(e) => setTag(e.target.value)} className="w-36">
          <option value="">{t('run.allTags')}</option>
          {tags.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </Select>
      </div>
      <label className="flex items-center gap-2 border-b border-border py-1.5 text-[12px] text-muted">
        <input
          type="checkbox"
          className="accent-[var(--accent)]"
          checked={allShown}
          onChange={(e) => {
            const next = new Set(selected);
            for (const h of shown) e.target.checked ? next.add(h.id) : next.delete(h.id);
            setSelected(next);
          }}
          data-testid="picker-all"
        />
        {t('run.selectShown', { count: shown.length })}
      </label>
      <ul className="max-h-[45vh] overflow-y-auto">
        {shown.map((h) => (
          <li key={h.id}>
            <label className="flex items-center gap-2 py-1 text-[13px]">
              <input
                type="checkbox"
                className="accent-[var(--accent)]"
                checked={selected.has(h.id)}
                onChange={() => {
                  const next = new Set(selected);
                  next.has(h.id) ? next.delete(h.id) : next.add(h.id);
                  setSelected(next);
                }}
                data-testid="picker-host"
              />
              <span className="truncate">{h.label}</span>
              <span className="ml-auto truncate text-[12px] text-muted">{h.address}</span>
            </label>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
