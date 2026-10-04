import type { Change, KdfParamsWire, TeamRole } from '@chh/shared/sync';

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
  /** Personal vaults only. */
  ownerUserId: string | null;
  /** Team vaults only. */
  teamId: string | null;
  /** Personal vaults: the key wrapped by the account key. Team vaults: unused (per member). */
  keyWrapped: string;
  seq: number;
  /** Team vaults: incremented by every key rotation. */
  keyGen: number;
  /** Team vaults: someone left or was removed without a rotation. */
  needsRotation: boolean;
}

export interface TeamRecord {
  id: string;
  vaultId: string;
  nameEnc: string;
  createdBy: string;
  createdAt: number;
}

export interface MemberRecord {
  teamId: string;
  userId: string;
  role: TeamRole;
  status: 'accepted' | 'confirmed';
  /** The team key sealed to this member; null until confirmed. */
  keyWrapped: string | null;
  /** Key generation `keyWrapped` belongs to. */
  keyGen: number;
  joinedAt: number;
}

/** A member plus the account fields other members need (email, public key). */
export interface MemberView extends MemberRecord {
  email: string;
  publicKey: string;
}

export interface InviteRecord {
  id: string;
  teamId: string;
  email: string;
  role: Exclude<TeamRole, 'owner'>;
  invitedBy: string;
  createdAt: number;
}

export interface AuditRecord {
  id: number;
  teamId: string;
  actorUserId: string;
  actorEmail: string;
  deviceId: string | null;
  deviceName: string | null;
  action: string;
  itemId: string | null;
  at: number;
  meta: Record<string, unknown>;
  clientReported: boolean;
}

export interface RotateInput {
  baseSeq: number;
  keyGen: number;
  nameEnc: string;
  members: Array<{ userId: string; keyWrapped: string }>;
  items: Array<{ itemId: string; nonce: string; ciphertext: string }>;
  remove: string[];
  deviceId: string;
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

  /** Ids of every item in a vault (rotation checks that all of them are re-encrypted). */
  itemIds(vaultId: string): Promise<string[]>;
  pull(vaultId: string, since: number, limit: number): Promise<Change[]>;
  /** Atomic per item: succeeds only if the stored revision equals `baseRev` (0 = must not exist). */
  push(vaultId: string, c: { itemId: string; baseRev: number; nonce: string; ciphertext: string; deviceId: string }): Promise<PushOutcome>;

  // --- teams -----------------------------------------------------------------------------------

  /** Creates the team, its vault and the owner's (confirmed) membership. */
  createTeam(team: TeamRecord, vault: VaultRecord, owner: MemberRecord): Promise<void>;
  getTeam(id: string): Promise<TeamRecord | null>;
  updateTeam(id: string, patch: { nameEnc: string }): Promise<void>;
  /** Deletes the team with its vault, items, members and invites (the audit log stays). */
  deleteTeam(id: string): Promise<void>;
  /** Teams the user belongs to (accepted or confirmed). */
  listTeams(userId: string): Promise<Array<{ team: TeamRecord; member: MemberRecord; vault: VaultRecord; memberCount: number }>>;
  /** Teams the user owns (account deletion is blocked while there are any). */
  ownedTeamCount(userId: string): Promise<number>;

  listMembers(teamId: string): Promise<MemberView[]>;
  getMember(teamId: string, userId: string): Promise<MemberRecord | null>;
  addMember(m: MemberRecord): Promise<void>;
  updateMember(teamId: string, userId: string, patch: Partial<Pick<MemberRecord, 'role' | 'status' | 'keyWrapped' | 'keyGen'>>): Promise<void>;
  removeMember(teamId: string, userId: string): Promise<void>;
  setNeedsRotation(vaultId: string, value: boolean): Promise<void>;

  createInvite(i: InviteRecord): Promise<void>;
  getInvite(id: string): Promise<InviteRecord | null>;
  listInvitesForEmail(email: string): Promise<InviteRecord[]>;
  listInvitesForTeam(teamId: string): Promise<InviteRecord[]>;
  deleteInvite(id: string): Promise<void>;

  /**
   * Atomically replaces every item of a team vault (new key generation), re-seals the key for the
   * remaining members and drops removed ones. Fails with 'stale' if the vault changed since baseSeq.
   */
  rotateTeamVault(teamId: string, vaultId: string, r: RotateInput): Promise<{ status: 'ok'; seq: number } | { status: 'stale' }>;

  /** Append-only. */
  appendAudit(entries: Array<Omit<AuditRecord, 'id'>>): Promise<void>;
  /** Newest first, ids below `before`. */
  listAudit(teamId: string, before: number | undefined, limit: number): Promise<AuditRecord[]>;
}
