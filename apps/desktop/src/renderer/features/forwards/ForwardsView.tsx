import { ArrowLeftRight, Pencil, Play, Plus, Square, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../../components/EmptyState';
import type { Forward, ForwardKind, Host } from '@chh/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Dialog } from '../../components/Dialog';
import { Button, Checkbox, Field, IconButton, Input, Select } from '../../components/ui';
import { cn } from '../../lib/cn';
import { errorKey, errorMessage, splitStatusMessage } from '../../lib/errors';
import { formatBytes } from '../../lib/format';
import { useLibrary } from '../../stores/library-store';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function describe(f: Forward): string {
  const listen = `${f.bindHost}:${f.bindPort}`;
  if (f.kind === 'dynamic') return `SOCKS ${listen}`;
  return `${listen} → ${f.destHost}:${f.destPort}`;
}

function ForwardEditor({ editing, hosts, onClose }: { editing: Forward | 'new' | null; hosts: Host[]; onClose(): void }) {
  const { t } = useTranslation();
  const refresh = useLibrary((s) => s.refreshForwards);
  const existing = editing && editing !== 'new' ? editing : null;
  const [form, setForm] = useState({ label: '', hostId: '', kind: 'local' as ForwardKind, bindHost: '127.0.0.1', bindPort: '', destHost: 'localhost', destPort: '', autoStart: false });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setForm(
      existing
        ? { ...existing, bindPort: String(existing.bindPort), destHost: existing.destHost ?? 'localhost', destPort: existing.destPort ? String(existing.destPort) : '' }
        : { label: '', hostId: hosts[0]?.id ?? '', kind: 'local', bindHost: '127.0.0.1', bindPort: '', destHost: 'localhost', destPort: '', autoStart: false },
    );
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const save = async () => {
    const payload = {
      label: form.label.trim() || `${form.kind === 'dynamic' ? 'SOCKS' : form.kind} ${form.bindPort}`,
      hostId: form.hostId,
      kind: form.kind,
      bindHost: form.bindHost.trim() || '127.0.0.1',
      bindPort: Number(form.bindPort),
      destHost: form.kind === 'dynamic' ? null : form.destHost.trim(),
      destPort: form.kind === 'dynamic' ? null : Number(form.destPort),
      autoStart: form.autoStart,
    };
    try {
      if (existing) await window.chh.forwards.update({ id: existing.id, patch: payload });
      else await window.chh.forwards.create(payload);
      await refresh();
      onClose();
    } catch (err) {
      setError(t(errorKey(err)));
    }
  };

  const exposed = !LOOPBACK.has(form.bindHost.trim());
  return (
    <Dialog
      open={!!editing}
      onOpenChange={(o) => !o && onClose()}
      title={existing ? t('forwards.editTitle') : t('forwards.newTitle')}
      width="w-[560px]"
      testId="forward-editor"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => void save()} data-testid="forward-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('forwards.label')}>{(id) => <Input id={id} autoFocus value={form.label} onChange={(e) => set({ label: e.target.value })} data-testid="forward-label" />}</Field>
          <Field label={t('forwards.host')}>
            {(id) => (
              <Select id={id} value={form.hostId} onChange={(e) => set({ hostId: e.target.value })} data-testid="forward-host">
                {hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-[12px] font-medium text-muted">{t('forwards.type')}</legend>
          {(['local', 'remote', 'dynamic'] as const).map((k) => (
            <label key={k} className="flex cursor-pointer items-start gap-2 text-[13px]">
              <input type="radio" name="fwd-kind" className="mt-0.5 accent-[var(--accent)]" checked={form.kind === k} onChange={() => set({ kind: k })} data-testid={`forward-kind-${k}`} />
              <span>
                <span className="font-medium">{t(`forwards.kind.${k}`)}</span>
                <span className="block text-[12px] text-muted">{t(`forwards.kindHint.${k}`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <Field label={form.kind === 'remote' ? t('forwards.remoteBind') : t('forwards.localBind')}>
            {(id) => <Input id={id} value={form.bindHost} onChange={(e) => set({ bindHost: e.target.value })} />}
          </Field>
          <Field label={t('forwards.port')}>
            {(id) => <Input id={id} type="number" min={1} max={65535} value={form.bindPort} onChange={(e) => set({ bindPort: e.target.value })} data-testid="forward-bind-port" />}
          </Field>
        </div>
        {form.kind !== 'dynamic' && (
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <Field label={form.kind === 'remote' ? t('forwards.destLocal') : t('forwards.destRemote')}>
              {(id) => <Input id={id} value={form.destHost} onChange={(e) => set({ destHost: e.target.value })} data-testid="forward-dest-host" />}
            </Field>
            <Field label={t('forwards.port')}>
              {(id) => <Input id={id} type="number" min={1} max={65535} value={form.destPort} onChange={(e) => set({ destPort: e.target.value })} data-testid="forward-dest-port" />}
            </Field>
          </div>
        )}
        {exposed && <p className="rounded-md bg-warning-bg p-2 text-[12px] text-warning-fg">{t('forwards.exposedWarning')}</p>}
        <Checkbox label={t('forwards.autoStart')} checked={form.autoStart} onChange={(autoStart) => set({ autoStart })} />
        {error && (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

export function ForwardsView() {
  const { t } = useTranslation();
  const forwards = useLibrary((s) => s.forwards);
  const status = useLibrary((s) => s.forwardStatus);
  const refresh = useLibrary((s) => s.refreshForwards);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [editing, setEditing] = useState<Forward | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Forward | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    void refresh();
    void window.chh.hosts.list({}).then((r) => setHosts(r.items.filter((h) => h.protocol !== 'telnet')));
  }, [refresh]);

  const hostLabel = useMemo(() => new Map(hosts.map((h) => [h.id, h.label])), [hosts]);

  const toggle = async (f: Forward) => {
    const s = status[f.id]?.state;
    setErrors((e) => ({ ...e, [f.id]: '' }));
    try {
      if (s === 'running' || s === 'starting') await window.chh.forwards.stop({ id: f.id });
      else await window.chh.forwards.start({ id: f.id });
    } catch (err) {
      const { key, detail } = errorMessage(err);
      setErrors((x) => ({ ...x, [f.id]: t(key, { defaultValue: t('errors.internal'), detail }) }));
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h1 className="text-[15px] font-semibold">{t('forwards.title')}</h1>
        <span className="shrink-0 whitespace-nowrap text-[12px] text-muted">{t('forwards.count', { count: forwards.length })}</span>
        <Button className="ml-auto" variant="primary" onClick={() => setEditing('new')} disabled={!hosts.length} data-testid="new-forward">
          <Plus size={14} /> {t('forwards.new')}
        </Button>
      </div>
      {forwards.length === 0 ? (
        <EmptyState
          icon={ArrowLeftRight}
          action={
            <Button variant="primary" onClick={() => setEditing('new')} disabled={!hosts.length}>
              <Plus size={14} /> {t('forwards.new')}
            </Button>
          }
          note={hosts.length ? undefined : t('forwards.needHost')}
        >
          {t('forwards.empty')}
        </EmptyState>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {forwards.map((f) => {
            const s = status[f.id];
            const state = s?.state ?? 'stopped';
            const msg = splitStatusMessage(s?.message);
            const err = errors[f.id] || (state === 'error' && msg ? t(msg.key, { defaultValue: t('errors.internal'), detail: msg.detail ?? '' }) : '');
            return (
              <li key={f.id} className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5" data-testid="forward-row" data-state={state}>
                <span
                  className={cn('h-2 w-2 shrink-0 rounded-full', state === 'running' ? 'bg-success' : state === 'starting' ? 'bg-warning-fg' : state === 'error' ? 'bg-danger' : 'bg-border')}
                  aria-label={t(`forwards.state.${state}`)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{f.label}</span>
                    <span className="rounded bg-surface-2 px-1.5 text-[11px] text-muted">{t(`forwards.kind.${f.kind}`)}</span>
                    {f.autoStart && <span className="text-[11px] text-muted">{t('forwards.auto')}</span>}
                  </div>
                  <div className="truncate font-mono text-[12px] text-muted">
                    {describe(f)} · {t('forwards.via', { host: hostLabel.get(f.hostId) ?? '?' })}
                  </div>
                  {state === 'running' && s && (
                    <div className="text-[11px] text-muted">{t('forwards.stats', { count: s.connections, in: formatBytes(s.bytesIn), out: formatBytes(s.bytesOut) })}</div>
                  )}
                  {err && (
                    <div role="alert" className="text-[12px] text-danger">
                      {err}
                    </div>
                  )}
                </div>
                <Button variant={state === 'running' ? 'secondary' : 'primary'} onClick={() => void toggle(f)} disabled={state === 'starting'} data-testid="forward-toggle">
                  {state === 'running' || state === 'starting' ? <Square size={13} /> : <Play size={13} />}
                  {state === 'running' || state === 'starting' ? t('forwards.stop') : t('forwards.start')}
                </Button>
                <IconButton label={t('common.edit')} onClick={() => setEditing(f)}>
                  <Pencil size={14} />
                </IconButton>
                <IconButton label={t('common.delete')} onClick={() => setDeleting(f)}>
                  <Trash2 size={14} />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
      <ForwardEditor editing={editing} hosts={hosts} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!deleting}
        title={t('forwards.deleteTitle')}
        message={t('forwards.deleteMessage', { label: deleting?.label ?? '' })}
        confirmLabel={t('common.delete')}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          await window.chh.forwards.remove({ ids: [deleting!.id] });
          setDeleting(null);
          await refresh();
        }}
      />
    </div>
  );
}
