import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { ZodError, type z } from 'zod';
import {
  EVENT_CHANNEL_PREFIX,
  allMethods,
  channel,
  contract,
  type Contract,
  type EventName,
  type EventPayload,
  type IpcError,
  type IpcResult,
  type MethodInput,
  type MethodOutput,
  type Namespace,
} from '@cy-ssh/shared';
import { errInfo, log } from '../log';

type Impl<NS extends Namespace, M extends keyof Contract[NS]> = Contract[NS][M] extends {
  input: z.ZodType;
  output: z.ZodType;
}
  ? (input: z.output<Contract[NS][M]['input']>, event: IpcMainInvokeEvent) => MethodOutput<Contract[NS][M]> | Promise<MethodOutput<Contract[NS][M]>>
  : never;

export type Handlers = { [NS in Namespace]: { [M in keyof Contract[NS]]: Impl<NS, M> } };

/** Errors that are safe to show to the user carry a code; everything else becomes "internal". */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly messageKey: string,
    readonly details?: Record<string, string | number>,
  ) {
    super(code);
  }
}

function toIpcError(err: unknown): IpcError {
  if (err instanceof AppError) return { code: err.code, messageKey: err.messageKey, details: err.details };
  if (err instanceof ZodError) return { code: 'validation', messageKey: 'errors.validation' };
  const code = (err as { code?: unknown })?.code;
  if (code === 'not_found') return { code: 'not_found', messageKey: 'errors.notFound' };
  if (code === 'validation') return { code: 'validation', messageKey: 'errors.validation' };
  return { code: 'internal', messageKey: 'errors.internal' };
}

/**
 * Registers a handler for every method in the contract. Each call is checked against the
 * trusted origin, its input parsed with zod, and errors are reduced to safe envelopes.
 */
export function registerHandlers(
  handlers: Handlers,
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean,
  isAllowed: (ns: Namespace, method: string) => boolean = () => true,
): void {
  for (const [ns, m] of allMethods()) {
    const def = (contract[ns] as Record<string, { input: z.ZodType }>)[m]!;
    const impl = (handlers[ns] as Record<string, (input: unknown, e: IpcMainInvokeEvent) => unknown>)[m];
    if (!impl) throw new Error(`missing IPC handler for ${ns}.${m}`);
    ipcMain.handle(channel(ns, m), async (event, raw): Promise<IpcResult<unknown>> => {
      if (!isTrustedSender(event)) {
        log.warn({ ns, m }, 'rejected IPC from untrusted sender');
        return { ok: false, error: { code: 'forbidden', messageKey: 'errors.internal' } };
      }
      if (!isAllowed(ns, m)) return { ok: false, error: { code: 'locked', messageKey: 'errors.locked' } };
      try {
        const input = def.input.parse(raw ?? {});
        return { ok: true, value: await impl(input, event) };
      } catch (err) {
        const e = toIpcError(err);
        if (e.code === 'internal') log.error({ ns, m, err: errInfo(err) }, 'IPC handler failed');
        return { ok: false, error: e };
      }
    });
  }
}

/** Typed push event to a renderer. */
export function emit<E extends EventName>(wc: WebContents | null | undefined, event: E, payload: EventPayload<E>): void {
  if (wc && !wc.isDestroyed()) wc.send(EVENT_CHANNEL_PREFIX + event, payload);
}

export type { MethodInput };
