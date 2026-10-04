import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { inheritedSettings, type GroupLike, type HostSettingsOverrides, type Protocol } from '@chh/shared';
import { Dialog } from '../../components/Dialog';
import { Button, Checkbox, Field, Input, Select } from '../../components/ui';
import { errorKey } from '../../lib/errors';
import { refreshAll, useHosts } from '../../stores/hosts-store';
import { useTeams } from '../../stores/teams-store';
import { GroupOptions, SettingsFields } from './SettingsFields';

interface FormState {
  protocol: Protocol;
  label: string;
  address: string;
  groupId: string;
  tags: string;
  notes: string;
  favorite: boolean;
  settings: HostSettingsOverrides;
  /** undefined = unchanged, null = remove, string = new password. */
  password: string | null | undefined;
}

const EMPTY: FormState = { protocol: 'ssh', label: '', address: '', groupId: '', tags: '', notes: '', favorite: false, settings: {}, password: undefined };

export function HostEditor() {
  const { t } = useTranslation();
  const editor = useHosts((s) => s.editor);
  const openEditor = useHosts((s) => s.openEditor);
  const groups = useHosts((s) => s.groups);
  const open = editor?.kind === 'host';
  const editingId = open ? editor.id : null;
  const [form, setForm] = useState<FormState>(EMPTY);
  const [hasPassword, setHasPassword] = useState(false);
  const vaults = useTeams((s) => s.vaults);
  const [vaultId, setVaultId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [ports, setPorts] = useState<Array<{ path: string; manufacturer: string | null; serialNumber: string | null }>>([]);
  useEffect(() => {
    if (open && form.protocol === 'serial') void window.chh.serial.ports({}).then(setPorts, () => setPorts([]));
  }, [open, form.protocol]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (!editingId) {
      setForm({ ...EMPTY, groupId: editor.groupId ?? '' });
      setHasPassword(false);
      setVaultId('');
      return;
    }
    void window.chh.hosts.get({ id: editingId }).then((h) => {
      setForm({
        protocol: h.protocol,
        label: h.label,
        address: h.address,
        groupId: h.groupId ?? '',
        tags: h.tags.join(', '),
        notes: h.notes,
        favorite: h.favorite,
        settings: h.settings,
        password: undefined,
      });
      setHasPassword(h.hasPassword);
      setVaultId(h.vaultId);
    });
  }, [open, editingId]); // eslint-disable-line react-hooks/exhaustive-deps

  const groupMap = useMemo(() => new Map<string, GroupLike>(groups.map((g) => [g.id, g])), [groups]);
  const inherited = useMemo(() => inheritedSettings(form.groupId || null, groupMap), [form.groupId, groupMap]);

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  const close = () => openEditor(null);

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!form.label.trim() && !form.address.trim()) {
      setError(t('hostEditor.errorRequired'));
      return;
    }
    setSaving(true);
    setError(null);
    const payload = {
      protocol: form.protocol,
      label: form.label.trim() || form.address.trim(),
      address: form.address.trim(),
      groupId: form.groupId || null,
      tags: form.tags.split(',').map((s) => s.trim()).filter(Boolean),
      notes: form.notes,
      favorite: form.favorite,
      settings: form.settings,
      // An empty field means "leave unchanged", never "set an empty password".
      password: form.password === '' ? undefined : form.password,
    };
    try {
      if (editingId) await window.chh.hosts.update({ id: editingId, patch: payload });
      else await window.chh.hosts.create({ ...payload, vaultId: vaultId || undefined });
      await refreshAll();
      close();
    } catch (err) {
      setError(t(errorKey(err)));
    } finally {
      setSaving(false);
    }
  };

  const passwordField = (
    <Field label={t('hostEditor.password')} hint={t('hostEditor.passwordHint')}>
      {(id, d) =>
        hasPassword && form.password === undefined ? (
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-muted">{t('hostEditor.passwordSaved')}</span>
            <Button onClick={() => set({ password: '' })}>{t('hostEditor.passwordChange')}</Button>
            <Button variant="ghost" onClick={() => set({ password: null })}>
              {t('hostEditor.passwordRemove')}
            </Button>
          </div>
        ) : form.password === null ? (
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-muted">{t('hostEditor.passwordWillRemove')}</span>
            <Button variant="ghost" onClick={() => set({ password: undefined })}>
              {t('common.undo')}
            </Button>
          </div>
        ) : (
          <Input
            id={id}
            aria-describedby={d}
            type="password"
            autoComplete="off"
            value={form.password ?? ''}
            onChange={(e) => set({ password: e.target.value === '' && !hasPassword ? undefined : e.target.value })}
            data-testid="host-password"
          />
        )
      }
    </Field>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title={editingId ? t('hostEditor.editTitle') : t('hostEditor.newTitle')}
      width="w-[600px]"
      testId="host-editor"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving} data-testid="host-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form onSubmit={save} className="flex flex-col gap-4">
        {editingId && vaults.some((v) => v.id === vaultId && !v.writable) && (
          <p role="status" className="rounded-md bg-surface-2 px-3 py-2 text-[12px] text-muted">
            {t('teams.readOnlyHost')}
          </p>
        )}
        {!editingId && vaults.filter((v) => v.writable).length > 1 && (
          <Field label={t('teams.vaultField')} hint={t('teams.vaultFieldHint')}>
            {(id, d) => (
              <Select id={id} aria-describedby={d} value={vaultId} onChange={(e) => setVaultId(e.target.value)} data-testid="host-vault">
                {vaults
                  .filter((v) => v.writable)
                  .map((v) => (
                    <option key={v.id} value={v.kind === 'personal' ? '' : v.id}>
                      {v.kind === 'personal' ? t('teams.personalVault') : v.name || t('teams.unnamed')}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        )}
        <Field label={t('hostEditor.protocol')} hint={form.protocol !== 'ssh' ? t(`hostEditor.protocolHint.${form.protocol}`) : undefined}>
          {(id, d) => (
            <Select id={id} aria-describedby={d} value={form.protocol} onChange={(e) => set({ protocol: e.target.value as Protocol })} data-testid="host-protocol">
              <option value="ssh">SSH</option>
              <option value="mosh">Mosh</option>
              <option value="telnet">Telnet</option>
              <option value="serial">{t('serial.protocol')}</option>
            </Select>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={form.protocol === 'serial' ? t('serial.port') : t('hostEditor.address')} hint={form.protocol === 'serial' ? t('serial.portHint') : t('hostEditor.addressHint')}>
            {(id, d) => (
              <>
                <Input
                  id={id}
                  aria-describedby={d}
                  autoFocus
                  list={form.protocol === 'serial' ? 'serial-ports' : undefined}
                  value={form.address}
                  onChange={(e) => set({ address: e.target.value })}
                  data-testid="host-address"
                />
                {form.protocol === 'serial' && (
                  <datalist id="serial-ports">
                    {ports.map((p) => (
                      <option key={p.path} value={p.path}>
                        {[p.manufacturer, p.serialNumber].filter(Boolean).join(' ')}
                      </option>
                    ))}
                  </datalist>
                )}
              </>
            )}
          </Field>
          <Field label={t('hostEditor.label')}>
            {(id) => <Input id={id} value={form.label} placeholder={form.address} onChange={(e) => set({ label: e.target.value })} data-testid="host-label" />}
          </Field>
        </div>

        <SettingsFields
          value={form.settings}
          inherited={inherited}
          onChange={(settings) => set({ settings })}
          showIdentity
          protocol={form.protocol}
          selfId={editingId}
          passwordField={passwordField}
        />

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('hostEditor.group')}>
            {(id) => (
              <Select id={id} value={form.groupId} onChange={(e) => set({ groupId: e.target.value })}>
                <option value="">{t('hostEditor.noGroup')}</option>
                <GroupOptions groups={groups} />
              </Select>
            )}
          </Field>
          <Field label={t('hostEditor.tags')} hint={t('hostEditor.tagsHint')}>
            {(id, d) => <Input id={id} aria-describedby={d} value={form.tags} onChange={(e) => set({ tags: e.target.value })} />}
          </Field>
        </div>

        <Field label={t('hostEditor.notes')}>
          {(id) => (
            <textarea
              id={id}
              rows={3}
              value={form.notes}
              onChange={(e) => set({ notes: e.target.value })}
              className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] focus:border-accent focus:outline-none"
            />
          )}
        </Field>

        <Checkbox label={t('hosts.favorite')} checked={form.favorite} onChange={(favorite) => set({ favorite })} />
        {error && (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
