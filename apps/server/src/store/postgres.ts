import postgres from 'postgres';
import type { Change } from '@chh/shared/sync';
import type { DeviceRecord, PushOutcome, Store, TokenRecord, UserRecord, VaultRecord } from './types';

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
const toVault = (r: Row): VaultRecord => ({ id: r.id as string, kind: r.kind as VaultRecord['kind'], ownerUserId: r.owner_user_id as string, keyWrapped: r.key_wrapped as string, seq: n(r.seq) });
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
        await tx`INSERT INTO vaults (id, kind, owner_user_id, key_wrapped, seq) VALUES (${v.id}, ${v.kind}, ${v.ownerUserId}, ${v.keyWrapped}, 0)`;
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
}
