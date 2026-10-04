import QRCode from 'qrcode';
import { Cloud, KeyRound, Laptop, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../../components/Dialog';
import { Button, Checkbox, Field, IconButton, Input } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { formatDate } from '../../lib/format';
import { useSecurity } from '../../stores/lock-store';

type Devices = Awaited<ReturnType<typeof window.chh.sync.devices>>;

function useErr() {
  const { t } = useTranslation();
  return (err: unknown) => {
    const { key, detail } = errorMessage(err);
    return t(key, { defaultValue: t('sync.error.generic', { detail }), detail });
  };
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border p-4">
      <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
        {icon} {title}
      </h3>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

/** Shows the recovery key once, and won't close until the user confirms they saved it. */
function RecoveryKeyDialog({ value, onDone }: { value: string | null; onDone(): void }) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [value]);
  return (
    <Dialog
      open={!!value}
      onOpenChange={() => undefined}
      dismissable={false}
      title={t('sync.recoveryTitle')}
      description={t('sync.recoveryHint')}
      testId="recovery-key-dialog"
      footer={
        <Button variant="primary" disabled={!saved} onClick={onDone} data-testid="recovery-done">
          {t('common.done')}
        </Button>
      }
    >
      <p className="selectable rounded-md bg-surface-2 p-3 text-center font-mono text-[13px] tracking-wide" data-testid="recovery-key">
        {value}
      </p>
      <div className="mt-3 flex items-center justify-between">
        <Button onClick={() => void navigator.clipboard.writeText(value ?? '')}>{t('keys.copy')}</Button>
        <Checkbox label={t('sync.recoverySaved')} checked={saved} onChange={setSaved} />
      </div>
    </Dialog>
  );
}

