/** REST/WebSocket protocol between the desktop app and the sync server (both validate with these). */
import { z } from 'zod';

const b64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(400_000);
const email = z.string().trim().toLowerCase().email().max(254);
const id = z.string().min(1).max(64);

export const KdfParamsSchema = z.object({
  alg: z.literal('argon2id13'),
  salt: b64.max(64),
  ops: z.number().int().min(1).max(32),
  mem: z.number().int().min(8 * 1024 * 1024).max(4 * 1024 * 1024 * 1024),
});
export type KdfParamsWire = z.infer<typeof KdfParamsSchema>;

export const DeviceInfoSchema = z.object({ name: z.string().trim().min(1).max(100), platform: z.string().max(32) });

export const AccountBlobsSchema = z.object({
  accountKeyWrapped: b64,
  publicKey: b64,
  privateKeyWrapped: b64,
  recoveryWrapped: b64,
});

export const VaultWireSchema = z.object({ id, kind: z.enum(['personal', 'team']), keyWrapped: b64 });
export type VaultWire = z.infer<typeof VaultWireSchema>;

export const PreloginRequest = z.object({ email });
export const PreloginResponse = z.object({ kdf: KdfParamsSchema });

export const RegisterRequest = z.object({
  email,
  authKey: b64,
  /** Derived from the recovery key; lets the holder reset a forgotten password. */
  recoveryAuthKey: b64,
  kdf: KdfParamsSchema,
  blobs: AccountBlobsSchema,
  vault: z.object({ id, keyWrapped: b64 }),
  device: DeviceInfoSchema,
});

export const LoginRequest = z.object({
  email,
  authKey: b64,
  totp: z.string().regex(/^\d{6}$/).optional(),
  recoveryCode: z.string().max(64).optional(),
  device: DeviceInfoSchema,
});

export const TokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  /** seconds */
  expiresIn: z.number(),
  userId: id,
  deviceId: id,
});
export type Tokens = z.infer<typeof TokensSchema>;

export const AccountSchema = z.object({
  userId: id,
  email: z.string(),
  kdf: KdfParamsSchema,
  blobs: AccountBlobsSchema,
  totpEnabled: z.boolean(),
  vaults: z.array(VaultWireSchema),
});
export type AccountWire = z.infer<typeof AccountSchema>;

export const LoginResponse = z.object({ tokens: TokensSchema, account: AccountSchema });

export const RefreshRequest = z.object({ refreshToken: z.string().max(200) });

export const DeviceSchema = z.object({
  id,
  name: z.string(),
  platform: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number(),
  current: z.boolean(),
});
export type DeviceWire = z.infer<typeof DeviceSchema>;

export const ChangePasswordRequest = z.object({
  currentAuthKey: b64,
  newAuthKey: b64,
  newKdf: KdfParamsSchema,
  accountKeyWrapped: b64,
});

export const TotpSetupResponse = z.object({ secret: z.string(), uri: z.string() });
export const TotpCodeRequest = z.object({ code: z.string().regex(/^\d{6}$/).optional(), recoveryCode: z.string().max(64).optional() });
export const TotpEnableResponse = z.object({ recoveryCodes: z.array(z.string()) });

/** Forgotten password, step 1: prove possession of the recovery key, get the recovery-wrapped account key. */
export const RecoverStartRequest = z.object({
  email,
  recoveryAuthKey: b64,
  totp: z.string().regex(/^\d{6}$/).optional(),
  recoveryCode: z.string().max(64).optional(),
});
export const RecoverStartResponse = z.object({ recoveryToken: z.string(), recoveryWrapped: b64, kdf: KdfParamsSchema });
/** Step 2: set the new password (new auth key + account key rewrapped under the new KEK). */
export const RecoverFinishRequest = z.object({
  recoveryToken: z.string().max(200),
  newAuthKey: b64,
  newKdf: KdfParamsSchema,
  accountKeyWrapped: b64,
  device: DeviceInfoSchema,
});

export const DeleteAccountRequest = z.object({ authKey: b64 });

export const EncryptedItemSchema = z.object({ nonce: b64.max(64), ciphertext: b64 });

export const ChangeSchema = z.object({
  itemId: id,
  rev: z.number().int(),
  seq: z.number().int(),
  nonce: b64,
  ciphertext: b64,
});
export type Change = z.infer<typeof ChangeSchema>;

export const PullRequest = z.object({ vaultId: id, since: z.number().int().min(0), limit: z.number().int().min(1).max(1000).default(500) });
export const PullResponse = z.object({
  changes: z.array(ChangeSchema),
  nextSince: z.number().int(),
  hasMore: z.boolean(),
  /** Team vaults: the current key generation (changes when an admin rotates the key). */
  keyGen: z.number().int().optional(),
});

