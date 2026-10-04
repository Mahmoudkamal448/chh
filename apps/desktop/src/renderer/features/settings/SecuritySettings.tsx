import { Lock, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Checkbox, Field, Input, Select } from '../../components/ui';
import { errorKey } from '../../lib/errors';
import { useSecurity } from '../../stores/lock-store';

const AUTO_LOCK = [0, 1, 5, 15, 30, 60, 240];

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border p-4">
      <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
        {icon} {title}
      </h3>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

export function SecuritySettings() {
  const { t } = useTranslation();
  const state = useSecurity((s) => s.lock);
  const setLock = useSecurity((s) => s.setLock);
  const [passcode, setPasscode] = useState('');
  const [confirm, setConfirm] = useState('');
  const [secret, setSecret] = useState('');
  const [master, setMaster] = useState('');
  const [masterConfirm, setMasterConfirm] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!state) return null;
  const s = state.settings;

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ kind: 'ok', text: ok });
      setLock(await window.chh.lock.state({}));
    } catch (err) {
      setMsg({ kind: 'error', text: t(errorKey(err)) });
    } finally {
      setBusy(false);
    }
  };

  const enable = () => {
    if (!state.masterPassword) {
      if (passcode.length < 4) return setMsg({ kind: 'error', text: t('lock.passcodeTooShort') });
      if (passcode !== confirm) return setMsg({ kind: 'error', text: t('lock.passcodeMismatch') });
    }
    void run(() => window.chh.lock.configure({ passcode: state.masterPassword ? undefined : passcode, settings: { enabled: true } }), t('lock.enabled'));
    setPasscode('');
    setConfirm('');
  };

  return (
    <div className="flex flex-col gap-4">
      <Card icon={<Lock size={15} />} title={t('lock.screenTitle')}>
        <p className="text-[12px] text-muted">{t('lock.screenHint')}</p>
        {!s.enabled ? (
          <>
            {!state.masterPassword && (
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('lock.passcode')}>
                  {(id) => <Input id={id} type="password" autoComplete="new-password" value={passcode} onChange={(e) => setPasscode(e.target.value)} data-testid="lock-passcode" />}
                </Field>
                <Field label={t('lock.confirm')}>
                  {(id) => <Input id={id} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="lock-passcode-confirm" />}
                </Field>
              </div>
            )}
            <Button variant="primary" className="self-start" disabled={busy} onClick={enable} data-testid="lock-enable">
              {t('lock.enable')}
            </Button>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('lock.autoLock')}>
                {(id) => (
                  <Select id={id} value={s.autoLockMinutes} onChange={(e) => void run(() => window.chh.lock.configure({ settings: { autoLockMinutes: Number(e.target.value) } }))}>
                    {AUTO_LOCK.map((m) => (
                      <option key={m} value={m}>
                        {m === 0 ? t('lock.never') : t('lock.afterMinutes', { count: m })}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <Checkbox label={t('lock.lockOnSleep')} checked={s.lockOnSleep} onChange={(v) => void run(() => window.chh.lock.configure({ settings: { lockOnSleep: v } }))} />
            {state.biometricAvailable !== 'none' && (
              <Checkbox
                label={state.biometricAvailable === 'touchid' ? t('lock.allowTouchId') : t('lock.allowWindowsHello')}
                checked={s.biometric}
                onChange={(v) => void run(() => window.chh.lock.configure({ settings: { biometric: v } }))}
              />
            )}
            <div className="flex items-end gap-2">
              <Button onClick={() => void window.chh.lock.lockNow({})} data-testid="lock-now">
                {t('lock.lockNow')}
              </Button>
              <div className="ml-auto w-56">
                <Field label={state.masterPassword ? t('lock.masterPassword') : t('lock.currentPasscode')}>
                  {(id) => <Input id={id} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />}
                </Field>
              </div>
              <Button disabled={!secret || busy} onClick={() => void run(() => window.chh.lock.disable({ secret }), t('lock.disabled')).then(() => setSecret(''))}>
                {t('lock.disable')}
              </Button>
            </div>
          </>
        )}
      </Card>

      <Card icon={<ShieldCheck size={15} />} title={t('lock.masterTitle')}>
        <p className="text-[12px] text-muted">{t('lock.masterHint')}</p>
        {state.masterPassword ? (
          <div className="flex items-end gap-2">
            <span className="text-[13px] text-success">{t('lock.masterOn')}</span>
            <div className="ml-auto w-56">
              <Field label={t('lock.masterPassword')}>{(id) => <Input id={id} type="password" value={master} onChange={(e) => setMaster(e.target.value)} />}</Field>
            </div>
            <Button disabled={!master || busy} onClick={() => void run(() => window.chh.lock.removeMasterPassword({ password: master }), t('lock.masterRemoved')).then(() => setMaster(''))}>
              {t('lock.masterRemove')}
            </Button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('lock.masterPassword')} hint={t('lock.masterMin')}>
                {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" value={master} onChange={(e) => setMaster(e.target.value)} data-testid="master-password" />}
              </Field>
              <Field label={t('lock.confirm')}>
                {(id) => <Input id={id} type="password" autoComplete="new-password" value={masterConfirm} onChange={(e) => setMasterConfirm(e.target.value)} data-testid="master-password-confirm" />}
              </Field>
            </div>
            <p className="rounded-md bg-warning-bg p-2 text-[12px] text-warning-fg">{t('lock.masterWarning')}</p>
            <Button
              variant="primary"
              className="self-start"
              disabled={busy || master.length < 8 || master !== masterConfirm}
              onClick={() => void run(() => window.chh.lock.setMasterPassword({ password: master }), t('lock.masterEnabled')).then(() => (setMaster(''), setMasterConfirm('')))}
              data-testid="master-enable"
            >
              {busy ? t('lock.deriving') : t('lock.masterEnable')}
            </Button>
          </>
        )}
      </Card>
      {msg && (
        <p role={msg.kind === 'error' ? 'alert' : 'status'} className={msg.kind === 'error' ? 'text-[12px] text-danger' : 'text-[12px] text-success'}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