function SignedOut({ onRecoveryKey }: { onRecoveryKey(key: string): void }) {
  const { t } = useTranslation();
  const err = useErr();
  const [mode, setMode] = useState<'login' | 'register' | 'recover'>('login');
  const [serverUrl, setServerUrl] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const insecure = /^http:\/\//i.test(serverUrl.trim());

  const submit = async () => {
    setError(null);
    if (mode !== 'login' && password !== confirm) return setError(t('sync.passwordMismatch'));
    if (mode !== 'login' && password.length < 10) return setError(t('sync.passwordTooShort'));
    setBusy(true);
    try {
      if (mode === 'register') {
        const { recoveryKey: k } = await window.chh.sync.register({ serverUrl, email, password });
        onRecoveryKey(k);
      } else {
        const second = totp ? (/^\d{6}$/.test(totp) ? { totp } : { recoveryCode: totp }) : {};
        const res =
          mode === 'login'
            ? await window.chh.sync.login({ serverUrl, email, password, ...second })
            : await window.chh.sync.recover({ serverUrl, email, recoveryKey, newPassword: password, ...second });
        if (res.status === 'totp_required') {
          setNeedTotp(true);
          setError(totp ? t('sync.error.invalid_totp') : null);
        }
      }
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12px] text-muted">{t('sync.intro')}</p>
      <div role="tablist" className="flex gap-1">
        {(['login', 'register', 'recover'] as const).map((m) => (
          <Button key={m} variant={mode === m ? 'secondary' : 'ghost'} onClick={() => (setMode(m), setError(null), setNeedTotp(false))} data-testid={`sync-mode-${m}`}>
            {t(`sync.mode.${m}`)}
          </Button>
        ))}
      </div>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={t('sync.serverUrl')} hint={insecure ? t('sync.insecureHint') : t('sync.serverHint')}>
          {(id, d) => <Input id={id} aria-describedby={d} placeholder="https://sync.example.com" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} data-testid="sync-server" />}
        </Field>
        <Field label={t('sync.email')}>{(id) => <Input id={id} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="sync-email" />}</Field>
        {mode === 'recover' && (
          <Field label={t('sync.recoveryKey')}>
            {(id) => <Input id={id} className="font-mono" value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} placeholder="XXXX-XXXX-…" data-testid="sync-recovery-key" />}
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={mode === 'recover' ? t('sync.newPassword') : t('sync.password')} hint={mode === 'login' ? undefined : t('sync.passwordHint')}>
            {(id, d) => (
              <Input
                id={id}
                aria-describedby={d}
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="sync-password"
              />
            )}
          </Field>
          {mode !== 'login' && (
            <Field label={t('lock.confirm')}>
              {(id) => <Input id={id} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="sync-password-confirm" />}
            </Field>
          )}
        </div>
        {needTotp && (
          <Field label={t('sync.totpCode')} hint={t('sync.totpHint')}>
            {(id, d) => <Input id={id} aria-describedby={d} autoFocus inputMode="numeric" value={totp} onChange={(e) => setTotp(e.target.value.trim())} data-testid="sync-totp" />}
          </Field>
        )}
        {mode === 'register' && <p className="rounded-md bg-warning-bg p-2 text-[12px] text-warning-fg">{t('sync.zeroKnowledgeWarning')}</p>}
        {error && (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="self-start" disabled={busy || !serverUrl || !email || !password} data-testid="sync-submit">
          {busy ? t('sync.working') : t(`sync.submit.${mode}`)}
        </Button>
      </form>
    </div>
  );
}

function TwoFactor({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  const err = useErr();
  const [setup, setSetup] = useState<{ secret: string; uri: string; svg: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);
    try {
      const s = await window.chh.sync.totpSetup({});
      setSetup({ ...s, svg: await QRCode.toString(s.uri, { type: 'svg', margin: 1, width: 168 }) });
    } catch (e) {
      setError(err(e));
    }
  };

  return (
    <Section icon={<ShieldCheck size={15} />} title={t('sync.twoFactor')}>
      <p className="text-[12px] text-muted">{t('sync.twoFactorHint')}</p>
      {enabled && !codes ? (
        <div className="flex items-end gap-2">
          <span className="text-[13px] text-[#2f9e44]">{t('sync.twoFactorOn')}</span>
          <div className="ml-auto w-44">
            <Field label={t('sync.totpCode')}>{(id) => <Input id={id} value={code} onChange={(e) => setCode(e.target.value.trim())} />}</Field>
          </div>
          <Button
            disabled={!code}
            onClick={async () => {
              try {
                await window.chh.sync.totpDisable(/^\d{6}$/.test(code) ? { code } : { recoveryCode: code });
                setCode('');
              } catch (e) {
                setError(err(e));
              }
            }}
          >
            {t('sync.twoFactorDisable')}
          </Button>
        </div>
      ) : codes ? (
        <div data-testid="totp-recovery-codes">
          <p className="mb-2 text-[12px]">{t('sync.recoveryCodesHint')}</p>
          <ul className="selectable grid grid-cols-2 gap-1 font-mono text-[12px]">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <Button className="mt-2" onClick={() => setCodes(null)}>
            {t('common.done')}
          </Button>
        </div>
      ) : setup ? (
        <div className="flex gap-4">
          <div className="shrink-0 rounded bg-white p-1" aria-label={t('sync.qr')} dangerouslySetInnerHTML={{ __html: setup.svg }} />
          <div className="flex flex-col gap-2">
            <p className="text-[12px]">{t('sync.scanHint')}</p>
            <p className="selectable break-all font-mono text-[12px]" data-testid="totp-secret">
              {setup.secret}
            </p>
            <Field label={t('sync.totpCode')}>{(id) => <Input id={id} inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.trim())} data-testid="totp-code" />}</Field>
            <Button
              variant="primary"
              className="self-start"
              disabled={!/^\d{6}$/.test(code)}
              onClick={async () => {
                try {
                  const r = await window.chh.sync.totpEnable({ code });
                  setCodes(r.recoveryCodes);
                  setSetup(null);
                  setCode('');
                } catch (e) {
                  setError(err(e));
                }
              }}
              data-testid="totp-enable"
            >
              {t('sync.twoFactorConfirm')}
            </Button>
          </div>
        </div>
      ) : (
        <Button className="self-start" onClick={() => void start()} data-testid="totp-setup">
          {t('sync.twoFactorEnable')}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      )}
    </Section>
  );
}

