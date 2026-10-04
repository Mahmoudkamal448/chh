import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app';
import type { Config } from '../src/config';
import { MemoryStore } from '../src/store/memory';
import { PostgresStore } from '../src/store/postgres';
import type { Store } from '../src/store/types';

const kdf = { alg: 'argon2id13' as const, salt: randomBytes(16).toString('base64'), ops: 3, mem: 256 * 1024 * 1024 };
const b64 = (n = 32) => randomBytes(n).toString('base64');
const device = { name: 'test laptop', platform: 'linux' };

const config = (): Config => ({
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
});

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

describe.each(stores)('teams (%s store)', (_name, makeStore) => {
  let store: Store;
  let app: App;

  beforeAll(async () => {
    store = await makeStore();
    app = await buildApp({ config: config(), store });
  });
  afterAll(async () => {
    await app.close();
    await store.close();
  });

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });

  async function user() {
    const email = `${randomUUID()}@example.com`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email,
        authKey: b64(),
        recoveryAuthKey: b64(),
        kdf,
        blobs: { accountKeyWrapped: b64(72), publicKey: b64(), privateKeyWrapped: b64(72), recoveryWrapped: b64(72) },
        vault: { id: randomUUID(), keyWrapped: b64(72) },
        device,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { tokens: { accessToken: string; userId: string }; account: { blobs: { publicKey: string } } };
    return { email, token: body.tokens.accessToken, id: body.tokens.userId, publicKey: body.account.blobs.publicKey };
  }

  /** Owner creates a team; each other user is invited with a role, accepts and gets confirmed. */
  async function team(owner: Awaited<ReturnType<typeof user>>, members: Array<[Awaited<ReturnType<typeof user>>, 'admin' | 'editor' | 'viewer']> = []) {
    const teamId = randomUUID();
    const vaultId = randomUUID();
    expect((await call('POST', '/v1/teams', owner.token, { teamId, vaultId, nameEnc: b64(40), keyWrapped: b64(80) })).statusCode).toBe(201);
    for (const [m, role] of members) {
      expect((await call('POST', `/v1/teams/${teamId}/invites`, owner.token, { email: m.email, role })).statusCode).toBe(201);
      const [invite] = (await call('GET', '/v1/invites', m.token)).json();
      expect((await call('POST', `/v1/invites/${invite.id}/accept`, m.token)).statusCode).toBe(204);
      expect((await call('POST', `/v1/teams/${teamId}/members/${m.id}/confirm`, owner.token, { keyWrapped: b64(80), keyGen: 1 })).statusCode).toBe(204);
    }
    return { teamId, vaultId };
  }

  const push = (token: string, vaultId: string, itemId: string, baseRev = 0, keyGen?: number) =>
    call('POST', '/v1/sync/push', token, { vaultId, keyGen, changes: [{ itemId, baseRev, nonce: b64(24), ciphertext: b64(64) }] });

  it('creates a team and walks an invite through accept and confirm', async () => {
    const owner = await user();
    const bob = await user();
    const teamId = randomUUID();
    const vaultId = randomUUID();
    await call('POST', '/v1/teams', owner.token, { teamId, vaultId, nameEnc: b64(40), keyWrapped: b64(80) });
    const [mine] = (await call('GET', '/v1/teams', owner.token)).json();
    expect(mine).toMatchObject({ id: teamId, vaultId, role: 'owner', status: 'confirmed', keyGen: 1, memberCount: 1, needsRotation: false });
    expect(mine.keyWrapped).toBeTruthy();

    expect((await call('POST', `/v1/teams/${teamId}/invites`, owner.token, { email: bob.email.toUpperCase(), role: 'editor' })).statusCode).toBe(201);
    expect((await call('POST', `/v1/teams/${teamId}/invites`, owner.token, { email: bob.email, role: 'viewer' })).json().error).toBe('already_invited');
    const invites = (await call('GET', '/v1/invites', bob.token)).json();
    expect(invites).toEqual([expect.objectContaining({ teamId, email: bob.email, role: 'editor', invitedBy: owner.email })]);
    // Nobody else can accept it.
    const eve = await user();
    expect((await call('POST', `/v1/invites/${invites[0].id}/accept`, eve.token)).statusCode).toBe(404);

    expect((await call('POST', `/v1/invites/${invites[0].id}/accept`, bob.token)).statusCode).toBe(204);
    const pending = (await call('GET', '/v1/teams', bob.token)).json()[0];
    expect(pending).toMatchObject({ status: 'accepted', role: 'editor', keyWrapped: null });
    // Not confirmed yet: no access to the vault.
    expect((await call('POST', '/v1/sync/pull', bob.token, { vaultId, since: 0 })).statusCode).toBe(404);

    const members = (await call('GET', `/v1/teams/${teamId}/members`, owner.token)).json();
    expect(members.find((m: { userId: string }) => m.userId === bob.id)).toMatchObject({ email: bob.email, publicKey: bob.publicKey, status: 'accepted' });
    expect((await call('POST', `/v1/teams/${teamId}/members/${bob.id}/confirm`, owner.token, { keyWrapped: b64(80), keyGen: 2 })).json().error).toBe('stale_key');
    expect((await call('POST', `/v1/teams/${teamId}/members/${bob.id}/confirm`, owner.token, { keyWrapped: b64(80), keyGen: 1 })).statusCode).toBe(204);
    expect((await call('GET', '/v1/teams', bob.token)).json()[0]).toMatchObject({ status: 'confirmed', keyWrapped: expect.any(String) });
    expect((await call('POST', '/v1/sync/pull', bob.token, { vaultId, since: 0 })).json()).toMatchObject({ changes: [], keyGen: 1 });
  });

  it('enforces roles: viewers read, editors write, admins manage, outsiders see nothing', async () => {
    const [owner, admin, editor, viewer, outsider] = await Promise.all([user(), user(), user(), user(), user()]);
    const { teamId, vaultId } = await team(owner, [
      [admin, 'admin'],
      [editor, 'editor'],
      [viewer, 'viewer'],
    ]);

    expect((await push(editor.token, vaultId, 'h1', 0, 1)).json().results[0]).toMatchObject({ status: 'ok', rev: 1 });
    expect((await push(viewer.token, vaultId, 'h2', 0, 1)).json().error).toBe('read_only');
    expect((await call('POST', '/v1/sync/pull', viewer.token, { vaultId, since: 0 })).json().changes).toHaveLength(1);
    expect((await push(outsider.token, vaultId, 'h3', 0, 1)).statusCode).toBe(404);
    expect((await call('POST', '/v1/sync/pull', outsider.token, { vaultId, since: 0 })).statusCode).toBe(404);
    // Pushes must say which key generation they used.
    expect((await push(editor.token, vaultId, 'h4')).json().error).toBe('stale_key');

    expect((await call('POST', `/v1/teams/${teamId}/invites`, editor.token, { email: 'x@example.com', role: 'viewer' })).statusCode).toBe(403);
    expect((await call('POST', `/v1/teams/${teamId}/invites`, admin.token, { email: 'x@example.com', role: 'viewer' })).statusCode).toBe(201);
    expect((await call('GET', `/v1/teams/${teamId}/audit`, editor.token)).statusCode).toBe(403);

    // Admins change roles but can't touch the owner or hand out ownership.
    expect((await call('PATCH', `/v1/teams/${teamId}/members/${viewer.id}`, admin.token, { role: 'editor' })).statusCode).toBe(204);
    expect((await call('PATCH', `/v1/teams/${teamId}/members/${owner.id}`, admin.token, { role: 'viewer' })).statusCode).toBe(403);
    expect((await call('PATCH', `/v1/teams/${teamId}/members/${editor.id}`, admin.token, { role: 'owner' })).statusCode).toBe(403);
    expect((await push(viewer.token, vaultId, 'h5', 0, 1)).json().results[0].status).toBe('ok');

    // The owner can transfer ownership and becomes an admin.
    expect((await call('PATCH', `/v1/teams/${teamId}/members/${admin.id}`, owner.token, { role: 'owner' })).statusCode).toBe(204);
    const roles = Object.fromEntries((await call('GET', `/v1/teams/${teamId}/members`, owner.token)).json().map((m: { userId: string; role: string }) => [m.userId, m.role]));
    expect(roles[admin.id]).toBe('owner');
    expect(roles[owner.id]).toBe('admin');
  });

  it('rotates the key atomically when removing a member', async () => {
    const [owner, bob, carol] = await Promise.all([user(), user(), user()]);
    const { teamId, vaultId } = await team(owner, [
      [bob, 'editor'],
      [carol, 'viewer'],
    ]);
    await push(bob.token, vaultId, 'a', 0, 1);
    await push(bob.token, vaultId, 'b', 0, 1);
    const seq = (await call('POST', '/v1/sync/pull', owner.token, { vaultId, since: 0 })).json().nextSince;
    const items = ['a', 'b'].map((itemId) => ({ itemId, nonce: b64(24), ciphertext: b64(64) }));
    const rotate = (over: object) =>
      call('POST', `/v1/teams/${teamId}/rotate`, owner.token, {
        baseSeq: seq,
        keyGen: 2,
        nameEnc: b64(40),
        members: [owner, bob].map((m) => ({ userId: m.id, keyWrapped: b64(80) })),
        items,
        remove: [carol.id],
        ...over,
      });

    // Every remaining member and every item must be covered, from the latest vault state.
    expect((await rotate({ members: [{ userId: owner.id, keyWrapped: b64(80) }] })).json().error).toBe('members_changed');
    expect((await rotate({ items: items.slice(0, 1) })).json().error).toBe('stale');
    expect((await rotate({ keyGen: 3 })).json().error).toBe('stale_key');
    expect((await rotate({ remove: [owner.id] })).statusCode).toBe(403);
    expect((await call('POST', `/v1/teams/${teamId}/rotate`, bob.token, {})).statusCode).toBe(400);
    await push(bob.token, vaultId, 'c', 0, 1);
    expect((await rotate({})).json().error).toBe('stale');

    const fresh = (await call('POST', '/v1/sync/pull', owner.token, { vaultId, since: 0 })).json();
    const all = ['a', 'b', 'c'].map((itemId) => ({ itemId, nonce: b64(24), ciphertext: b64(64) }));
    const ok = await rotate({ baseSeq: fresh.nextSince, items: all });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().keyGen).toBe(2);

    expect((await call('POST', '/v1/sync/pull', carol.token, { vaultId, since: 0 })).statusCode).toBe(404);
    expect((await call('GET', '/v1/teams', carol.token)).json()).toEqual([]);
    const after = (await call('POST', '/v1/sync/pull', bob.token, { vaultId, since: fresh.nextSince })).json();
    expect(after.keyGen).toBe(2);
    expect(after.changes.map((c: { itemId: string; rev: number }) => [c.itemId, c.rev])).toEqual([
      ['a', 2],
      ['b', 2],
      ['c', 2],
    ]);
    expect((await call('GET', '/v1/teams', bob.token)).json()[0]).toMatchObject({ keyGen: 2, keyWrapped: expect.any(String) });
    // Old-key pushes are refused; new-key pushes work.
    expect((await push(bob.token, vaultId, 'd', 0, 1)).json().error).toBe('stale_key');
    expect((await push(bob.token, vaultId, 'd', 0, 2)).json().results[0].status).toBe('ok');
  });

  it('flags the vault for rotation when a confirmed member leaves; owners cannot leave', async () => {
    const [owner, bob] = await Promise.all([user(), user()]);
    const { teamId } = await team(owner, [[bob, 'editor']]);
    expect((await call('POST', `/v1/teams/${teamId}/leave`, owner.token)).json().error).toBe('owner_cannot_leave');
    expect((await call('POST', `/v1/teams/${teamId}/leave`, bob.token)).statusCode).toBe(204);
    expect((await call('GET', '/v1/teams', owner.token)).json()[0]).toMatchObject({ needsRotation: true, memberCount: 1 });
    // Account deletion is blocked while the user owns a team; deleting the team unblocks it.
    expect((await call('DELETE', `/v1/teams/${teamId}`, bob.token)).statusCode).toBe(404);
    expect((await call('DELETE', `/v1/teams/${teamId}`, owner.token)).statusCode).toBe(204);
    expect((await call('GET', '/v1/teams', owner.token)).json()).toEqual([]);
  });

  it('records an append-only audit log, including client-reported events', async () => {
    const [owner, bob] = await Promise.all([user(), user()]);
    const { teamId, vaultId } = await team(owner, [[bob, 'editor']]);
    await push(bob.token, vaultId, 'srv-1', 0, 1);
    await call('POST', '/v1/sync/pull', owner.token, { vaultId, since: 0 });
    expect((await call('POST', `/v1/teams/${teamId}/audit`, bob.token, { events: [{ action: 'host.connected', itemId: 'srv-1', at: Date.now() + 60_000 }] })).statusCode).toBe(204);
    expect((await call('POST', `/v1/teams/${teamId}/audit`, bob.token, { events: [{ action: 'item.written', itemId: 'srv-1', at: 1 }] })).statusCode).toBe(400);

    const { entries, hasMore } = (await call('GET', `/v1/teams/${teamId}/audit`, owner.token)).json();
    expect(hasMore).toBe(false);
    expect(entries.map((e: { action: string }) => e.action)).toEqual([
      'host.connected',
      'vault.pulled',
      'item.written',
      'member.confirmed',
      'invite.accepted',
      'member.invited',
      'team.created',
    ]);
    const connected = entries[0];
    expect(connected).toMatchObject({ actorEmail: bob.email, deviceName: 'test laptop', itemId: 'srv-1', clientReported: true });
    expect(connected.at).toBeLessThanOrEqual(Date.now());
    expect(entries.find((e: { action: string }) => e.action === 'item.written')).toMatchObject({ clientReported: false, itemId: 'srv-1', meta: { rev: 1 } });

    const page = (await call('GET', `/v1/teams/${teamId}/audit?limit=2`, owner.token)).json();
    expect(page.hasMore).toBe(true);
    const next = (await call('GET', `/v1/teams/${teamId}/audit?limit=10&before=${page.entries[1].id}`, owner.token)).json();
    expect(next.entries).toHaveLength(5);
  });

  it('cancels and declines invites, and removes unconfirmed members without rotation', async () => {
    const [owner, bob, carol] = await Promise.all([user(), user(), user()]);
    const { teamId } = await team(owner);
    await call('POST', `/v1/teams/${teamId}/invites`, owner.token, { email: bob.email, role: 'viewer' });
    const [inv] = (await call('GET', `/v1/teams/${teamId}/invites`, owner.token)).json();
    expect((await call('DELETE', `/v1/teams/${teamId}/invites/${inv.id}`, owner.token)).statusCode).toBe(204);
    expect((await call('GET', '/v1/invites', bob.token)).json()).toEqual([]);

    await call('POST', `/v1/teams/${teamId}/invites`, owner.token, { email: bob.email, role: 'viewer' });
    const [mine] = (await call('GET', '/v1/invites', bob.token)).json();
    expect((await call('DELETE', `/v1/invites/${mine.id}`, bob.token)).statusCode).toBe(204);

    await call('POST', `/v1/teams/${teamId}/invites`, owner.token, { email: carol.email, role: 'editor' });
    const [c] = (await call('GET', '/v1/invites', carol.token)).json();
    await call('POST', `/v1/invites/${c.id}/accept`, carol.token);
    expect((await call('DELETE', `/v1/teams/${teamId}/members/${carol.id}`, owner.token)).statusCode).toBe(204);
    expect((await call('GET', '/v1/teams', owner.token)).json()[0]).toMatchObject({ memberCount: 1, needsRotation: false });
  });
});
