import { Download, RefreshCw, Rocket, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import type { UpdateStatus } from '@chh/shared';
import { Button, Checkbox, Field, Select } from '../../components/ui';
import { useApp } from '../../stores/app-store';

const useUpdates = create<{ status: UpdateStatus | null; dismissed: string | null }>(() => ({ status: null, dismissed: null }));
window.chh.on('update.status', (status) => useUpdates.setState({ status }));
void window.chh.updates.status({}).then(
  (status) => useUpdates.setState({ status }),
  () => undefined,
);

/** Settings → Updates. */
export function UpdateSettings() {
  const { t, i18n } = useTranslation();
  const status = useUpdates((s) => s.status);
  const prefs = useApp((s) => s.settings.updates);
  const updateSettings = useApp((s) => s.updateSettings);
  const info = useApp((s) => s.info);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.chh.updates.status({}).then((s) => useUpdates.setState({ status: s }));
  }, []);

  if (!status) return null;
  const check = async () => {
    setBusy(true);
    try {
      useUpdates.setState({ status: await window.chh.updates.check({}) });
    } finally {
      setBusy(false);
    }
  };
  const when = status.lastCheckedAt ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(status.lastCheckedAt) : null;

  return (
    <div className="flex flex-col gap-4" data-testid="update-settings">
      <section className="flex flex-col gap-1">
        <h3 className="text-[13px] font-semibold">{t('updates.version', { version: info?.version ?? status.currentVersion })}</h3>
        {!status.supported ? (
          <p className="text-[12px] text-muted" data-testid="update-unsupported">
            {t(`updates.unsupported.${status.reason ?? 'dev'}`)}{' '}
            <button type="button" className="text-accent underline" onClick={() => void window.chh.app.openExternal({ url: status.downloadUrl })}>
              {t('updates.releases')}
            </button>
          </p>
        ) : (
          <p className="text-[12px] text-muted" role="status" data-testid="update-state">
            {t(`updates.state.${status.state}`, { version: status.version ?? '', progress: status.progress ?? 0 })}
            {status.state === 'error' && status.error ? ` ${t(status.error)}` : ''}
            {when && status.state !== 'checking' ? ` · ${t('updates.lastChecked', { when })}` : ''}
          </p>
        )}
      </section>
      {status.supported && (
        <>
          <div className="flex gap-2">
            <Button onClick={() => void check()} disabled={busy || status.state === 'checking' || status.state === 'downloading'} data-testid="update-check">
              <RefreshCw size={14} /> {t('updates.check')}
            </Button>
            {status.state === 'available' && (
              <Button variant="primary" onClick={() => void window.chh.updates.download({})}>
                <Download size={14} /> {t('updates.download')}
              </Button>
            )}
            {status.state === 'downloaded' && (
              <Button variant="primary" onClick={() => void window.chh.updates.install({})}>
                <Rocket size={14} /> {t('updates.install')}
              </Button>
            )}
          </div>
          {status.releaseNotes && (status.state === 'available' || status.state === 'downloaded' || status.state === 'downloading') && (
            <pre className="selectable max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-3 text-[12px]">
              {status.releaseNotes}
            </pre>
          )}
        </>
      )}
      <section className="flex flex-col gap-3">
        <Checkbox label={t('updates.auto')} checked={prefs.auto} onChange={(auto) => void updateSettings({ updates: { ...prefs, auto } })} />
        <Field label={t('updates.channel')} hint={t('updates.channelHint')}>
          {(id, d) => (
            <Select
              id={id}
              aria-describedby={d}
              className="w-56"
              value={prefs.channel}
              onChange={(e) => void updateSettings({ updates: { ...prefs, channel: e.target.value as 'latest' | 'beta' } })}
            >
              <option value="latest">{t('updates.channels.latest')}</option>
              <option value="beta">{t('updates.channels.beta')}</option>
            </Select>
          )}
        </Field>
        <p className="text-[12px] text-muted">{t('updates.privacy')}</p>
      </section>
    </div>
  );
}

/** A slim bar shown when an update has been downloaded and is ready to install. */
export function UpdateBanner() {
  const { t } = useTranslation();
  const status = useUpdates((s) => s.status);
  const dismissed = useUpdates((s) => s.dismissed);
  if (!status || status.state !== 'downloaded' || dismissed === status.version) return null;
  return (
    <div className="flex items-center gap-3 border-b border-border bg-accent/10 px-4 py-1.5 text-[12px]" role="status" data-testid="update-banner">
      <Rocket size={14} className="text-accent" />
      <span className="flex-1">{t('updates.ready', { version: status.version ?? '' })}</span>
      <Button variant="primary" className="h-6" onClick={() => void window.chh.updates.install({})}>
        {t('updates.install')}
      </Button>
      <button
        type="button"
        aria-label={t('common.dismiss')}
        className="rounded p-1 text-muted hover:bg-surface-2"
        onClick={() => useUpdates.setState({ dismissed: status.version })}
      >
        <X size={14} />
      </button>
    </div>
  );
}