function SignedIn() {
  const { t } = useTranslation();
  const err = useErr();
  const status = useSecurity((s) => s.sync)!;
  const [devices, setDevices] = useState<Devices>([]);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [keepData, setKeepData] = useState(true);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [deletePw, setDeletePw] = useState('');

  const loadDevices = () => window.chh.sync.devices({}).then(setDevices, () => undefined);
  useEffect(() => {
    void loadDevices();
  }, []);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ kind: 'ok', text: ok });
    } catch (e) {
      setMsg({ kind: 'error', text: err(e) });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Section icon={<Cloud size={15} />} title={t('sync.account')}>
        <div className="flex items-center gap-3" data-testid="sync-status" data-state={status.state}>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium">{status.email}</p>
            <p className="truncate text-[12px] text-muted">{status.serverUrl}</p>
            <p className="text-[12px] text-muted">
              {t(`sync.state.${status.state}`)}
              {status.lastSyncAt ? ` · ${t('sync.lastSync', { time: formatDate(status.lastSyncAt) })}` : ''}
              {status.pending ? ` · ${t('sync.pending', { count: status.pending })}` : ''}
            </p>
            {status.error && <p className="text-[12px] text-danger">{t(status.error, { defaultValue: t('sync.error.generic'), detail: '' })}</p>}
          </div>
          <Button onClick={() => void act(() => window.chh.sync.syncNow({}))} data-testid="sync-now">
            {t('sync.syncNow')}
          </Button>
        </div>
      </Section>

      <Section icon={<Laptop size={15} />} title={t('sync.devices')}>
        <ul className="flex flex-col gap-1">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center gap-2 text-[13px]">
              <span className="truncate">{d.name}</span>
              <span className="text-[11px] text-muted">
                {d.platform} · {t('sync.seen', { time: formatDate(d.lastSeenAt) })}
              </span>
              {d.current ? (
                <span className="ml-auto text-[11px] text-muted">{t('sync.thisDevice')}</span>
              ) : (
                <IconButton
                  label={t('sync.removeDevice')}
                  className="ml-auto"
                  onClick={() => void act(async () => (await window.chh.sync.removeDevice({ id: d.id }), await loadDevices()))}
                >
                  ×
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <TwoFactor enabled={status.totpEnabled} />

      <Section icon={<KeyRound size={15} />} title={t('sync.changePassword')}>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('sync.currentPassword')}>{(id) => <Input id={id} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>
          <Field label={t('sync.newPassword')} hint={t('sync.passwordHint')}>
            {(id, d) => <Input id={id} aria-describedby={d} type="password" value={next} onChange={(e) => setNext(e.target.value)} />}
          </Field>
        </div>
        <Button
          className="self-start"
          disabled={!current || next.length < 10}
          onClick={() => void act(async () => (await window.chh.sync.changePassword({ current, next }), setCurrent(''), setNext('')), t('sync.passwordChanged'))}
        >
          {t('sync.changePassword')}
        </Button>
      </Section>

      <section className="flex flex-wrap items-end gap-3 rounded-lg border border-border p-4">
        <Checkbox label={t('sync.keepData')} checked={keepData} onChange={setKeepData} />
        <Button onClick={() => void act(() => window.chh.sync.logout({ keepData }))} data-testid="sync-logout">
          {t('sync.signOut')}
        </Button>
        <div className="ml-auto flex items-end gap-2">
          <div className="w-44">
            <Field label={t('sync.password')}>{(id) => <Input id={id} type="password" value={deletePw} onChange={(e) => setDeletePw(e.target.value)} />}</Field>
          </div>
          <Button variant="danger" disabled={!deletePw} onClick={() => void act(() => window.chh.sync.deleteAccount({ password: deletePw }))}>
            {t('sync.deleteAccount')}
          </Button>
        </div>
      </section>
      {msg && (
        <p role={msg.kind === 'error' ? 'alert' : 'status'} className={msg.kind === 'error' ? 'text-[12px] text-danger' : 'text-[12px] text-[#2f9e44]'}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

export function SyncSettings() {
  const status = useSecurity((s) => s.sync);
  // Lives here (not in the sign-up form) because signing up immediately switches to the signed-in
  // view; the recovery key must stay on screen until the user confirms they saved it.
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  useEffect(() => {
    void window.chh.sync.status({}).then((s) => useSecurity.getState().setSync(s));
  }, []);
  if (!status) return null;
  return (
    <>
      {status.signedIn ? <SignedIn /> : <SignedOut onRecoveryKey={setRecoveryKey} />}
      <RecoveryKeyDialog value={recoveryKey} onDone={() => setRecoveryKey(null)} />
    </>
  );
}
