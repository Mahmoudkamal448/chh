import { BadgeCheck, FileBadge, ShieldAlert, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CertificateSummary, Key } from '@chh/shared';
import { Dialog } from '../../components/Dialog';
import { Button, Field } from '../../components/ui';
import { cn } from '../../lib/cn';
import { errorKey } from '../../lib/errors';
import { formatDate } from '../../lib/format';
import { useVault } from '../../stores/vault-store';

const DAY = 86_400_000;

export type CertState = 'valid' | 'expiring' | 'expired' | 'not-yet';

export function certState(c: CertificateSummary, now = Date.now()): CertState {
  if (now < c.validAfter) return 'not-yet';
  if (c.validBefore !== null && now >= c.validBefore) return 'expired';
  if (c.validBefore !== null && c.validBefore - now < 7 * DAY) return 'expiring';
  return 'valid';
}

/** One-line validity, e.g. "Valid until 3 Mar 2026", "Expires in 2 days", "Expired 1 Jan 2025". */
function validity(c: CertificateSummary, t: (k: string, o?: Record<string, unknown>) => string): string {
  const state = certState(c);
  if (state === 'not-yet') return t('certs.validFrom', { date: formatDate(c.validAfter) });
  if (c.validBefore === null) return t('certs.forever');
  if (state === 'expired') return t('certs.expiredOn', { date: formatDate(c.validBefore) });
  if (state === 'expiring') return t('certs.expiresIn', { count: Math.max(1, Math.ceil((c.validBefore - Date.now()) / DAY)) });
  return t('certs.validUntil', { date: formatDate(c.validBefore) });
}

const tone: Record<CertState, string> = {
  valid: 'bg-success/15 text-success',
  expiring: 'bg-warning-bg text-warning-fg',
  expired: 'bg-danger/15 text-danger',
  'not-yet': 'bg-warning-bg text-warning-fg',
};

/** Small chip for lists: "Certificate" (green), or amber/red when it's expiring or expired. */
export function CertificateChip({ cert }: { cert: CertificateSummary }) {
  const { t } = useTranslation();
  const state = certState(cert);
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px]', tone[state])} title={validity(cert, t)} data-testid="cert-chip">
      {state === 'valid' ? <BadgeCheck size={11} /> : <ShieldAlert size={11} />}
      {state === 'expired' ? t('certs.expired') : t('certs.chip')}
    </span>
  );
}

/** Certificate details for a key, with add / replace / remove. `compact` is for editors (identity, host). */
export function CertificatePanel({ keyItem, compact = false }: { keyItem: Key; compact?: boolean }) {
  const { t } = useTranslation();
  const refresh = useVault((s) => s.refresh);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cert = keyItem.certificate;

  const remove = async () => {
    setError(null);
    try {
      await window.chh.keys.setCertificate({ id: keyItem.id, certificate: null });
      await refresh();
    } catch (err) {
      setError(t(errorKey(err)));
    }
  };

  return (
    <div className={cn('rounded-md border border-border', compact ? 'px-3 py-2' : 'p-3')} data-testid="cert-panel">
      {cert ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <FileBadge size={15} className="shrink-0 text-muted" />
            <span className="font-medium">{t('certs.title')}</span>
            <span className={cn('rounded px-1.5 py-0.5 text-[11px]', tone[certState(cert)])} data-testid="cert-validity">
              {validity(cert, t)}
            </span>
            <div className="ml-auto flex gap-1">
              <Button variant="ghost" className="whitespace-nowrap" onClick={() => setEditing(true)} data-testid="cert-replace">
                {t('certs.replace')}
              </Button>
              <Button variant="ghost" onClick={() => void remove()} aria-label={t('certs.remove')} data-testid="cert-remove">
                <Trash2 size={13} />
              </Button>
            </div>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
            <dt className="text-muted">{t('certs.principals')}</dt>
            <dd className="selectable" data-testid="cert-principals">
              {cert.principals.length ? cert.principals.join(', ') : t('certs.anyUser')}
            </dd>
            {!compact && (
              <>
                <dt className="text-muted">{t('certs.keyId')}</dt>
                <dd className="selectable truncate">{cert.keyId || '—'}</dd>
                <dt className="text-muted">{t('certs.serial')}</dt>
                <dd className="selectable">{cert.serial}</dd>
                <dt className="text-muted">{t('certs.ca')}</dt>
                <dd className="selectable truncate font-mono text-[11px]">{cert.caFingerprint}</dd>
                {cert.criticalOptions.length > 0 && (
                  <>
                    <dt className="text-muted">{t('certs.restrictions')}</dt>
                    <dd className="selectable">{cert.criticalOptions.join(', ')}</dd>
                  </>
                )}
              </>
            )}
          </dl>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <FileBadge size={15} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1 text-[12px] text-muted">{t('certs.none')}</span>
          <Button className="shrink-0 whitespace-nowrap" onClick={() => setEditing(true)} data-testid="cert-add">
            {t('certs.add')}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-[12px] text-danger">
          {error}
        </p>
      )}
      <CertificateDialog keyItem={editing ? keyItem : null} onClose={() => setEditing(false)} />
    </div>
  );
}

/** Paste or choose a "…-cert.pub" file; checked in main against the key before it's saved. */
export function CertificateDialog({ keyItem, onClose }: { keyItem: Key | null; onClose(): void }) {
  const { t } = useTranslation();
  const refresh = useVault((s) => s.refresh);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setText('');
    setError(null);
  }, [keyItem?.id]);

  const save = async () => {
    if (!keyItem || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await window.chh.keys.setCertificate({ id: keyItem.id, certificate: text.trim() });
      await refresh();
      onClose();
    } catch (err) {
      setError(t(errorKey(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!keyItem}
      onOpenChange={(o) => !o && onClose()}
      title={t('certs.addTitle', { label: keyItem?.label ?? '' })}
      description={t('certs.explain')}
      testId="cert-dialog"
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !text.trim()} onClick={() => void save()} data-testid="cert-save">
            {t('certs.attach')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t('certs.pasteLabel')} hint={t('certs.pasteHint')}>
          {(id, d) => (
            <textarea
              id={id}
              aria-describedby={d}
              autoFocus
              rows={5}
              spellCheck={false}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
              }}
              placeholder="ssh-ed25519-cert-v01@openssh.com AAAA…"
              className="w-full rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[12px] break-all focus:border-accent focus:outline-none"
              data-testid="cert-text"
            />
          )}
        </Field>
        <div className="flex items-center gap-2">
          <Button className="shrink-0 whitespace-nowrap" onClick={() => fileInput.current?.click()} data-testid="cert-choose-file">
            {t('certs.chooseFile')}
          </Button>
          <span className="text-[12px] text-muted">{t('certs.fileHint')}</span>
          <input
            ref={fileInput}
            type="file"
            accept=".pub,text/plain"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              if (file.size > 16_384) return setError(t('errors.fileTooLarge'));
              setText((await file.text()).trim());
              setError(null);
            }}
          />
        </div>
        {error && (
          <p role="alert" className="text-[12px] text-danger" data-testid="cert-error">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