export const PushChangeSchema = z.object({
  itemId: id,
  /** Revision the client last saw (0 = new item). */
  baseRev: z.number().int().min(0),
  nonce: b64.max(64),
  ciphertext: b64.max(350_000),
});
export const PushRequest = z.object({
  vaultId: id,
  changes: z.array(PushChangeSchema).min(1).max(500),
  /** Team vaults: the key generation the items were encrypted with (rejected when stale). */
  keyGen: z.number().int().min(1).optional(),
});
export const PushResultSchema = z.discriminatedUnion('status', [
  z.object({ itemId: id, status: z.literal('ok'), rev: z.number().int(), seq: z.number().int() }),
  z.object({ itemId: id, status: z.literal('conflict'), current: ChangeSchema }),
]);
export type PushResult = z.infer<typeof PushResultSchema>;
export const PushResponse = z.object({ results: z.array(PushResultSchema) });

// --- Teams (shared vaults) --------------------------------------------------------------------

export const TeamRoleSchema = z.enum(['owner', 'admin', 'editor', 'viewer']);
export type TeamRole = z.infer<typeof TeamRoleSchema>;
/** Roles an admin can hand out (ownership is transferred, not granted). */
export const InviteRoleSchema = z.enum(['admin', 'editor', 'viewer']);
export const MemberStatusSchema = z.enum(['accepted', 'confirmed']);

/** `nonce || ciphertext`, base64; the team name encrypted with the team vault key. */
const sealedName = b64.max(2000);
/** The team vault key sealed (crypto_box_seal) to one member's X25519 public key. */
const sealedKey = b64.max(200);

export const CreateTeamRequest = z.object({ teamId: id, vaultId: id, nameEnc: sealedName, keyWrapped: sealedKey });

export const TeamWireSchema = z.object({
  id,
  vaultId: id,
  nameEnc: sealedName,
  role: TeamRoleSchema,
  status: MemberStatusSchema,
  keyGen: z.number().int(),
  /** Null until an admin confirms this member for the current key generation. */
  keyWrapped: sealedKey.nullable(),
  memberCount: z.number().int(),
  /** A member left or was removed without a key rotation. */
  needsRotation: z.boolean(),
});
export type TeamWire = z.infer<typeof TeamWireSchema>;

export const MemberWireSchema = z.object({
  userId: id,
  email: z.string(),
  role: TeamRoleSchema,
  status: MemberStatusSchema,
  publicKey: b64,
  joinedAt: z.number(),
});
export type MemberWire = z.infer<typeof MemberWireSchema>;

export const InviteWireSchema = z.object({
  id,
  teamId: id,
  email: z.string(),
  role: InviteRoleSchema,
  invitedBy: z.string(),
  createdAt: z.number(),
});
export type InviteWire = z.infer<typeof InviteWireSchema>;

export const RenameTeamRequest = z.object({ nameEnc: sealedName });
export const InviteRequest = z.object({ email, role: InviteRoleSchema });
export const ConfirmMemberRequest = z.object({ keyWrapped: sealedKey, keyGen: z.number().int().min(1) });
export const SetRoleRequest = z.object({ role: TeamRoleSchema });

/**
 * Key rotation: a new team key, every item re-encrypted with it and the key re-sealed for each
 * remaining confirmed member, applied atomically. `remove` drops members at the same time.
 */
export const RotateRequest = z.object({
  /** Vault sequence the client re-encrypted from; the server rejects the rotation if it moved. */
  baseSeq: z.number().int().min(0),
  keyGen: z.number().int().min(2),
  nameEnc: sealedName,
  members: z.array(z.object({ userId: id, keyWrapped: sealedKey })).max(10_000),
  items: z.array(z.object({ itemId: id, nonce: b64.max(64), ciphertext: b64.max(350_000) })).max(100_000),
  remove: z.array(id).max(1000).default([]),
});

export const AUDIT_CLIENT_ACTIONS = ['host.connected', 'secret.exported', 'secret.copied'] as const;
export const ReportEventsRequest = z.object({
  events: z
    .array(z.object({ action: z.enum(AUDIT_CLIENT_ACTIONS), itemId: id.nullable(), at: z.number().int() }))
    .min(1)
    .max(200),
});

export const AuditEntrySchema = z.object({
  id: z.number().int(),
  at: z.number(),
  actorUserId: id,
  actorEmail: z.string(),
  deviceName: z.string().nullable(),
  action: z.string(),
  itemId: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()),
  /** Reported by a member's app rather than observed by the server (a modified client could skip it). */
  clientReported: z.boolean(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export const AuditQuery = z.object({ before: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) });
export const AuditResponse = z.object({ entries: z.array(AuditEntrySchema), hasMore: z.boolean() });

/** WebSocket messages. */
export type WsClientMessage = { type: 'auth'; token: string } | { type: 'ping' };
export type WsServerMessage =
  | { type: 'ready' }
  | { type: 'changed'; vaultId: string; seq: number }
  /** Team membership, roles or keys changed: refresh the team list. */
  | { type: 'teams' }
  | { type: 'pong' }
  | { type: 'error'; error: string };

export const ErrorResponse = z.object({ error: z.string(), message: z.string().optional() });
