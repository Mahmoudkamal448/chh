import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Key } from '@chh/shared';
import { Dialog } from '../../components/Dialog';
import { Button, Field, Input } from '../../components/ui';
import { errorKey } from '../../lib/errors';

export function ExportKeyDialog({ keyItem, onClose }: { keyItem: Key | null; onClose(): void }) {
  const { t } = useTranslation();
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPass('');
    setConfirm('');
    setError(null);
  }, [keyItem]);

  const save = async () => {
    if (pass !== confirm) return setError(t('keys.passphraseMismatch'));
    try {
      const { saved } = await window.chh.keys.exportPrivate({ id: keyItem!.id, passphrase: pass || undefined });
      if (saved) onClose();
    } catch (err) {
      setError(t(errorKey(err)));
    }
  };

  return (
    <Dialog
      open={!!keyItem}
      onOpenChange={(o) => !o && onClose()}
      title={t('keys.exportTitle', { label: keyItem?.label ?? '' })}
      description={t('keys.exportExplain')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => void save()}>
            {t('keys.exportSave')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t('keys.exportPassphrase')} hint={t('keys.exportPassphraseHint')}>
          {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />}
        </Field>
        <Field label={t('keys.exportConfirm')}>{(id) => <Input id={id} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
        {!pass && <p className="rounded-md bg-warning-bg p-2 text-[12px] text-warning-fg">{t('keys.exportUnencryptedWarning')}</p>}
        {error && (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
