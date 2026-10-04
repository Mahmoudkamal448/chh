import type { IpcError } from '@cy-ssh/shared';

/** Extracts the i18n key from an IPC rejection (see preload). */
export function errorKey(err: unknown): string {
  const e = (err as { cyError?: IpcError })?.cyError;
  return e?.messageKey ?? 'errors.internal';
}

/** Session status messages are "i18nKey" or "i18nKey::detail". */
export function splitStatusMessage(msg: string | undefined): { key: string; detail?: string } | null {
  if (!msg) return null;
  const [key, ...rest] = msg.split('::');
  return { key: key!, detail: rest.length ? rest.join('::') : undefined };
}
