import { FileKey } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ImportKeyResult } from '@cy-ssh/shared';
import { Dialog } from '../../components/Dialog';
import { Button, Field, Input } from '../../components/ui';
import { errorKey } from '../../lib/errors';
import { useVault } from '../../stores/vault-store';

/** Import from a file (picked in main, never read by the renderer) or pasted text. */
export function ImportKeyDialog({ open, mode, onClose }: { open: boolean; mode: 'file' | 'paste'; onClose(): void }) {
  const { t } = useTranslation();
  const refresh = useVault((s) => s.refresh);
  const [staged, setStaged] = useState<{ token: string; fileName: string; encrypted: boolean } | null>(null);
  const [text, setText] = useState('');
  const [label, setLabel] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [needPassphrase, setNeedPassphrase] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStaged(null);
    setText('');
    setLabel('');
    setPassphrase('');
    setNeedPassphrase(false);
    setMessage(null);
    if (mode === 'file') void pick();
  }, [open, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async () => {
    try {
      const f = await window.cy.keys.pickFile({});
      if (!f) {
        if (!staged) onClose();
        return;
      }
      setStaged(f);
      setLabel(f.fileName);
      setNeedPassphrase(f.encrypted);
    } catch (err) {
      setMessage(t(errorKey(err)));
    }
  };

  const handle = async (res: ImportKeyResult) => {
    switch (res.status) {
      case 'imported':
        await refresh();
        onClose();
        return;
      case 'duplicate':
        setMessage(t('keys.duplicate', { label: res.existing.label }));
        return;
      case 'passphrase_required':
        setNeedPassphrase(true);
        setMessage(t('keys.needPassphrase'));
        return;
      case 'bad_passphrase':
        setNeedPassphrase(true);
        setMessage(t('keys.badPassphrase'));
        return;
    }
  };

  const submit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const args = { label: label.trim() || undefined, passphrase: passphrase || undefined };
      if (mode === 'file' && staged) await handle(await window.cy.keys.importStaged({ token: staged.token, ...args }));
      else if (mode === 'paste' && text.trim()) await handle(await window.cy.keys.importText({ text, ...args }));
    } catch (err) {
      setMessage(t(errorKey(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t('keys.importTitle')}
      description={t('keys.importFormats')}
      testId="import-key-dialog"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || (mode === 'file' ? !staged : !text.trim())} onClick={() => void submit()} data-testid="import-key-submit">
            {t('keys.import')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {mode === 'file' ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2">
            <FileKey size={16} className="text-muted" />
            <span className="truncate">{staged?.fileName ?? t('keys.noFile')}</span>
            <Button className="ml-auto" onClick={() => void pick()}>
              {t('keys.chooseFile')}
            </Button>
          </div>
        ) : (
          <Field label={t('keys.pasteLabel')}>
            {(id) => (
              <textarea
                id={id}
                autoFocus
                rows={8}
                spellCheck={false}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[12px] focus:border-accent focus:outline-none"
                data-testid="key-paste"
              />
            )}
          </Field>
        )}
        <Field label={t('keys.label')}>{(id) => <Input id={id} value={label} placeholder={t('keys.labelFromComment')} onChange={(e) => setLabel(e.target.value)} />}</Field>
        {needPassphrase && (
          <Field label={t('keys.passphrase')} hint={t('keys.passphraseHint')}>
            {(id, d) => (
              <Input id={id} aria-describedby={d} type="password" autoFocus autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} data-testid="key-passphrase" />
            )}
          </Field>
        )}
        {message && (
          <p role="alert" className="text-[12px] text-danger">
            {message}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
