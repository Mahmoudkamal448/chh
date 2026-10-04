import { ShieldAlert, ShieldQuestion } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthPrompt, HostKeyPrompt } from '@cy-ssh/shared';
import { Dialog } from '../../components/Dialog';
import { Button, Checkbox, Field, Input } from '../../components/ui';
import { usePrompts } from '../../stores/prompts-store';

function HostKeyDialog({ p }: { p: HostKeyPrompt }) {
  const { t } = useTranslation();
  const remove = usePrompts((s) => s.remove);
  const changed = !!p.previousFingerprint;
  const respond = (decision: 'accept-save' | 'accept-once' | 'reject') => {
    remove(p.promptId);
    void window.cy.sessions.respondHostKey({ promptId: p.promptId, decision });
  };
  return (
    <Dialog
      open
      onOpenChange={() => undefined}
      dismissable={false}
      testId="hostkey-dialog"
      title={changed ? t('hostKey.changedTitle') : t('hostKey.newTitle')}
      width="w-[560px]"
      footer={
        changed ? (
          <>
            <Button variant="primary" onClick={() => respond('reject')} autoFocus>
              {t('hostKey.disconnect')}
            </Button>
            <Button variant="danger" onClick={() => respond('accept-save')}>
              {t('hostKey.replaceAndConnect')}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => respond('reject')}>{t('common.cancel')}</Button>
            <Button onClick={() => respond('accept-once')}>{t('hostKey.connectOnce')}</Button>
            <Button variant="primary" onClick={() => respond('accept-save')} autoFocus data-testid="hostkey-accept">
              {t('hostKey.trustAndConnect')}
            </Button>
          </>
        )
      }
    >
      <div className="flex gap-3">
        {changed ? <ShieldAlert className="shrink-0 text-danger" size={28} /> : <ShieldQuestion className="shrink-0 text-accent" size={28} />}
        <div className="flex min-w-0 flex-col gap-3 text-[13px]">
          {changed ? (
            <p role="alert" className="rounded-md bg-warning-bg p-2.5 text-warning-fg">
              {t('hostKey.changedWarning', { host: p.hostPattern })}
            </p>
          ) : (
            <p>{t('hostKey.newExplain', { host: p.hostPattern })}</p>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted">{t('hostKey.host')}</dt>
            <dd className="selectable font-mono">{p.hostPattern}</dd>
            <dt className="text-muted">{t('hostKey.keyType')}</dt>
            <dd className="selectable font-mono">{p.keyType}</dd>
            <dt className="text-muted">{t('hostKey.fingerprint')}</dt>
            <dd className="selectable break-all font-mono" data-testid="hostkey-fingerprint">
              {p.fingerprint}
            </dd>
            {changed && (
              <>
                <dt className="text-muted">{t('hostKey.previous')}</dt>
                <dd className="selectable break-all font-mono text-muted">{p.previousFingerprint}</dd>
              </>
            )}
          </dl>
          {!changed && p.previousKeyType && <p className="text-muted">{t('hostKey.otherTypeKnown', { type: p.previousKeyType })}</p>}
        </div>
      </div>
    </Dialog>
  );
}

function AuthDialog({ p }: { p: AuthPrompt }) {
  const { t } = useTranslation();
  const remove = usePrompts((s) => s.remove);
  const [values, setValues] = useState<string[]>(() => p.prompts.map(() => ''));
  const [save, setSave] = useState(false);

  useEffect(() => setValues(p.prompts.map(() => '')), [p.promptId]); // eslint-disable-line react-hooks/exhaustive-deps

  const respond = (responses: string[] | null) => {
    remove(p.promptId);
    void window.cy.sessions.respondAuth({ promptId: p.promptId, responses, save: save && !!responses });
  };
  const title = p.kind === 'username' ? t('auth.usernameTitle', { host: p.hostLabel }) : t('auth.title', { target: p.title });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && respond(null)}
      title={title}
      description={p.instructions || undefined}
      width="w-[440px]"
      testId="auth-dialog"
      footer={
        <>
          <Button onClick={() => respond(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => respond(values)} data-testid="auth-submit">
            {t('auth.continue')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          respond(values);
        }}
      >
        {p.retry && (
          <p role="alert" className="text-[12px] text-danger">
            {t('auth.retry')}
          </p>
        )}
        {p.prompts.map((q, i) => (
          <Field key={i} label={q.prompt.replace(/:\s*$/, '')}>
            {(id) => (
              <Input
                id={id}
                autoFocus={i === 0}
                type={q.echo ? 'text' : 'password'}
                autoComplete="off"
                value={values[i] ?? ''}
                onChange={(e) => setValues((v) => v.map((x, j) => (j === i ? e.target.value : x)))}
                data-testid={`auth-input-${i}`}
              />
            )}
          </Field>
        ))}
        {p.canSave && <Checkbox label={t('auth.remember')} checked={save} onChange={setSave} />}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function Prompts() {
  const current = usePrompts((s) => s.queue[0]);
  if (!current) return null;
  return current.type === 'hostkey' ? <HostKeyDialog key={current.data.promptId} p={current.data} /> : <AuthDialog key={current.data.promptId} p={current.data} />;
}
