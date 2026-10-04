import { z } from 'zod';
import {
  AppSettingsSchema,
  AuthPromptSchema,
  ConflictPolicySchema,
  EndpointSchema,
  FileEntrySchema,
  ForwardInputSchema,
  ForwardPatchSchema,
  ForwardSchema,
  ForwardStatusSchema,
  HistoryEntrySchema,
  SnippetInputSchema,
  SnippetPatchSchema,
  SnippetSchema,
  SshImportPreviewSchema,
  SshImportResultSchema,
  LockSettingsSchema,
  LockStateSchema,
  SyncStatusSchema,
  CloudCandidateSchema,
  RunHostStatusSchema,
  RunOutputSchema,
  GenerateKeyInputSchema,
  IdentityInputSchema,
  IdentityPatchSchema,
  IdentitySchema,
  ImportKeyResultSchema,
  KeySchema,
  KnownHostSchema,
  TransferSchema,
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
  AuditEntryViewSchema,
  InviteRoleSchema,
  MovableKindSchema,
  MyInviteSchema,
  PendingInviteSchema,
  TeamMemberSchema,
  TeamRoleSchema,
  TeamSummarySchema,
  UpdateStatusSchema,
  VaultSummarySchema,
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
 * THE typed IPC contract. Preload exposes it as `window.chh.<ns>.<method>()`; main registers
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
    /** Opens a terminal session to a host using its protocol (SSH, Telnet or Mosh). */
    openHost: method(z.object({ hostId: IdSchema, ...Dims }), z.object({ sessionId: IdSchema })),
    /** Quick connect to user@host:port without saving a host. */
    openQuick: method(
      z.object({ host: z.string().trim().min(1).max(255), port: z.number().int().min(1).max(65535), username: z.string().trim().max(255), ...Dims }),
      z.object({ sessionId: IdSchema }),
    ),
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
  keys: {
    list: method(Empty, z.array(KeySchema)),
    generate: method(GenerateKeyInputSchema, KeySchema),
    /** Import pasted key text (OpenSSH, PEM/PKCS#8, PuTTY .ppk). */
    importText: method(
      z.object({ label: z.string().trim().max(200).optional(), text: z.string().min(1).max(65_536), passphrase: z.string().max(1024).optional() }),
      ImportKeyResultSchema,
    ),
    /** Shows an open-file dialog and stages the chosen file; the text never reaches the renderer. */
    pickFile: method(Empty, z.object({ token: z.string(), fileName: z.string(), encrypted: z.boolean() }).nullable()),
    importStaged: method(
      z.object({ token: z.string(), label: z.string().trim().max(200).optional(), passphrase: z.string().max(1024).optional() }),
      ImportKeyResultSchema,
    ),
    rename: method(z.object({ id: IdSchema, label: z.string().trim().min(1).max(200) }), KeySchema),
    /** Attaches an OpenSSH certificate (the "…-cert.pub" text) to a key, or removes it with null. */
    setCertificate: method(z.object({ id: IdSchema, certificate: z.string().max(16_384).nullable() }), KeySchema),
    remove: method(z.object({ ids: z.array(IdSchema).min(1) }), Void),
    /** Save-file dialog; optionally re-encrypts the exported OpenSSH key with a passphrase. */
    exportPrivate: method(z.object({ id: IdSchema, passphrase: z.string().max(1024).optional() }), z.object({ saved: z.boolean() })),
    /** Names of hosts/identities/groups that reference this key (shown before deleting). */
    usage: method(ById, z.array(z.string())),
  },
  identities: {
    list: method(Empty, z.array(IdentitySchema)),
    create: method(IdentityInputSchema, IdentitySchema),
    update: method(z.object({ id: IdSchema, patch: IdentityPatchSchema }), IdentitySchema),
    remove: method(z.object({ ids: z.array(IdSchema).min(1) }), Void),
  },
  knownHosts: {
    list: method(z.object({ query: z.string().max(200).optional() }), z.array(KnownHostSchema)),
    remove: method(z.object({ ids: z.array(IdSchema).min(1) }), Void),
    /** Import an OpenSSH known_hosts file (open dialog defaults to ~/.ssh/known_hosts). */
    importFile: method(Empty, z.object({ imported: z.number(), skipped: z.number() }).nullable()),
  },
  sftp: {
    /** Connects an SFTP session to a host; resolves when ready (prompts may appear meanwhile). */
    open: method(z.object({ hostId: IdSchema }), z.object({ sessionId: IdSchema })),
    close: method(z.object({ sessionId: IdSchema }), Void),
    home: method(z.object({ endpoint: EndpointSchema }), z.object({ path: z.string(), separator: z.enum(['/', '\\']) })),
    list: method(z.object({ endpoint: EndpointSchema, path: z.string().max(4096) }), z.object({ path: z.string(), parent: z.string().nullable(), entries: z.array(FileEntrySchema) })),
    mkdir: method(z.object({ endpoint: EndpointSchema, path: z.string().max(4096) }), Void),
    rename: method(z.object({ endpoint: EndpointSchema, from: z.string().max(4096), to: z.string().max(4096) }), Void),
    remove: method(z.object({ endpoint: EndpointSchema, paths: z.array(z.string().max(4096)).min(1) }), Void),
    chmod: method(
      z.object({ endpoint: EndpointSchema, paths: z.array(z.string().max(4096)).min(1), mode: z.number().int().min(0).max(0o7777), recursive: z.boolean() }),
      Void,
    ),
    /** Which of `names` already exist in `dir` (for conflict prompts before a transfer). */
    existing: method(z.object({ endpoint: EndpointSchema, dir: z.string().max(4096), names: z.array(z.string()) }), z.array(z.string())),
    transfer: method(
      z.object({
        src: z.object({ endpoint: EndpointSchema, paths: z.array(z.string().max(4096)).min(1) }),
        dst: z.object({ endpoint: EndpointSchema, dir: z.string().max(4096) }),
        conflict: ConflictPolicySchema,
      }),
      z.object({ transferIds: z.array(z.string()) }),
    ),
    cancelTransfer: method(z.object({ id: z.string() }), Void),
  },
  forwards: {
    list: method(Empty, z.array(ForwardSchema)),
    create: method(ForwardInputSchema, ForwardSchema),
    update: method(z.object({ id: IdSchema, patch: ForwardPatchSchema }), ForwardSchema),
    remove: method(z.object({ ids: z.array(IdSchema).min(1) }), Void),
    start: method(ById, Void),
    stop: method(ById, Void),
    statuses: method(Empty, z.array(ForwardStatusSchema)),
  },
  snippets: {
    list: method(Empty, z.array(SnippetSchema)),
    create: method(SnippetInputSchema, SnippetSchema),
    update: method(z.object({ id: IdSchema, patch: SnippetPatchSchema }), SnippetSchema),
    remove: method(z.object({ ids: z.array(IdSchema).min(1) }), Void),
  },
  history: {
    add: method(z.object({ hostId: IdSchema.nullable(), source: z.string().max(200), command: z.string().min(1).max(8192) }), Void),
    search: method(
      z.object({ query: z.string().max(500).optional(), hostId: IdSchema.optional(), limit: z.number().int().min(1).max(5000).default(500) }),
      z.array(HistoryEntrySchema),
    ),
    remove: method(z.object({ ids: z.array(z.number().int()).min(1) }), Void),
    clear: method(Empty, Void),
  },
  sshConfig: {
    /** Reads ~/.ssh/config (or a picked file) and returns importable hosts without importing. */
    preview: method(z.object({ pickFile: z.boolean().default(false) }), SshImportPreviewSchema.nullable()),
    import: method(
      z.object({
        token: z.string(),
        aliases: z.array(z.string()).min(1),
        groupLabel: z.string().trim().max(200).optional(),
        importKeys: z.boolean(),
        importForwards: z.boolean(),
      }),
      SshImportResultSchema,
    ),
    /** ssh_config text for the given hosts (all hosts when omitted). */
    exportText: method(z.object({ hostIds: z.array(IdSchema).optional() }), z.string()),
    /** Save dialog + write. Never overwrites without the OS dialog's confirmation. */
    exportFile: method(z.object({ hostIds: z.array(IdSchema).optional() }), z.object({ saved: z.boolean() })),
  },
  sync: {
    status: method(Empty, SyncStatusSchema),
    register: method(
      z.object({ serverUrl: z.string().max(500), email: z.string().max(254), password: z.string().min(1).max(1024) }),
      z.object({ recoveryKey: z.string() }),
    ),
    login: method(
      z.object({
        serverUrl: z.string().max(500),
        email: z.string().max(254),
        password: z.string().min(1).max(1024),
        totp: z.string().max(6).optional(),
        recoveryCode: z.string().max(64).optional(),
      }),
      z.object({ status: z.enum(['ok', 'totp_required']) }),
    ),
    recover: method(
      z.object({
        serverUrl: z.string().max(500),
        email: z.string().max(254),
        recoveryKey: z.string().max(200),
        newPassword: z.string().min(1).max(1024),
        totp: z.string().max(6).optional(),
        recoveryCode: z.string().max(64).optional(),
      }),
      z.object({ status: z.enum(['ok', 'totp_required']) }),
    ),
    logout: method(z.object({ keepData: z.boolean() }), Void),
    syncNow: method(Empty, Void),
    devices: method(
      Empty,
      z.array(z.object({ id: z.string(), name: z.string(), platform: z.string(), createdAt: z.number(), lastSeenAt: z.number(), current: z.boolean() })),
    ),
    removeDevice: method(z.object({ id: z.string().max(64) }), Void),
    changePassword: method(z.object({ current: z.string().min(1).max(1024), next: z.string().min(1).max(1024) }), Void),
    totpSetup: method(Empty, z.object({ secret: z.string(), uri: z.string() })),
    totpEnable: method(z.object({ code: z.string().regex(/^\d{6}$/) }), z.object({ recoveryCodes: z.array(z.string()) })),
    totpDisable: method(z.object({ code: z.string().max(6).optional(), recoveryCode: z.string().max(64).optional() }), Void),
    deleteAccount: method(z.object({ password: z.string().min(1).max(1024) }), Void),
  },
  /** Shared team vaults (need a sync account). */
  teams: {
    list: method(Empty, z.object({ teams: z.array(TeamSummarySchema), invites: z.array(MyInviteSchema), myFingerprint: z.string().nullable() })),
    create: method(z.object({ name: z.string().trim().min(1).max(100) }), TeamSummarySchema),
    rename: method(z.object({ teamId: IdSchema, name: z.string().trim().min(1).max(100) }), Void),
    members: method(z.object({ teamId: IdSchema }), z.object({ members: z.array(TeamMemberSchema), invites: z.array(PendingInviteSchema) })),
    invite: method(z.object({ teamId: IdSchema, email: z.string().trim().email().max(254), role: InviteRoleSchema }), Void),
    cancelInvite: method(z.object({ teamId: IdSchema, inviteId: IdSchema }), Void),
    acceptInvite: method(z.object({ inviteId: IdSchema }), Void),
    declineInvite: method(z.object({ inviteId: IdSchema }), Void),
    /** Shares the team key with an accepted member; `fingerprint` is what the admin compared. */
    confirm: method(z.object({ teamId: IdSchema, userId: IdSchema, fingerprint: z.string().max(64) }), Void),
    setRole: method(z.object({ teamId: IdSchema, userId: IdSchema, role: TeamRoleSchema }), Void),
    /** Removes a member; confirmed members trigger a key rotation. */
    remove: method(z.object({ teamId: IdSchema, userId: IdSchema }), Void),
    rotateKey: method(z.object({ teamId: IdSchema }), Void),
    leave: method(z.object({ teamId: IdSchema }), Void),
    delete: method(z.object({ teamId: IdSchema }), Void),
    audit: method(z.object({ teamId: IdSchema, before: z.number().int().optional() }), z.object({ entries: z.array(AuditEntryViewSchema), hasMore: z.boolean() })),
    vaults: method(Empty, z.array(VaultSummarySchema)),
    /** Moves items between the personal vault and team vaults. */
    move: method(z.object({ kind: MovableKindSchema, ids: z.array(IdSchema).min(1).max(5000), vaultId: IdSchema }), z.object({ moved: z.number() })),
  },
  updates: {
    status: method(Empty, UpdateStatusSchema),
    check: method(Empty, UpdateStatusSchema),
    download: method(Empty, Void),
    /** Quits and installs a downloaded update. */
    install: method(Empty, Void),
  },
  serial: {
    ports: method(
      Empty,
      z.array(z.object({ path: z.string(), manufacturer: z.string().nullable(), serialNumber: z.string().nullable(), vendorId: z.string().nullable(), productId: z.string().nullable() })),
    ),
  },
  run: {
    /** Runs a script on several hosts in parallel (non-interactive), streaming per-host output. */
    start: method(
      z.object({ hostIds: z.array(IdSchema).min(1).max(500), script: z.string().min(1).max(65_536), title: z.string().max(200) }),
      z.object({ runId: z.string(), hosts: z.array(z.object({ hostId: IdSchema, label: z.string(), skipped: z.string().optional() })) }),
    ),
    cancel: method(z.object({ runId: z.string() }), Void),
  },
  suggest: {
    /** Distinct past commands starting with `prefix`, most relevant first. */
    history: method(z.object({ prefix: z.string().max(2000), hostId: IdSchema.nullable(), limit: z.number().int().min(1).max(50).default(8) }), z.array(z.string())),
    /** Asks the configured AI provider (only when enabled; never automatic). */
    ai: method(
      z.object({ line: z.string().max(2000), hostId: IdSchema.nullable(), recent: z.array(z.string().max(2000)).max(20).default([]) }),
      z.object({ suggestions: z.array(z.string()) }),
    ),
    aiKeyStatus: method(Empty, z.object({ configured: z.boolean() })),
    setAiKey: method(z.object({ key: z.string().max(500).nullable() }), Void),
  },
  cloud: {
    awsProfiles: method(Empty, z.array(z.string())),
    awsList: method(
      z.object({
        regions: z.array(z.string().max(40)).min(1).max(40),
        profile: z.string().max(200).optional(),
        accessKeyId: z.string().max(200).optional(),
        secretAccessKey: z.string().max(200).optional(),
        sessionToken: z.string().max(4096).optional(),
      }),
      z.object({ token: z.string(), candidates: z.array(CloudCandidateSchema) }),
    ),
    doList: method(z.object({ apiToken: z.string().min(1).max(200) }), z.object({ token: z.string(), candidates: z.array(CloudCandidateSchema) })),
    import: method(
      z.object({
        token: z.string(),
        externalIds: z.array(z.string()).min(1),
        groupLabel: z.string().trim().max(200).optional(),
        username: z.string().max(255).optional(),
        address: z.enum(['public', 'private', 'dns']),
      }),
      z.object({ created: z.number(), updated: z.number() }),
    ),
  },
  lock: {
    state: method(Empty, LockStateSchema),
    lockNow: method(Empty, Void),
    unlock: method(z.object({ secret: z.string().max(1024).optional(), biometric: z.boolean().optional() }), z.object({ ok: z.boolean() })),
    /** Enables the UI lock with a passcode (or updates the passcode). */
    configure: method(z.object({ passcode: z.string().min(4).max(1024).optional(), settings: LockSettingsSchema.partial() }), LockStateSchema),
    disable: method(z.object({ secret: z.string().max(1024) }), LockStateSchema),
    /** Protects the local database key with a master password (asked at every start). */
    setMasterPassword: method(z.object({ password: z.string().min(8).max(1024) }), LockStateSchema),
    removeMasterPassword: method(z.object({ password: z.string().max(1024) }), LockStateSchema),
  },
  dev: {
    /** Only available when the app runs with CHH_TEST=1. */
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
  'data.changed': z.object({ kinds: z.array(z.enum(['hosts', 'groups', 'settings', 'keys', 'identities', 'knownHosts', 'forwards', 'snippets', 'history'])) }),
  'transfer.update': TransferSchema,
  'forward.update': ForwardStatusSchema,
  'sync.state': SyncStatusSchema,
  /** Team list, roles or invites changed. */
  'teams.changed': z.object({}),
  'update.status': UpdateStatusSchema,
  'lock.changed': LockStateSchema,
  'run.status': RunHostStatusSchema,
  'run.output': RunOutputSchema,
} as const;

export type Contract = typeof contract;
export type Namespace = keyof Contract;
export type EventName = keyof typeof events;
export type EventPayload<E extends EventName> = z.infer<(typeof events)[E]>;

type MethodDef = { input: z.ZodType; output: z.ZodType };
export type MethodInput<M extends MethodDef> = z.input<M['input']>;
export type MethodOutput<M extends MethodDef> = z.output<M['output']>;

/** Channel name for `ns.method`. */
export const channel = (ns: string, m: string) => `chh:${ns}.${m}`;

/** All [namespace, method] pairs — used by preload to build the API and by main to verify coverage. */
export const allMethods = (): Array<[Namespace, string]> =>
  (Object.keys(contract) as Namespace[]).flatMap((ns) => Object.keys(contract[ns]).map((m) => [ns, m] as [Namespace, string]));

export const SESSION_PORT_CHANNEL = 'chh:session.port';
export const EVENT_CHANNEL_PREFIX = 'chh:event:';

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

/** The API exposed on `window.chh`. */
export type ChhApi = {
  [NS in Namespace]: {
    [M in keyof Contract[NS]]: Contract[NS][M] extends MethodDef
      ? (input: MethodInput<Contract[NS][M]>) => Promise<MethodOutput<Contract[NS][M]>>
      : never;
  };
} & {
  on<E extends EventName>(event: E, cb: (payload: EventPayload<E>) => void): () => void;
  /** Attach to a session's byte stream. Data is buffered until attach is called. */
  attachTerminal(sessionId: string, handlers: TerminalHandlers): TerminalStream;
  /** Absolute path of a File dropped from the OS (Electron webUtils). */
  pathForFile(file: object): string;
  platform: 'darwin' | 'win32' | 'linux';
};

/**
 * contextBridge only preserves an Error's `message`, so the structured envelope travels inside it,
 * prefixed so the renderer can tell it apart from other errors.
 */
export const IPC_ERROR_PREFIX = 'cy-ipc-error:';

export function encodeIpcError(e: IpcError): string {
  return IPC_ERROR_PREFIX + JSON.stringify(e);
}

export function decodeIpcError(err: unknown): IpcError | null {
  const msg = (err as Error | null)?.message;
  if (typeof msg !== 'string') return null;
  const i = msg.indexOf(IPC_ERROR_PREFIX);
  if (i < 0) return null;
  try {
    return JSON.parse(msg.slice(i + IPC_ERROR_PREFIX.length)) as IpcError;
  } catch {
    return null;
  }
}

export class ChhIpcError extends Error {
  constructor(public readonly error: IpcError) {
    super(error.code);
    this.name = 'ChhIpcError';
  }
}
