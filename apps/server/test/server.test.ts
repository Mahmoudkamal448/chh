import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app';
import type { Config } from '../src/config';
import { base32Decode, hotp, totpStep } from '../src/crypto';
import { MemoryStore } from '../src/store/memory';
import { PostgresStore } from '../src/store/postgres';
import type { Store } from '../src/store/types';

const kdf = { alg: 'argon2id13' as const, salt: randomBytes(16).toString('base64'), ops: 3, mem: 256 * 1024 * 1024 };
const b64 = (n = 32) => randomBytes(n).toString('base64');
const device = { name: 'test laptop', platform: 'linux' };

function config(over: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    store: 'memory',
    serverSecret: randomBytes(32),
    allowRegistration: true,
    trustProxy: false,
    logLevel: 'silent',
    accessTtl: 3600,
    refreshTtl: 86400,
    authRateLimit: 1000,
    ...over,
  };
}

const stores: Array<[string, () => Promise<Store>]> = [['memory', async () => new MemoryStore()]];
if (process.env.TEST_DATABASE_URL) {
  stores.push([
    'postgres',
    async () => {
      const s = new PostgresStore(process.env.TEST_DATABASE_URL!);
      await s.migrate();
      return s;
    },
  ]);
}

describe.each(stores)('sync server (%s store)', (_name, makeStore) => {
  let store: Store;
  let app: App;
  let cfg: Config;

  beforeAll(async () => {
    store = await makeStore();
    cfg = config();
    app = await buildApp({ config: cfg, store });
  });
  afterAll(async () => {
    await app.close();
    await store.close();
  });

  const post = (url: string, payload: unknown, token?: string) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });

  async function register(email = `${randomUUID()}@example.com`) {
    const authKey = b64();
    const recoveryAuth = b64();
    const vaultId = randomUUID();
    const res = await post('/v1/auth/register', {
      email,
      authKey,
      recoveryAuthKey: recoveryAuth,
      kdf,
      blobs: { accountKeyWrapped: b64(72), publicKey: b64(), privateKeyWrapped: b64(72), recoveryWrapped: b64(72) },
      vault: { id: vaultId, keyWrapped: b64(72) },
      device,
    });
    expect(res.statusCode).toBe(201);
    return { email, authKey, recoveryAuth, vaultId, ...(res.json() as { tokens: { accessToken: string; refreshToken: string; deviceId: string } }) };
  }

  it('prelogin returns the stored KDF for users and a stable decoy otherwise', async () => {
    const u = await register();
    expect((await post('/v1/auth/prelogin', { email: u.email })).json().kdf).toEqual(kdf);
    const a = (await post('/v1/auth/prelogin', { email: 'nobody@example.com' })).json().kdf;
    const b = (await post('/v1/auth/prelogin', { email: 'NOBODY@example.com' })).json().kdf;
    expect(a).toEqual(b);
    expect(a.salt).not.toBe(kdf.salt);
  });

  it('rejects duplicate emails, weak KDFs and malformed input', async () => {
    const u = await register();
    const dup = await post('/v1/auth/register', {
      email: u.email,
      authKey: b64(),
      recoveryAuthKey: b64(),
      kdf,
      blobs: { accountKeyWrapped: b64(), publicKey: b64(), privateKeyWrapped: b64(), recoveryWrapped: b64() },
      vault: { id: randomUUID(), keyWrapped: b64() },
      device,
    });
    expect(dup.statusCode).toBe(409);
    const weak = await post('/v1/auth/register', {
      email: 'weak@example.com',
      authKey: b64(),
      recoveryAuthKey: b64(),
      kdf: { ...kdf, mem: 8 * 1024 * 1024 },
      blobs: { accountKeyWrapped: b64(), publicKey: b64(), privateKeyWrapped: b64(), recoveryWrapped: b64() },
      vault: { id: randomUUID(), keyWrapped: b64() },
      device,
    });
    expect(weak.json().error).toBe('weak_kdf');
    expect((await post('/v1/auth/register', { email: 'x' })).statusCode).toBe(400);
  });

  it('logs in only with the right auth key and returns account blobs', async () => {
    const u = await register();
    expect((await post('/v1/auth/login', { email: u.email, authKey: b64(), device })).json().error).toBe('invalid_credentials');
    expect((await post('/v1/auth/login', { email: 'ghost@example.com', authKey: b64(), device })).json().error).toBe('invalid_credentials');
    const ok = await post('/v1/auth/login', { email: u.email, authKey: u.authKey, device });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().account.vaults).toEqual([expect.objectContaining({ id: u.vaultId, kind: 'personal' })]);
  });

  it('requires a valid access token and rotates refresh tokens with reuse detection', async () => {
    const u = await register();
    expect((await app.inject({ method: 'GET', url: '/v1/account' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/account', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    const r1 = await post('/v1/auth/refresh', { refreshToken: u.tokens.refreshToken });
    expect(r1.statusCode).toBe(200);
    const fresh = r1.json();
    // Reusing the old refresh token signs the device out entirely.
    expect((await post('/v1/auth/refresh', { refreshToken: u.tokens.refreshToken })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/account', headers: { authorization: `Bearer ${fresh.accessToken}` } })).statusCode).toBe(401);
  });

  it('TOTP: enroll, require on login, block replays, accept a recovery code once, disable', async () => {
    const u = await register();
    const tok = u.tokens.accessToken;
    const { secret, uri } = (await post('/v1/account/totp/setup', {}, tok)).json();
    expect(uri).toContain('otpauth://totp/');
    const code = (offset = 0) => hotp(base32Decode(secret), totpStep() + offset);
    expect((await post('/v1/account/totp/enable', { code: '000000' }, tok)).json().error).toBe('invalid_totp');
    const enabled = (await post('/v1/account/totp/enable', { code: code() }, tok)).json();
    expect(enabled.recoveryCodes).toHaveLength(10);

    expect((await post('/v1/auth/login', { email: u.email, authKey: u.authKey, device })).json().error).toBe('totp_required');
    const next = code(1);
    expect((await post('/v1/auth/login', { email: u.email, authKey: u.authKey, totp: next, device })).statusCode).toBe(200);
    expect((await post('/v1/auth/login', { email: u.email, authKey: u.authKey, totp: next, device })).json().error).toBe('invalid_totp');
    const rc = enabled.recoveryCodes[0];
    expect((await post('/v1/auth/login', { email: u.email, authKey: u.authKey, recoveryCode: rc.toUpperCase(), device })).statusCode).toBe(200);
    expect((await post('/v1/auth/login', { email: u.email, authKey: u.authKey, recoveryCode: rc, device })).json().error).toBe('invalid_totp');

    expect((await post('/v1/account/totp/disable', { recoveryCode: enabled.recoveryCodes[1] }, tok)).statusCode).toBe(204);
    expect((await post('/v1/auth/login', { email: u.email, authKey: u.authKey, device })).statusCode).toBe(200);
  });

  it('sync: optimistic concurrency, pagination, and isolation between users', async () => {
    const u = await register();
    const tok = u.tokens.accessToken;
    const push = (itemId: string, baseRev: number) => post('/v1/sync/push', { vaultId: u.vaultId, changes: [{ itemId, baseRev, nonce: b64(24), ciphertext: b64(64) }] }, tok);
    expect((await push('a', 0)).json().results[0]).toMatchObject({ status: 'ok', rev: 1, seq: 1 });
    expect((await push('b', 0)).json().results[0]).toMatchObject({ status: 'ok', rev: 1, seq: 2 });
    const conflict = (await push('a', 0)).json().results[0];
    expect(conflict).toMatchObject({ status: 'conflict', current: { itemId: 'a', rev: 1 } });
    expect((await push('a', 1)).json().results[0]).toMatchObject({ status: 'ok', rev: 2, seq: 3 });

    const page1 = (await post('/v1/sync/pull', { vaultId: u.vaultId, since: 0, limit: 1 }, tok)).json();
    expect(page1).toMatchObject({ hasMore: true, nextSince: 2 });
    expect(page1.changes.map((c: { itemId: string }) => c.itemId)).toEqual(['b']);
    const page2 = (await post('/v1/sync/pull', { vaultId: u.vaultId, since: page1.nextSince, limit: 10 }, tok)).json();
    expect(page2).toMatchObject({ hasMore: false, nextSince: 3 });

    const other = await register();
    expect((await post('/v1/sync/pull', { vaultId: u.vaultId, since: 0 }, other.tokens.accessToken)).statusCode).toBe(404);
    expect((await post('/v1/sync/push', { vaultId: u.vaultId, changes: [{ itemId: 'x', baseRev: 0, nonce: b64(24), ciphertext: b64() }] }, other.tokens.accessToken)).statusCode).toBe(404);
  });

  it('password change rewraps and signs out other devices', async () => {
    const u = await register();
    const second = (await post('/v1/auth/login', { email: u.email, authKey: u.authKey, device })).json().tokens;
    const newAuthKey = b64();
    const bad = await post('/v1/account/password', { currentAuthKey: b64(), newAuthKey, newKdf: kdf, accountKeyWrapped: b64() }, u.tokens.accessToken);
    expect(bad.statusCode).toBe(403);
    const ok = await post('/v1/account/password', { currentAuthKey: u.authKey, newAuthKey, newKdf: kdf, accountKeyWrapped: 'bmV3' }, u.tokens.accessToken);
    expect(ok.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/v1/account', headers: { authorization: `Bearer ${second.accessToken}` } })).statusCode).toBe(401);
    const acct = await app.inject({ method: 'GET', url: '/v1/account', headers: { authorization: `Bearer ${u.tokens.accessToken}` } });
    expect(acct.json().blobs.accountKeyWrapped).toBe('bmV3');
    expect((await post('/v1/auth/login', { email: u.email, authKey: newAuthKey, device })).statusCode).toBe(200);
  });

  it('recovers a forgotten password with the recovery key and ends all other sessions', async () => {
    const u = await register();
    expect((await post('/v1/auth/recover/start', { email: u.email, recoveryAuthKey: b64() })).statusCode).toBe(401);
    const start = await post('/v1/auth/recover/start', { email: u.email, recoveryAuthKey: u.recoveryAuth });
    expect(start.statusCode).toBe(200);
    const newAuthKey = b64();
    const finish = await post('/v1/auth/recover/finish', { recoveryToken: start.json().recoveryToken, newAuthKey, newKdf: kdf, accountKeyWrapped: 'cmVj', device });
    expect(finish.statusCode).toBe(200);
    expect(finish.json().account.blobs.accountKeyWrapped).toBe('cmVj');
    // Token is single-use; old sessions and the old password stop working.
    expect((await post('/v1/auth/recover/finish', { recoveryToken: start.json().recoveryToken, newAuthKey, newKdf: kdf, accountKeyWrapped: 'eA==', device })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/account', headers: { authorization: `Bearer ${u.tokens.accessToken}` } })).statusCode).toBe(401);
    expect((await post('/v1/auth/login', { email: u.email, authKey: u.authKey, device })).statusCode).toBe(401);
    expect((await post('/v1/auth/login', { email: u.email, authKey: newAuthKey, device })).statusCode).toBe(200);
  });

  it('lists and removes devices; deletes accounts', async () => {
    const u = await register();
    const second = (await post('/v1/auth/login', { email: u.email, authKey: u.authKey, device: { name: 'phone', platform: 'darwin' } })).json().tokens;
    const auth = { authorization: `Bearer ${u.tokens.accessToken}` };
    const list = (await app.inject({ method: 'GET', url: '/v1/devices', headers: auth })).json();
    expect(list).toHaveLength(2);
    expect(list.find((d: { current: boolean }) => d.current).id).toBe(u.tokens.deviceId);
    expect((await app.inject({ method: 'DELETE', url: `/v1/devices/${second.deviceId}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/v1/account', headers: { authorization: `Bearer ${second.accessToken}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/v1/account', headers: auth, payload: { authKey: u.authKey } })).statusCode).toBe(204);
    expect((await post('/v1/auth/login', { email: u.email, authKey: u.authKey, device })).statusCode).toBe(401);
  });

  it('notifies connected devices over WebSocket when a vault changes', async () => {
    const u = await register();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/sync/ws`);
    const messages: unknown[] = [];
    ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ type: 'auth', token: u.tokens.accessToken }));
    await expect.poll(() => messages).toContainEqual({ type: 'ready' });
    await post('/v1/sync/push', { vaultId: u.vaultId, changes: [{ itemId: 'z', baseRev: 0, nonce: b64(24), ciphertext: b64() }] }, u.tokens.accessToken);
    await expect.poll(() => messages).toContainEqual({ type: 'changed', vaultId: u.vaultId, seq: 1 });
    ws.close();
  });
});

describe('server hardening', () => {
  it('rate-limits auth endpoints and can close registration', async () => {
    const app = await buildApp({ config: config({ authRateLimit: 3, allowRegistration: false }), store: new MemoryStore() });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await app.inject({ method: 'POST', url: '/v1/auth/prelogin', payload: { email: 'a@b.co' } })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const app2 = await buildApp({ config: config({ allowRegistration: false }), store: new MemoryStore() });
    const r = await app2.inject({ method: 'POST', url: '/v1/auth/register', payload: {} });
    expect(r.json().error).toBe('registration_closed');
    await app.close();
    await app2.close();
  });
});
