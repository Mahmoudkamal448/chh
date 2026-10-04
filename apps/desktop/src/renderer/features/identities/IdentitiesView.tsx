import { Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Identity } from '@chh/shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Dialog } from '../../components/Dialog';
import { Button, Field, IconButton, Input, Select } from '../../components/ui';
import { errorKey } from '../../lib/errors';
import { keyKind } from '../../lib/format';
import { useVault } from '../../stores/vault-store';

function IdentityEditor({ editing, onClose }: { editing: Identity | 'new' | null; onClose(): void }) {
  const { t } = useTranslation();
  const keys = useVault((s) => s.keys);
  const refresh = useVault((s) => s.refresh);
  const existing = editing && editing !== 'new' ? editing : null;
  const [label, setLabel] = useState('');
  const [username, setUsername] = useState('');
  const [keyId, setKeyId] = useState('');
  const [password, setPassword] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLabel(existing?.label ?? '');
    setUsername(existing?.username ?? '');
    setKeyId(existing?.keyId ?? '');
    setPassword(undefined);
    setError(null);
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!label.trim()) return setError(t('identities.errorLabel'));
    const payload = { label: label.trim(), username: username.trim(), keyId: keyId || null, password: password === '' ? undefined : password };
    try {
      if (existing) await window.chh.identities.update({ id: existing.id, patch: payload });
      else await window.chh.identities.create(payload);
      await refresh();
      onClose();
    } catch (err) {
      setError(t(errorKey(err)));
    }
  };

  return (
    <Dialog
      open={!!editing}
      onOpenChange={(o) => !o && onClose()}
      title={existing ? t('identities.editTitle') : t('identities.newTitle')}
      description={t('identities.explain')}
      testId="identity-editor"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => void save()} data-testid="identity-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label={t('identities.label')}>{(id) => <Input id={id} autoFocus value={label} onChange={(e) => setLabel(e.target.value)} data-testid="identity-label" />}</Field>
        <Field label={t('hostEditor.username')}>{(id) => <Input id={id} value={username} onChange={(e) => setUsername(e.target.value)} data-testid="identity-username" />}</Field>
        <Field label={t('hostEditor.password')} hint={t('hostEditor.passwordHint')}>
          {(id, d) =>
            existing?.hasPassword && password === undefined ? (
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-muted">{t('hostEditor.passwordSaved')}</span>
                <Button onClick={() => setPassword('')}>{t('hostEditor.passwordChange')}</Button>
                <Button variant="ghost" onClick={() => setPassword(null)}>
                  {t('hostEditor.passwordRemove')}
                </Button>
              </div>
            ) : password === null ? (
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-muted">{t('hostEditor.passwordWillRemove')}</span>
                <Button variant="ghost" onClick={() => setPassword(undefined)}>
                  {t('common.undo')}
                </Button>
              </div>
            ) : (
              <Input id={id} aria-describedby={d} type="password" autoComplete="off" value={password ?? ''} onChange={(e) => setPassword(e.target.value)} data-testid="identity-password" />
            )
          }
        </Field>
        <Field label={t('identities.key')}>
          {(id) => (
            <Select id={id} value={keyId} onChange={(e) => setKeyId(e.target.value)} data-testid="identity-key">
              <option value="">{t('identities.noKey')}</option>
              {keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label} ({keyKind(k.type, k.bits)})
                </option>
              ))}
            </Select>
          )}
        </Field>
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

export function IdentitiesView() {
  const { t } = useTranslation();
  const identities = useVault((s) => s.identities);
  const keys = useVault((s) => s.keys);
  const refresh = useVault((s) => s.refresh);
  const [editing, setEditing] = useState<Identity | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Identity | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const keyLabel = (id: string | null) => (id ? (keys.find((k) => k.id === id)?.label ?? null) : null);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h1 className="text-[15px] font-semibold">{t('identities.title')}</h1>
        <span className="text-[12px] text-muted">{t('identities.count', { count: identities.length })}</span>
        <Button className="ml-auto" variant="primary" onClick={() => setEditing('new')} data-testid="new-identity">
          <Plus size={14} /> {t('identities.new')}
        </Button>
      </div>
      {identities.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted">
          <UserRound size={28} />
          <p className="max-w-sm">{t('identities.empty')}</p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {identities.map((i) => (
            <li key={i.id} className="group flex items-center gap-3 border-b border-border/60 px-4 py-2.5 hover:bg-surface-2/60" data-testid="identity-row" onDoubleClick={() => setEditing(i)}>
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted">
                <UserRound size={16} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{i.label}</div>
                <div className="truncate text-[12px] text-muted">
                  {[i.username || t('identities.noUsername'), i.hasPassword ? t('identities.withPassword') : null, keyLabel(i.keyId) ? t('identities.withKey', { key: keyLabel(i.keyId) }) : null]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <IconButton label={t('common.edit')} onClick={() => setEditing(i)}>
                <Pencil size={14} />
              </IconButton>
              <IconButton label={t('common.delete')} onClick={() => setDeleting(i)}>
                <Trash2 size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <IdentityEditor editing={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!deleting}
        title={t('identities.deleteTitle')}
        message={t('identities.deleteMessage', { label: deleting?.label ?? '' })}
        confirmLabel={t('common.delete')}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          await window.chh.identities.remove({ ids: [deleting!.id] });
          setDeleting(null);
          await refresh();
        }}
      />
    </div>
  );
}
