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
export const PullResponse = z.object({ changes: z.array(ChangeSchema), nextSince: z.number().int(), hasMore: z.boolean() });

export const PushChangeSchema = z.object({
  itemId: id,
  /** Revision the client last saw (0 = new item). */
  baseRev: z.number().int().min(0),
  nonce: b64.max(64),
  ciphertext: b64.max(350_000),
});
export const PushRequest = z.object({ vaultId: id, changes: z.array(PushChangeSchema).min(1).max(500) });
export const PushResultSchema = z.discriminatedUnion('status', [
  z.object({ itemId: id, status: z.literal('ok'), rev: z.number().int(), seq: z.number().int() }),
  z.object({ itemId: id, status: z.literal('conflict'), current: ChangeSchema }),
]);
export type PushResult = z.infer<typeof PushResultSchema>;
export const PushResponse = z.object({ results: z.array(PushResultSchema) });

/** WebSocket messages. */
export type WsClientMessage = { type: 'auth'; token: string } | { type: 'ping' };
export type WsServerMessage = { type: 'ready' } | { type: 'changed'; vaultId: string; seq: number } | { type: 'pong' } | { type: 'error'; error: string };

export const ErrorResponse = z.object({ error: z.string(), message: z.string().optional() });
