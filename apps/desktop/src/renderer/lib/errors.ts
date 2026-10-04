import { decodeIpcError, type IpcError } from '@chh/shared';

/** The structured error from an IPC rejection (see preload), or null for other errors. */
export function ipcError(err: unknown): IpcError | null {
  return decodeIpcError(err);
}

/** Extracts the i18n key from an IPC rejection. */
export function errorKey(err: unknown): string {
  return ipcError(err)?.messageKey ?? 'errors.internal';
}

/** i18n key + interpolation values ({{detail}}) for an IPC rejection. */
export function errorMessage(err: unknown): { key: string; detail: string } {
  const e = ipcError(err);
  return { key: e?.messageKey ?? 'errors.internal', detail: String(e?.details?.detail ?? '') };
}

/** Session status messages are "i18nKey" or "i18nKey::detail". */
export function splitStatusMessage(msg: string | undefined): { key: string; detail?: string } | null {
  if (!msg) return null;
  const [key, ...rest] = msg.split('::');
  return { key: key!, detail: rest.length ? rest.join('::') : undefined };
}
