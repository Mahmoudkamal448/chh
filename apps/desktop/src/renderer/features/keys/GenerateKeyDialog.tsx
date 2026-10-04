import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../../components/Dialog';
import { Button, Field, Input, Select } from '../../components/ui';
import { errorKey } from '../../lib/errors';
import { useVault } from '../../stores/vault-store';

const CHOICES = [
  { value: 'ed25519', label: 'ED25519' },
  { value: 'ecdsa-256', label: 'ECDSA 256' },
  { value: 'ecdsa-384', label: 'ECDSA 384' },
  { value: 'ecdsa-521', label: 'ECDSA 521' },
  { value: 'rsa-2048', label: 'RSA 2048' },
  { value: 'rsa-3072', label: 'RSA 3072' },
  { value: 'rsa-4096', label: 'RSA 4096' },
] as const;

export function GenerateKeyDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { t } = useTranslation();
  const refresh = useVault((s) => s.refresh);
  const [label, setLabel] = useState('');
  const [choice, setChoice] = useState<(typeof CHOICES)[number]['value']>('ed25519');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    if (!label.trim()) return setError(t('keys.errorLabel'));
    setBusy(true);
    setError(null);
    try {
      const [algo, bits] = choice.split('-') as ['ed25519' | 'ecdsa' | 'rsa', string | undefined];
      const base = { label: label.trim(), comment: comment.trim() };
      await window.cy.keys.generate(
        algo === 'ed25519' ? { ...base, algorithm: 'ed25519' } : algo === 'ecdsa' ? { ...base, algorithm: 'ecdsa', bits: Number(bits) as 256 } : { ...base, algorithm: 'rsa', bits: Number(bits) as 2048 },
      );
      await refresh();
      setLabel('');
      setComment('');
      onClose();
    } catch (err) {
      setError(t(errorKey(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t('keys.generateTitle')}
      testId="generate-key-dialog"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void generate()} data-testid="generate-key-submit">
            {busy ? t('keys.generating') : t('keys.generate')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t('keys.label')}>{(id) => <Input id={id} autoFocus value={label} onChange={(e) => setLabel(e.target.value)} data-testid="key-label" />}</Field>
        <Field label={t('keys.type')} hint={t('keys.typeHint')}>
          {(id, d) => (
            <Select id={id} aria-describedby={d} value={choice} onChange={(e) => setChoice(e.target.value as typeof choice)}>
              {CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                  {c.value === 'ed25519' ? ` (${t('keys.recommended')})` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('keys.comment')} hint={t('keys.commentHint')}>
          {(id, d) => <Input id={id} aria-describedby={d} value={comment} placeholder="me@laptop" onChange={(e) => setComment(e.target.value)} />}
        </Field>
        {error && (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
