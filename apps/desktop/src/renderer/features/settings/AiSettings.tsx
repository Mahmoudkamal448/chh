import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Checkbox, Field, Input } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { useApp } from '../../stores/app-store';

/** Optional AI suggestion provider (OpenAI-compatible). Off by default, explicit about what is sent. */
export function AiSettings() {
  const { t } = useTranslation();
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSettings);
  const ai = settings.ai;
  const [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    void window.cy.suggest.aiKeyStatus({}).then((s) => setHasKey(s.configured));
  }, []);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h3 className="flex items-center gap-2 text-[13px] font-semibold">
        <Sparkles size={15} /> {t('ai.title')}
      </h3>
      <p className="text-[12px] text-muted">{t('ai.hint')}</p>
      <Checkbox label={t('ai.enable')} checked={ai.enabled} onChange={(v) => void update({ ai: { ...ai, enabled: v } })} />
      {ai.enabled && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('ai.endpoint')} hint={t('ai.endpointHint')}>
              {(id, d) => (
                <Input id={id} aria-describedby={d} placeholder="https://api.example.com/v1" defaultValue={ai.endpoint} onBlur={(e) => void update({ ai: { ...ai, endpoint: e.target.value.trim() } })} />
              )}
            </Field>
            <Field label={t('ai.model')}>{(id) => <Input id={id} defaultValue={ai.model} onBlur={(e) => void update({ ai: { ...ai, model: e.target.value.trim() } })} />}</Field>
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field label={t('ai.key')} hint={hasKey ? t('ai.keySaved') : t('ai.keyHint')}>
                {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />}
              </Field>
            </div>
            <Button
              disabled={!key}
              onClick={async () => {
                await window.cy.suggest.setAiKey({ key });
                setKey('');
                setHasKey(true);
              }}
            >
              {t('common.save')}
            </Button>
            {hasKey && (
              <Button
                variant="ghost"
                onClick={async () => {
                  await window.cy.suggest.setAiKey({ key: null });
                  setHasKey(false);
                }}
              >
                {t('hostEditor.passwordRemove')}
              </Button>
            )}
          </div>
          <Checkbox label={t('ai.sendHistory')} checked={ai.sendHistory} onChange={(v) => void update({ ai: { ...ai, sendHistory: v } })} />
          <p className="rounded-md bg-surface-2 p-2 text-[12px] text-muted">{ai.sendHistory ? t('ai.privacyWithHistory') : t('ai.privacy')}</p>
          <Button
            className="self-start"
            onClick={async () => {
              setMsg(null);
              try {
                const r = await window.cy.suggest.ai({ line: 'list files by size', hostId: null, recent: [] });
                setMsg(t('ai.testOk', { example: r.suggestions[0] ?? '' }));
              } catch (err) {
                const { key: k, detail } = errorMessage(err);
                setMsg(t(k, { defaultValue: t('errors.internal'), detail }));
              }
            }}
          >
            {t('ai.test')}
          </Button>
          {msg && (
            <p role="status" className="text-[12px]">
              {msg}
            </p>
          )}
        </>
      )}
    </section>
  );
}
