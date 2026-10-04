import { Fingerprint, Lock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LockState } from '@chh/shared';
import { Button, Input } from '../../components/ui';

/** Full-window lock screen. Covers (and blocks input to) everything underneath. */
export function LockScreen({ state }: { state: LockState }) {
  const { t } = useTranslation();
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(state.retryAfter);
  const inputRef = useRef<HTMLInputElement>(null);
  const startup = state.locked === 'startup';
  const usesPassword = state.masterPassword;
  const canBiometric = !startup && state.settings.biometric && state.biometricAvailable !== 'none';

  useEffect(() => {
    // Keep focus away from terminals behind the overlay.
    (document.activeElement as HTMLElement | null)?.blur();
    inputRef.current?.focus();
  }, []);

  useEffect(() => setWait(state.retryAfter), [state.retryAfter]);
  useEffect(() => {
    if (wait <= 0) return;
    const h = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(h);
  }, [wait]);

  const unlock = async (biometric = false) => {
    setBusy(true);
    setError(null);
    const res = await window.chh.lock.unlock(biometric ? { biometric: true } : { secret });
    setBusy(false);
    if (!res.ok) {
      setSecret('');
      setError(biometric ? t('lock.biometricFailed') : usesPassword ? t('lock.wrongPassword') : t('lock.wrongPasscode'));
      inputRef.current?.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-bg/95 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('lock.title')}
      data-testid="lock-screen"
      onKeyDownCapture={(e) => e.stopPropagation()}
    >
      <form
        className="flex w-[340px] flex-col items-center gap-4 rounded-xl border border-border bg-surface p-8 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (secret && wait <= 0) void unlock();
        }}
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2">
          <Lock size={22} />
        </div>
        <div className="text-center">
          <h1 className="text-[16px] font-semibold">{startup ? t('lock.startupTitle') : t('lock.title')}</h1>
          <p className="mt-1 text-[12px] text-muted">{startup ? t('lock.startupHint') : usesPassword ? t('lock.passwordHint') : t('lock.passcodeHint')}</p>
        </div>
        <Input
          ref={inputRef}
          type="password"
          autoComplete="current-password"
          aria-label={usesPassword ? t('lock.masterPassword') : t('lock.passcode')}
          placeholder={usesPassword ? t('lock.masterPassword') : t('lock.passcode')}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          disabled={busy || wait > 0}
          data-testid="lock-input"
        />
        {error && (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        )}
        {wait > 0 && <p className="text-[12px] text-muted">{t('lock.tooManyAttempts', { seconds: wait })}</p>}
        <Button type="submit" variant="primary" className="w-full" disabled={busy || !secret || wait > 0} data-testid="lock-submit">
          {busy && startup ? t('lock.opening') : t('lock.unlock')}
        </Button>
        {canBiometric && (
          <Button className="w-full" onClick={() => void unlock(true)} disabled={busy || wait > 0}>
            <Fingerprint size={14} /> {state.biometricAvailable === 'touchid' ? t('lock.useTouchId') : t('lock.useWindowsHello')}
          </Button>
        )}
        {startup && <p className="text-center text-[11px] text-muted">{t('lock.forgotMaster')}</p>}
      </form>
    </div>
  );
}
