import postgres from 'postgres';
import type { Change } from '@chh/shared/sync';
import type {
  AuditRecord,
  DeviceRecord,
  InviteRecord,
  MemberRecord,
  MemberView,
  PushOutcome,
  RotateInput,
  Store,
  TeamRecord,
  TokenRecord,
  UserRecord,
  VaultRecord,
} from './types';

/** Ordered migrations; applied once each, inside a transaction. Never edit a shipped one. */
const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE users (
        id                   text PRIMARY KEY,
        email                text NOT NULL UNIQUE,
        auth_hash            text NOT NULL,
        kdf                  jsonb NOT NULL,
        account_key_wrapped  text NOT NULL,
        public_key           text NOT NULL,
        private_key_wrapped  text NOT NULL,
        recovery_wrapped     text NOT NULL,
        totp_secret_enc      text,
        totp_pending_enc     text,
        totp_last_step       bigint NOT NULL DEFAULT 0,
        recovery_code_hashes text[] NOT NULL DEFAULT '{}',
        created_at           bigint NOT NULL
      );
      CREATE TABLE devices (
        id           text PRIMARY KEY,
        user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name         text NOT NULL,
        platform     text NOT NULL,
        created_at   bigint NOT NULL,
        last_seen_at bigint NOT NULL
      );
      CREATE INDEX devices_user ON devices(user_id);
      CREATE TABLE tokens (
        hash       text PRIMARY KEY,
        user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id  text NOT NULL,
        kind       text NOT NULL CHECK (kind IN ('access', 'refresh')),
        expires_at bigint NOT NULL,
        revoked    boolean NOT NULL DEFAULT false
      );
      CREATE INDEX tokens_device ON tokens(device_id);
      CREATE INDEX tokens_user ON tokens(user_id);
      CREATE TABLE vaults (
        id            text PRIMARY KEY,
        kind          text NOT NULL CHECK (kind IN ('personal', 'team')),
        owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_wrapped   text NOT NULL,
        seq           bigint NOT NULL DEFAULT 0
      );
      CREATE INDEX vaults_owner ON vaults(owner_user_id);
      CREATE TABLE items (
        vault_id   text NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        item_id    text NOT NULL,
        rev        bigint NOT NULL,
        seq        bigint NOT NULL,
        nonce      text NOT NULL,
        ciphertext text NOT NULL,
        updated_by text NOT NULL,
        updated_at bigint NOT NULL,
        PRIMARY KEY (vault_id, item_id)
      );
      CREATE INDEX items_vault_seq ON items(vault_id, seq);
    `,
  },
  {
    version: 2,
    sql: `ALTER TABLE users ADD COLUMN recovery_auth_hash text NOT NULL DEFAULT '';`,
  },
  {
    version: 3,
    sql: `
      -- Teams: a shared vault whose key is sealed to each member's public key.
      CREATE TABLE teams (
        id         text PRIMARY KEY,
        vault_id   text NOT NULL UNIQUE,
        name_enc   text NOT NULL,
        created_by text NOT NULL,
        created_at bigint NOT NULL
      );
      ALTER TABLE vaults ALTER COLUMN owner_user_id DROP NOT NULL;
      ALTER TABLE vaults ADD COLUMN team_id text REFERENCES teams(id) ON DELETE CASCADE;
      ALTER TABLE vaults ADD COLUMN key_gen int NOT NULL DEFAULT 1;
      ALTER TABLE vaults ADD COLUMN needs_rotation boolean NOT NULL DEFAULT false;
      ALTER TABLE vaults ADD CONSTRAINT vaults_one_owner CHECK ((owner_user_id IS NULL) <> (team_id IS NULL));
      CREATE INDEX vaults_team ON vaults(team_id);

      CREATE TABLE team_members (
        team_id     text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role        text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
        status      text NOT NULL CHECK (status IN ('accepted', 'confirmed')),
        key_wrapped text,
        key_gen     int NOT NULL DEFAULT 0,
        joined_at   bigint NOT NULL,
        PRIMARY KEY (team_id, user_id)
      );
      CREATE INDEX team_members_user ON team_members(user_id);

      CREATE TABLE team_invites (
        id         text PRIMARY KEY,
        team_id    text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        email      text NOT NULL,
        role       text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
        invited_by text NOT NULL,
        created_at bigint NOT NULL,
        UNIQUE (team_id, email)
      );
      CREATE INDEX team_invites_email ON team_invites(email);

      -- Append-only: no foreign keys (entries outlive teams and users) and a trigger that rejects
      -- UPDATE and DELETE. Restrict the server's database role further if you want (see SELF_HOSTING.md).
      CREATE TABLE audit_log (
        id              bigserial PRIMARY KEY,
        team_id         text NOT NULL,
        actor_user_id   text NOT NULL,
        actor_email     text NOT NULL,
        device_id       text,
        device_name     text,
        action          text NOT NULL,
        item_id         text,
        at              bigint NOT NULL,
        meta            jsonb NOT NULL DEFAULT '{}',
        client_reported boolean NOT NULL DEFAULT false
      );
      CREATE INDEX audit_log_team ON audit_log(team_id, id DESC);
      CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'audit_log is append-only'; END
      $$;
      CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
        FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
    `,
  },
];

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v);

function toUser(r: Row): UserRecord {
  return {
    id: r.id as string,
    email: r.email as string,
    authHash: r.auth_hash as string,
    kdf: r.kdf as UserRecord['kdf'],
    accountKeyWrapped: r.account_key_wrapped as string,
    publicKey: r.public_key as string,
    privateKeyWrapped: r.private_key_wrapped as string,
    recoveryWrapped: r.recovery_wrapped as string,
    recoveryAuthHash: (r.recovery_auth_hash as string) ?? '',
    totpSecretEnc: (r.totp_secret_enc as string) ?? null,
    totpPendingEnc: (r.totp_pending_enc as string) ?? null,
    totpLastStep: n(r.totp_last_step),
    recoveryCodeHashes: (r.recovery_code_hashes as string[]) ?? [],
    createdAt: n(r.created_at),
  };
}
const toDevice = (r: Row): DeviceRecord => ({
  id: r.id as string,
  userId: r.user_id as string,
  name: r.name as string,
  platform: r.platform as string,
  createdAt: n(r.created_at),
  lastSeenAt: n(r.last_seen_at),
});
const toVault = (r: Row): VaultRecord => ({
  id: r.id as string,
  kind: r.kind as VaultRecord['kind'],
  ownerUserId: (r.owner_user_id as string) ?? null,
  teamId: (r.team_id as string) ?? null,
  keyWrapped: r.key_wrapped as string,
  seq: n(r.seq),
  keyGen: n(r.key_gen ?? 1),
  needsRotation: !!r.needs_rotation,
});
const toTeam = (r: Row): TeamRecord => ({ id: r.id as string, vaultId: r.vault_id as string, nameEnc: r.name_enc as string, createdBy: r.created_by as string, createdAt: n(r.created_at) });
const toMember = (r: Row): MemberRecord => ({
  teamId: r.team_id as string,
  userId: r.user_id as string,
  role: r.role as MemberRecord['role'],
  status: r.status as MemberRecord['status'],
  keyWrapped: (r.key_wrapped as string) ?? null,
  keyGen: n(r.key_gen),
  joinedAt: n(r.joined_at),
});
const toInvite = (r: Row): InviteRecord => ({
  id: r.id as string,
  teamId: r.team_id as string,
  email: r.email as string,
  role: r.role as InviteRecord['role'],
  invitedBy: r.invited_by as string,
  createdAt: n(r.created_at),
});
const toAudit = (r: Row): AuditRecord => ({
  id: n(r.id),
  teamId: r.team_id as string,
  actorUserId: r.actor_user_id as string,
  actorEmail: r.actor_email as string,
  deviceId: (r.device_id as string) ?? null,
  deviceName: (r.device_name as string) ?? null,
  action: r.action as string,
  itemId: (r.item_id as string) ?? null,
  at: n(r.at),
  meta: (r.meta as Record<string, unknown>) ?? {},
  clientReported: !!r.client_reported,
});
const MEMBER_COLUMNS: Record<string, string> = { role: 'role', status: 'status', keyWrapped: 'key_wrapped', keyGen: 'key_gen' };
const toChange = (r: Row): Change => ({ itemId: r.item_id as string, rev: n(r.rev), seq: n(r.seq), nonce: r.nonce as string, ciphertext: r.ciphertext as string });

const USER_COLUMNS: Record<string, string> = {
  authHash: 'auth_hash',
  kdf: 'kdf',
  accountKeyWrapped: 'account_key_wrapped',
  publicKey: 'public_key',
  privateKeyWrapped: 'private_key_wrapped',
  recoveryWrapped: 'recovery_wrapped',
  recoveryAuthHash: 'recovery_auth_hash',
  totpSecretEnc: 'totp_secret_enc',
  totpPendingEnc: 'totp_pending_enc',
  totpLastStep: 'totp_last_step',
  recoveryCodeHashes: 'recovery_code_hashes',
};

export class PostgresStore implements Store {
  private readonly sql: postgres.Sql;

  constructor(url: string) {
    this.sql = postgres(url, { max: 10, onnotice: () => undefined, idle_timeout: 30 });
  }

  async migrate() {
    const sql = this.sql;
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY)`;
    // Serialize concurrent server starts.
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(482301)`;
      const done = new Set((await tx`SELECT version FROM schema_migrations`).map((r) => r.version as number));
      for (const m of MIGRATIONS) {
        if (done.has(m.version)) continue;
        await tx.unsafe(m.sql);
        await tx`INSERT INTO schema_migrations (version) VALUES (${m.version})`;
      }
    });
  }

  async close() {
    await this.sql.end({ timeout: 5 });
  }

  async createUser(u: UserRecord, d: DeviceRecord, v: VaultRecord) {
    try {
      await this.sql.begin(async (tx) => {
        await tx`INSERT INTO users (id, email, auth_hash, kdf, account_key_wrapped, public_key, private_key_wrapped, recovery_wrapped, recovery_auth_hash, created_at)
                 VALUES (${u.id}, ${u.email}, ${u.authHash}, ${tx.json(u.kdf)}, ${u.accountKeyWrapped}, ${u.publicKey}, ${u.privateKeyWrapped}, ${u.recoveryWrapped}, ${u.recoveryAuthHash}, ${u.createdAt})`;
        await tx`INSERT INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (${d.id}, ${d.userId}, ${d.name}, ${d.platform}, ${d.createdAt}, ${d.lastSeenAt})`;
        await tx`INSERT INTO vaults (id, kind, owner_user_id, key_wrapped, seq) VALUES (${v.id}, 'personal', ${v.ownerUserId}, ${v.keyWrapped}, 0)`;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw Object.assign(new Error('exists'), { code: 'EXISTS' });
      throw e;
    }
  }
  async getUserByEmail(email: string) {
    const [r] = await this.sql`SELECT * FROM users WHERE email = ${email}`;
    return r ? toUser(r) : null;
  }
  async getUser(id: string) {
    const [r] = await this.sql`SELECT * FROM users WHERE id = ${id}`;
    return r ? toUser(r) : null;
  }
  async updateUser(id: string, patch: Partial<UserRecord>) {
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      const col = USER_COLUMNS[k];
      if (col) set[col] = k === 'kdf' ? this.sql.json(v as never) : v;
    }
    if (Object.keys(set).length) await this.sql`UPDATE users SET ${this.sql(set)} WHERE id = ${id}`;
  }
  async deleteUser(id: string) {
    await this.sql`DELETE FROM users WHERE id = ${id}`;
  }

  async createDevice(d: DeviceRecord) {
    await this.sql`INSERT INTO devices (id, user_id, name, platform, created_at, last_seen_at) VALUES (${d.id}, ${d.userId}, ${d.name}, ${d.platform}, ${d.createdAt}, ${d.lastSeenAt})`;
  }
  async listDevices(userId: string) {
    return (await this.sql`SELECT * FROM devices WHERE user_id = ${userId} ORDER BY created_at`).map(toDevice);
  }
  async touchDevice(id: string, at: number) {
    await this.sql`UPDATE devices SET last_seen_at = ${at} WHERE id = ${id}`;
  }
  async deleteDevice(userId: string, id: string) {
    const r = await this.sql`DELETE FROM devices WHERE id = ${id} AND user_id = ${userId}`;
    await this.revokeDeviceTokens(id);
    return r.count > 0;
  }

  async saveToken(t: TokenRecord) {
    await this.sql`INSERT INTO tokens (hash, user_id, device_id, kind, expires_at, revoked) VALUES (${t.hash}, ${t.userId}, ${t.deviceId}, ${t.kind}, ${t.expiresAt}, ${t.revoked})`;
  }
  async getToken(hash: string) {
    const [r] = await this.sql`SELECT * FROM tokens WHERE hash = ${hash}`;
    return r ? { hash: r.hash, userId: r.user_id, deviceId: r.device_id, kind: r.kind, expiresAt: n(r.expires_at), revoked: r.revoked } : null;
  }
  async revokeToken(hash: string) {
    await this.sql`UPDATE tokens SET revoked = true WHERE hash = ${hash}`;
  }
  async revokeDeviceTokens(deviceId: string) {
    await this.sql`UPDATE tokens SET revoked = true WHERE device_id = ${deviceId}`;
  }
  async revokeUserTokens(userId: string, keepDeviceId?: string) {
    if (keepDeviceId) await this.sql`UPDATE tokens SET revoked = true WHERE user_id = ${userId} AND device_id <> ${keepDeviceId}`;
    else await this.sql`UPDATE tokens SET revoked = true WHERE user_id = ${userId}`;
  }

  async listVaults(userId: string) {
    return (await this.sql`SELECT * FROM vaults WHERE owner_user_id = ${userId}`).map(toVault);
  }
  async getVault(id: string) {
    const [r] = await this.sql`SELECT * FROM vaults WHERE id = ${id}`;
    return r ? toVault(r) : null;
  }

  async itemIds(vaultId: string) {
    return (await this.sql`SELECT item_id FROM items WHERE vault_id = ${vaultId}`).map((r) => r.item_id as string);
  }

  async pull(vaultId: string, since: number, limit: number) {
    return (await this.sql`SELECT item_id, rev, seq, nonce, ciphertext FROM items WHERE vault_id = ${vaultId} AND seq > ${since} ORDER BY seq LIMIT ${limit}`).map(toChange);
  }

  async push(vaultId: string, c: { itemId: string; baseRev: number; nonce: string; ciphertext: string; deviceId: string }): Promise<PushOutcome> {
    return this.sql.begin(async (tx) => {
      const [cur] = await tx`SELECT item_id, rev, seq, nonce, ciphertext FROM items WHERE vault_id = ${vaultId} AND item_id = ${c.itemId} FOR UPDATE`;
      if (n(cur?.rev ?? 0) !== c.baseRev) return { status: 'conflict' as const, current: toChange(cur!) };
      const [v] = await tx`UPDATE vaults SET seq = seq + 1 WHERE id = ${vaultId} RETURNING seq`;
      const seq = n(v!.seq);
      const rev = n(cur?.rev ?? 0) + 1;
      await tx`INSERT INTO items (vault_id, item_id, rev, seq, nonce, ciphertext, updated_by, updated_at)
               VALUES (${vaultId}, ${c.itemId}, ${rev}, ${seq}, ${c.nonce}, ${c.ciphertext}, ${c.deviceId}, ${Date.now()})
               ON CONFLICT (vault_id, item_id) DO UPDATE SET rev = EXCLUDED.rev, seq = EXCLUDED.seq, nonce = EXCLUDED.nonce,
                 ciphertext = EXCLUDED.ciphertext, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`;
      return { status: 'ok' as const, rev, seq };
    });
  }

  // --- teams -----------------------------------------------------------------------------------

  async createTeam(team: TeamRecord, vault: VaultRecord, owner: MemberRecord) {
    try {
      await this.sql.begin(async (tx) => {
        await tx`INSERT INTO teams (id, vault_id, name_enc, created_by, created_at) VALUES (${team.id}, ${team.vaultId}, ${team.nameEnc}, ${team.createdBy}, ${team.createdAt})`;
        await tx`INSERT INTO vaults (id, kind, owner_user_id, team_id, key_wrapped, seq, key_gen) VALUES (${vault.id}, 'team', NULL, ${team.id}, '', 0, ${vault.keyGen})`;
        await tx`INSERT INTO team_members (team_id, user_id, role, status, key_wrapped, key_gen, joined_at)
                 VALUES (${owner.teamId}, ${owner.userId}, ${owner.role}, ${owner.status}, ${owner.keyWrapped}, ${owner.keyGen}, ${owner.joinedAt})`;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw Object.assign(new Error('exists'), { code: 'EXISTS' });
      throw e;
    }
  }
  async getTeam(id: string) {
    const [r] = await this.sql`SELECT * FROM teams WHERE id = ${id}`;
    return r ? toTeam(r) : null;
  }
  async updateTeam(id: string, patch: { nameEnc: string }) {
    await this.sql`UPDATE teams SET name_enc = ${patch.nameEnc} WHERE id = ${id}`;
  }
  async deleteTeam(id: string) {
    // Cascades to the vault (and its items), members and invites.
    await this.sql`DELETE FROM teams WHERE id = ${id}`;
  }
  async listTeams(userId: string) {
    const rows = await this.sql`
      SELECT t.id AS t_id, t.vault_id AS t_vault_id, t.name_enc AS t_name_enc, t.created_by AS t_created_by, t.created_at AS t_created_at,
             m.*, v.id AS v_id, v.seq AS v_seq, v.key_gen AS v_key_gen, v.needs_rotation AS v_needs_rotation,
             (SELECT count(*) FROM team_members x WHERE x.team_id = t.id) AS member_count
      FROM team_members m JOIN teams t ON t.id = m.team_id JOIN vaults v ON v.id = t.vault_id
      WHERE m.user_id = ${userId} ORDER BY t.created_at`;
    return rows.map((r) => ({
      team: { id: r.t_id as string, vaultId: r.t_vault_id as string, nameEnc: r.t_name_enc as string, createdBy: r.t_created_by as string, createdAt: n(r.t_created_at) },
      member: toMember(r),
      vault: { id: r.v_id as string, kind: 'team' as const, ownerUserId: null, teamId: r.t_id as string, keyWrapped: '', seq: n(r.v_seq), keyGen: n(r.v_key_gen), needsRotation: !!r.v_needs_rotation },
      memberCount: n(r.member_count),
    }));
  }
  async ownedTeamCount(userId: string) {
    const [r] = await this.sql`SELECT count(*) AS c FROM team_members WHERE user_id = ${userId} AND role = 'owner'`;
    return n(r!.c);
  }

  async listMembers(teamId: string): Promise<MemberView[]> {
    const rows = await this.sql`SELECT m.*, u.email, u.public_key FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ${teamId} ORDER BY m.joined_at`;
    return rows.map((r) => ({ ...toMember(r), email: r.email as string, publicKey: r.public_key as string }));
  }
  async getMember(teamId: string, userId: string) {
    const [r] = await this.sql`SELECT * FROM team_members WHERE team_id = ${teamId} AND user_id = ${userId}`;
    return r ? toMember(r) : null;
  }
  async addMember(m: MemberRecord) {
    await this.sql`INSERT INTO team_members (team_id, user_id, role, status, key_wrapped, key_gen, joined_at)
                   VALUES (${m.teamId}, ${m.userId}, ${m.role}, ${m.status}, ${m.keyWrapped}, ${m.keyGen}, ${m.joinedAt})
                   ON CONFLICT (team_id, user_id) DO NOTHING`;
  }
  async updateMember(teamId: string, userId: string, patch: Partial<MemberRecord>) {
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) if (MEMBER_COLUMNS[k]) set[MEMBER_COLUMNS[k]] = v;
    if (Object.keys(set).length) await this.sql`UPDATE team_members SET ${this.sql(set)} WHERE team_id = ${teamId} AND user_id = ${userId}`;
  }
  async removeMember(teamId: string, userId: string) {
    await this.sql`DELETE FROM team_members WHERE team_id = ${teamId} AND user_id = ${userId}`;
  }
  async setNeedsRotation(vaultId: string, value: boolean) {
    await this.sql`UPDATE vaults SET needs_rotation = ${value} WHERE id = ${vaultId}`;
  }

  async createInvite(i: InviteRecord) {
    try {
      await this.sql`INSERT INTO team_invites (id, team_id, email, role, invited_by, created_at) VALUES (${i.id}, ${i.teamId}, ${i.email}, ${i.role}, ${i.invitedBy}, ${i.createdAt})`;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw Object.assign(new Error('exists'), { code: 'EXISTS' });
      throw e;
    }
  }
  async getInvite(id: string) {
    const [r] = await this.sql`SELECT * FROM team_invites WHERE id = ${id}`;
    return r ? toInvite(r) : null;
  }
  async listInvitesForEmail(email: string) {
    return (await this.sql`SELECT * FROM team_invites WHERE email = ${email} ORDER BY created_at`).map(toInvite);
  }
  async listInvitesForTeam(teamId: string) {
    return (await this.sql`SELECT * FROM team_invites WHERE team_id = ${teamId} ORDER BY created_at`).map(toInvite);
  }
  async deleteInvite(id: string) {
    await this.sql`DELETE FROM team_invites WHERE id = ${id}`;
  }

  async rotateTeamVault(teamId: string, vaultId: string, r: RotateInput) {
    return this.sql.begin(async (tx) => {
      const [v] = await tx`SELECT seq FROM vaults WHERE id = ${vaultId} FOR UPDATE`;
      if (n(v!.seq) !== r.baseSeq) return { status: 'stale' as const };
      let seq = n(v!.seq);
      const now = Date.now();
      for (const it of r.items) {
        seq += 1;
        await tx`UPDATE items SET rev = rev + 1, seq = ${seq}, nonce = ${it.nonce}, ciphertext = ${it.ciphertext}, updated_by = ${r.deviceId}, updated_at = ${now}
                 WHERE vault_id = ${vaultId} AND item_id = ${it.itemId}`;
      }
      await tx`UPDATE vaults SET seq = ${seq}, key_gen = ${r.keyGen}, needs_rotation = false WHERE id = ${vaultId}`;
      if (r.remove.length) await tx`DELETE FROM team_members WHERE team_id = ${teamId} AND user_id IN ${tx(r.remove)}`;
      for (const m of r.members) {
        await tx`UPDATE team_members SET key_wrapped = ${m.keyWrapped}, key_gen = ${r.keyGen} WHERE team_id = ${teamId} AND user_id = ${m.userId}`;
      }
      await tx`UPDATE teams SET name_enc = ${r.nameEnc} WHERE id = ${teamId}`;
      return { status: 'ok' as const, seq };
    });
  }

  async appendAudit(entries: Array<Omit<AuditRecord, 'id'>>) {
    if (!entries.length) return;
    const rows = entries.map((e) => ({
      team_id: e.teamId,
      actor_user_id: e.actorUserId,
      actor_email: e.actorEmail,
      device_id: e.deviceId,
      device_name: e.deviceName,
      action: e.action,
      item_id: e.itemId,
      at: e.at,
      meta: this.sql.json(e.meta as never),
      client_reported: e.clientReported,
    }));
    await this.sql`INSERT INTO audit_log ${this.sql(rows)}`;
  }
  async listAudit(teamId: string, before: number | undefined, limit: number) {
    const rows =
      before === undefined
        ? await this.sql`SELECT * FROM audit_log WHERE team_id = ${teamId} ORDER BY id DESC LIMIT ${limit}`
        : await this.sql`SELECT * FROM audit_log WHERE team_id = ${teamId} AND id < ${before} ORDER BY id DESC LIMIT ${limit}`;
    return rows.map(toAudit);
  }
}
