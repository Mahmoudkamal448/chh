import type { Change, KdfParamsWire } from '@chh/shared/sync';

export interface UserRecord {
  id: string;
  email: string;
  authHash: string;
  kdf: KdfParamsWire;
  accountKeyWrapped: string;
  publicKey: string;
  privateKeyWrapped: string;
  recoveryWrapped: string;
  recoveryAuthHash: string;
  totpSecretEnc: string | null;
  totpPendingEnc: string | null;
  totpLastStep: number;
  recoveryCodeHashes: string[];
  createdAt: number;
}

export interface DeviceRecord {
  id: string;
  userId: string;
  name: string;
  platform: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface TokenRecord {
  hash: string;
  userId: string;
  deviceId: string;
  kind: 'access' | 'refresh';
  expiresAt: number;
  revoked: boolean;
}

export interface VaultRecord {
  id: string;
  kind: 'personal' | 'team';
  ownerUserId: string;
  keyWrapped: string;
  seq: number;
}

export type PushOutcome = { status: 'ok'; rev: number; seq: number } | { status: 'conflict'; current: Change };

/** Persistence used by the server. Implemented for Postgres (production) and memory (tests/dev). */
export interface Store {
  migrate(): Promise<void>;
  close(): Promise<void>;

  createUser(u: UserRecord, device: DeviceRecord, vault: VaultRecord): Promise<void>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  getUser(id: string): Promise<UserRecord | null>;
  updateUser(id: string, patch: Partial<Omit<UserRecord, 'id' | 'email' | 'createdAt'>>): Promise<void>;
  deleteUser(id: string): Promise<void>;

  createDevice(d: DeviceRecord): Promise<void>;
  listDevices(userId: string): Promise<DeviceRecord[]>;
  touchDevice(id: string, at: number): Promise<void>;
  deleteDevice(userId: string, id: string): Promise<boolean>;

  saveToken(t: TokenRecord): Promise<void>;
  getToken(hash: string): Promise<TokenRecord | null>;
  revokeToken(hash: string): Promise<void>;
  revokeDeviceTokens(deviceId: string): Promise<void>;
  /** Revokes every token of the user except those of `keepDeviceId`. */
  revokeUserTokens(userId: string, keepDeviceId?: string): Promise<void>;

  listVaults(userId: string): Promise<VaultRecord[]>;
  getVault(id: string): Promise<VaultRecord | null>;

  pull(vaultId: string, since: number, limit: number): Promise<Change[]>;
  /** Atomic per item: succeeds only if the stored revision equals `baseRev` (0 = must not exist). */
  push(vaultId: string, c: { itemId: string; baseRev: number; nonce: string; ciphertext: string; deviceId: string }): Promise<PushOutcome>;
}
