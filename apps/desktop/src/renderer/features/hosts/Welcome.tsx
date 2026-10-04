import { FileDown, KeyRound, Plus, Zap } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '../../components/ui';
import { parseQuickTarget } from '../../lib/quick-connect';
import { useApp } from '../../stores/app-store';
import { useTabs } from '../../stores/tabs-store';

/** "user@host:port" (or a pasted ssh command) → a terminal, without saving a host. */
export function QuickConnect() {
  const { t } = useTranslation();
  const openQuick = useTabs((s) => s.openQuick);
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  const connect = () => {
    const target = parseQuickTarget(value);
    if (!target) return setError(true);
    setError(false);
    setValue('');
    void openQuick(target);
  };
  return (
    <form
      className="flex items-center gap-2 border-b border-border px-4 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        connect();
      }}
      data-testid="quick-connect"
    >
      <Zap size={14} className="shrink-0 text-muted" aria-hidden />
      <label htmlFor="quick-connect-input" className="shrink-0 text-[12px] font-medium text-muted">
        {t('quick.label')}
      </label>
      <Input
        id="quick-connect-input"
        className="max-w-md font-mono text-[12px]"
        placeholder={t('quick.placeholder')}
        value={value}
        aria-invalid={error}
        aria-describedby={error ? 'quick-connect-error' : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          setError(false);
        }}
        data-testid="quick-connect-input"
      />
      <Button type="submit" disabled={!value.trim()} data-testid="quick-connect-go">
        {t('quick.connect')}
      </Button>
      {error && (
        <span id="quick-connect-error" role="alert" className="text-[12px] text-danger">
          {t('quick.invalid')}
        </span>
      )}
    </form>
  );
}

/** First launch: what to do next, instead of an empty list. */
export function Welcome({ onNewHost, onImport }: { onNewHost(): void; onImport(): void }) {
  const { t } = useTranslation();
  const setSection = useApp((s) => s.setSection);
  const cards = [
    { icon: Plus, title: t('welcome.newHost'), body: t('welcome.newHostBody'), action: onNewHost, testId: 'welcome-new-host', primary: true },
    { icon: FileDown, title: t('welcome.import'), body: t('welcome.importBody'), action: onImport, testId: 'welcome-import' },
    { icon: KeyRound, title: t('welcome.keys'), body: t('welcome.keysBody'), action: () => setSection('keys'), testId: 'welcome-keys' },
  ];
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 overflow-y-auto p-8" data-testid="welcome">
      <div className="text-center">
        <h2 className="text-[20px] font-semibold">{t('welcome.title')}</h2>
        <p className="mt-1 max-w-md text-[13px] text-muted">{t('welcome.subtitle')}</p>
      </div>
      <div className="grid w-full max-w-3xl grid-cols-1 gap-3 sm:grid-cols-3">
        {cards.map(({ icon: Icon, title, body, action, testId, primary }) => (
          <button
            key={testId}
            type="button"
            onClick={action}
            className={
              'flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-focus ' +
              (primary ? 'border-accent bg-accent/5 hover:bg-accent/10' : 'border-border bg-surface hover:bg-surface-2')
            }
            data-testid={testId}
          >
            <span className={'flex h-9 w-9 items-center justify-center rounded-lg ' + (primary ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-fg')}>
              <Icon size={18} aria-hidden />
            </span>
            <span className="font-medium">{title}</span>
            <span className="text-[12px] text-muted">{body}</span>
          </button>
        ))}
      </div>
      <p className="text-[12px] text-muted">{t('welcome.quickHint')}</p>
    </div>
  );
}
