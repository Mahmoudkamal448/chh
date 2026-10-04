import { AlertTriangle, Check, Copy, Loader2, Pencil, RotateCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui';
import { cn } from '../../lib/cn';
import { useHosts } from '../../stores/hosts-store';
import type { TermPane } from '../../stores/tabs-store';

/** Errors with a hint on what to check, keyed by the message's i18n key. */
const HINTS = new Set(['timeout', 'dns', 'refused', 'unreachable', 'auth', 'reset', 'jump']);

/** "user@address:port" for what this pane connects to, when known. */
function useTarget(pane: TermPane): string | null {
  const [target, setTarget] = useState<string | null>(null);
  const source = pane.source;
  useEffect(() => {
    if (source.kind === 'quick') setTarget(`${source.username ? `${source.username}@` : ''}${source.host}:${source.port}`);
    else if (source.kind === 'host')
      void window.chh.hosts.get({ id: source.hostId }).then(
        (h) => setTarget(h.protocol === 'serial' ? h.address : `${h.settings.username ? `${h.settings.username}@` : ''}${h.address}${h.settings.port ? `:${h.settings.port}` : ''}`),
        () => setTarget(null),
      );
    else setTarget(null);
  }, [source]);
  return target;
}

/**
 * What a terminal shows while it isn't a working shell: a card with progress while connecting (and a
 * Cancel), an explained error with Retry / Edit host / Copy details, or a bar once a session has ended.
 */
export function SessionOverlay({
  pane,
  message,
  exitCode,
  split,
  onReconnect,
  onClose,
}: {
  pane: TermPane;
  message: { key: string; detail?: string } | null;
  exitCode: number | null | undefined;
  split: boolean;
  onReconnect(): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const openEditor = useHosts((s) => s.openEditor);
  const target = useTarget(pane);
  const [copied, setCopied] = useState(false);
  const connecting = pane.status === 'connecting' || pane.status === 'authenticating';
  const remote = pane.source.kind !== 'local';
  const failed = pane.status === 'error' && !!message;

  if (connecting) {
    // Local shells start instantly: a small hint is enough.
    if (!remote)
      return (
        <div className="pointer-events-none absolute left-1/2 top-4 z-30 -translate-x-1/2 rounded-md bg-surface/90 px-3 py-1.5 text-[12px] text-muted shadow" role="status" data-testid="session-overlay">
          {t('session.connecting')}
        </div>
      );
    const steps = [
      { id: 'connect', label: t('session.step.connect'), state: pane.status === 'connecting' ? 'active' : 'done' },
      { id: 'login', label: t('session.step.login'), state: pane.status === 'authenticating' ? 'active' : 'pending' },
    ] as const;
    return (
      <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/40" data-testid="session-overlay">
        <div className="w-80 rounded-xl border border-border bg-surface p-4 text-fg shadow-2xl" role="status" aria-live="polite">
          <p className="font-semibold">{t('session.connectingTo', { name: pane.title })}</p>
          {target && !pane.title.startsWith(target.replace(/:22$/, '')) && <p className="selectable mt-0.5 truncate font-mono text-[12px] text-muted">{target}</p>}
          <ol className="mt-3 flex flex-col gap-1.5">
            {steps.map((s) => (
              <li key={s.id} className={cn('flex items-center gap-2 text-[13px]', s.state === 'pending' && 'text-muted')} data-testid={`step-${s.id}`} data-state={s.state}>
                {s.state === 'done' ? (
                  <Check size={14} className="text-success" aria-hidden />
                ) : s.state === 'active' ? (
                  <Loader2 size={14} className="animate-spin text-accent" aria-hidden />
                ) : (
                  <span className="h-3.5 w-3.5 rounded-full border border-border" aria-hidden />
                )}
                {s.label}
              </li>
            ))}
          </ol>
          <div className="mt-4 flex justify-end">
            <Button onClick={onClose} data-testid="connect-cancel">
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (failed) {
    const text = t(message.key, { defaultValue: t('session.error.generic'), detail: message.detail ?? '' });
    const code = message.key.replace(/^session\.error\./, '');
    const hint = HINTS.has(code) ? t(`session.hint.${code}`, { target: target ?? pane.title }) : null;
    return (
      <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/40" data-testid="session-overlay">
        <div className="w-[32rem] max-w-[calc(100%-2rem)] rounded-xl border border-border bg-surface p-4 text-fg shadow-2xl" role="alert" data-testid="session-error">
          <div className="flex items-start gap-3">
            <AlertTriangle size={20} className="mt-0.5 shrink-0 text-danger" aria-hidden />
            <div className="min-w-0">
              <p className="font-semibold">{t('session.failedTitle', { name: pane.title })}</p>
              <p className="selectable mt-1 text-[13px]">{text}</p>
              {hint && <p className="mt-1.5 text-[12px] text-muted">{hint}</p>}
              {target && <p className="selectable mt-1.5 truncate font-mono text-[11px] text-muted">{target}</p>}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="ghost"
              onClick={async () => {
                await navigator.clipboard.writeText([`${pane.title}${target ? ` (${target})` : ''}`, text, new Date().toISOString()].join('\n'));
                setCopied(true);
              }}
              className="mr-auto"
              data-testid="error-copy"
            >
              <Copy size={13} /> {copied ? t('keys.copied') : t('session.copyDetails')}
            </Button>
            {pane.source.kind === 'host' && (
              <Button onClick={() => openEditor({ kind: 'host', id: (pane.source as { hostId: string }).hostId })} data-testid="error-edit-host">
                <Pencil size={13} /> {t('session.editHost')}
              </Button>
            )}
            <Button onClick={onClose}>
              <X size={13} /> {split ? t('session.closePane') : t('session.closeTab')}
            </Button>
            <Button variant="primary" onClick={onReconnect} data-testid="reconnect">
              <RotateCw size={13} /> {t('session.retry')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Ended normally (or failed without details): a bar that leaves the scrollback readable.
  return (
    <div className="absolute inset-x-0 bottom-0 z-30 flex items-center gap-3 border-t border-border bg-surface/95 px-4 py-2.5" role="status" data-testid="session-overlay">
      <span className="text-[13px]">{exitCode !== undefined && exitCode !== null ? t('session.exited', { code: exitCode }) : t('session.closed')}</span>
      <span className="ml-auto flex gap-2">
        <Button variant="primary" onClick={onReconnect} data-testid="reconnect">
          {t('session.reconnect')}
        </Button>
        <Button onClick={onClose}>{split ? t('session.closePane') : t('session.closeTab')}</Button>
      </span>
    </div>
  );
}
