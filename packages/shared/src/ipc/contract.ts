import { z } from 'zod';
import {
  AppSettingsSchema,
  AuthPromptSchema,
  GroupInputSchema,
  GroupPatchSchema,
  GroupSchema,
  HostInputSchema,
  HostKeyDecisionSchema,
  HostKeyPromptSchema,
  HostPatchSchema,
  HostQuerySchema,
  HostSchema,
  IdSchema,
  LocalShellSchema,
  SessionStatusSchema,
} from '../model';

/** Declares one request/response IPC method. */
function method<I extends z.ZodType, O extends z.ZodType>(input: I, output: O) {
  return { input, output };
}

const Void = z.void();
const Empty = z.object({});
const ById = z.object({ id: IdSchema });
const Dims = { cols: z.number().int().min(1).max(2000), rows: z.number().int().min(1).max(1000) };

/**
 * THE typed IPC contract. Preload exposes it as `window.cy.<ns>.<method>()`; main registers
 * a handler for every entry. Inputs are validated with zod in main before reaching handlers.
 */
export const contract = {
  app: {
    info: method(
      Empty,
      z.object({
        version: z.string(),
        platform: z.enum(['darwin', 'win32', 'linux']),
        arch: z.string(),
        testMode: z.boolean(),
        keystore: z.enum(['os', 'weak']),
      }),
    ),
    getSettings: method(Empty, AppSettingsSchema),
    setSettings: method(AppSettingsSchema.partial(), AppSettingsSchema),
    openExternal: method(z.object({ url: z.url({ protocol: /^https?$/ }) }), Void),
  },
  hosts: {
    list: method(HostQuerySchema, z.object({ items: z.array(HostSchema), total: z.number() })),
    get: method(ById, HostSchema),
    create: method(HostInputSchema, HostSchema),
    update: method(z.object({ id: IdSchema, patch: HostPatchSchema }), HostSchema),
    duplicate: method(ById, HostSchema),
    remove: method(z.object({ ids: z.array(IdSchema).min(1).max(50_000) }), Void),
    tags: method(Empty, z.array(z.object({ tag: z.string(), count: z.number() }))),
  },
  groups: {
    list: method(Empty, z.array(GroupSchema)),
    create: method(GroupInputSchema, GroupSchema),
    update: method(z.object({ id: IdSchema, patch: GroupPatchSchema }), GroupSchema),
    /** Removes the group; its hosts and sub-groups move to the group's parent. */
    remove: method(ById, Void),
  },
  sessions: {
    /** The session's MessagePort is delivered separately via the `session.port` channel. */
    openSsh: method(z.object({ hostId: IdSchema, ...Dims }), z.object({ sessionId: IdSchema })),
    openLocal: method(
      z.object({ shellId: z.string().max(64).optional(), ...Dims }),
      z.object({ sessionId: IdSchema, title: z.string() }),
    ),
    close: method(z.object({ sessionId: IdSchema }), Void),
    localShells: method(Empty, z.array(LocalShellSchema)),
    respondHostKey: method(z.object({ promptId: IdSchema, decision: HostKeyDecisionSchema }), Void),
    respondAuth: method(
      z.object({
        promptId: IdSchema,
        /** null = user cancelled. */
        responses: z.array(z.string().max(4096)).max(16).nullable(),
        save: z.boolean().default(false),
      }),
      Void,
    ),
  },
  dev: {
    /** Only available when the app runs with CY_SSH_TEST=1. */
    seedHosts: method(z.object({ count: z.number().int().min(1).max(20_000) }), z.object({ created: z.number() })),
  },
} as const;

/** Main -> renderer push events. */
export const events = {
  'session.status': z.object({ sessionId: IdSchema, status: SessionStatusSchema, message: z.string().optional() }),
  'hostkey.prompt': HostKeyPromptSchema,
  'auth.prompt': AuthPromptSchema,
  /** Prompt was answered/cancelled elsewhere (e.g. session closed) — dismiss the dialog. */
  'prompt.dismiss': z.object({ promptId: IdSchema }),
  'data.changed': z.object({ kinds: z.array(z.enum(['hosts', 'groups', 'settings'])) }),
} as const;

export type Contract = typeof contract;
export type Namespace = keyof Contract;
export type EventName = keyof typeof events;
export type EventPayload<E extends EventName> = z.infer<(typeof events)[E]>;

type MethodDef = { input: z.ZodType; output: z.ZodType };
export type MethodInput<M extends MethodDef> = z.input<M['input']>;
export type MethodOutput<M extends MethodDef> = z.output<M['output']>;

/** Channel name for `ns.method`. */
export const channel = (ns: string, m: string) => `cy:${ns}.${m}`;

/** All [namespace, method] pairs — used by preload to build the API and by main to verify coverage. */
export const allMethods = (): Array<[Namespace, string]> =>
  (Object.keys(contract) as Namespace[]).flatMap((ns) => Object.keys(contract[ns]).map((m) => [ns, m] as [Namespace, string]));

export const SESSION_PORT_CHANNEL = 'cy:session.port';
export const EVENT_CHANNEL_PREFIX = 'cy:event:';

/** Result envelope: errors cross IPC as an i18n key + safe details, never stack traces or secrets. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };
export interface IpcError {
  code: string;
  /** i18n key for the renderer, e.g. "errors.notFound". */
  messageKey: string;
  details?: Record<string, string | number>;
}

export interface TerminalStream {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  ack(bytes: number): void;
  detach(): void;
}

export interface TerminalHandlers {
  onData(data: string | Uint8Array): void;
  onStatus(status: z.infer<typeof SessionStatusSchema>, message?: string): void;
  onExit(code: number | null): void;
}

/** The API exposed on `window.cy`. */
export type CyApi = {
  [NS in Namespace]: {
    [M in keyof Contract[NS]]: Contract[NS][M] extends MethodDef
      ? (input: MethodInput<Contract[NS][M]>) => Promise<MethodOutput<Contract[NS][M]>>
      : never;
  };
} & {
  on<E extends EventName>(event: E, cb: (payload: EventPayload<E>) => void): () => void;
  /** Attach to a session's byte stream. Data is buffered until attach is called. */
  attachTerminal(sessionId: string, handlers: TerminalHandlers): TerminalStream;
  platform: 'darwin' | 'win32' | 'linux';
};

export class CyIpcError extends Error {
  constructor(public readonly error: IpcError) {
    super(error.code);
    this.name = 'CyIpcError';
  }
}
