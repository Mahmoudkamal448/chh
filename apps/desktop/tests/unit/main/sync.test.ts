import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomKey } from '@chh/vault-crypto';
import { buildApp } from '../../../../server/src/app';
import { base32Decode, hotp, totpStep } from '../../../../server/src/crypto';
import { MemoryStore } from '../../../../server/src/store/memory';
import { openDatabase, type Db } from '../../../src/main/db/database';
import { GroupsRepo } from '../../../src/main/db/groups-repo';
import { HostsRepo } from '../../../src/main/db/hosts-repo';
import { ItemStore } from '../../../src/main/db/item-store';
import { KeysRepo } from '../../../src/main/db/keys-repo';
import { SyncEngine } from '../../../src/main/sync/engine';
import { normalizeServerUrl } from '../../../src/main/sync/http';
import { LocalVault } from '../../../src/main/vault/local-vault';

const KDF = { ops: 2, mem: 64 * 1024 * 1024 };
// Sign-ins run Argon2id and a full sync against a real server: well past 5 s on slow CI runners.
vi.setConfig({ testTimeout: 30_000 });
let serverUrl: string;
let serverStore: MemoryStore;
let close: () => Promise<void>;
const dirs: string[] = [];
const opened: Device[] = [];

interface Device {
  db: Db;
  hosts: HostsRepo;
  keys: KeysRepo;
  groups: GroupsRepo;
  sync: SyncEngine;
  remoteChanges: number;
}

function device(name: string): Device {
  const dir = mkdtempSync(join(tmpdir(), `cy-sync-${name}-`));
  dirs.push(dir);
  const key = randomKey();
  const db = openDatabase(join(dir, 'db'), key);
  const vault = LocalVault.openOrCreate(db, key);
  const store = new ItemStore(db, `dev-${name}`, vault.id);
  const groups = new GroupsRepo(store);
  const d: Device = {
    db,
    groups,
    hosts: new HostsRepo(store, vault, groups),
    keys: new KeysRepo(store, vault),
    remoteChanges: 0,
    sync: null as unknown as SyncEngine,
  };
  opened.push(d);
  d.sync = new SyncEngine({ db, store, vault, kdfCost: KDF, deviceName: name, onStatus: () => undefined, onRemoteChange: () => d.remoteChanges++ });
  return d;
}

const labels = (d: Device) => d.hosts.list({}).items.map((h) => h.label).sort();

beforeAll(async () => {
  serverStore = new MemoryStore();
  const app = await buildApp({
    config: { port: 0, host: '127.0.0.1', store: 'memory', serverSecret: randomBytes(32), allowRegistration: true, trustProxy: false, logLevel: 'silent', accessTtl: 3600, refreshTtl: 86400, authRateLimit: 1000 },
    store: serverStore,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  serverUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = () => app.close();
});

afterAll(async () => {
  await close();
  // Windows can't delete a database file that is still open.
  for (const d of opened) {
    d.sync.stop();
    d.db.close();
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('server URL validation', () => {
  it('requires https except for local/private hosts', () => {
    expect(normalizeServerUrl('sync.example.com/').url).toBe('https://sync.example.com');
    expect(normalizeServerUrl('http://192.168.1.5:8080').insecure).toBe(true);
    expect(() => normalizeServerUrl('http://sync.example.com')).toThrow();
    expect(() => normalizeServerUrl('ftp://x')).toThrow();
  });
});

describe('end-to-end encrypted sync between two devices', () => {
  const email = `me-${Date.now()}@example.com`;
  const password = 'correct horse battery staple';
  let a: Device;
  let b: Device;
  let recoveryKey: string;

  it('registers on device A and uploads only ciphertext', async () => {
    a = device('a');
    const g = a.groups.create({ label: 'Production', settings: { username: 'deploy' } });
    a.hosts.create({ label: 'db-primary', address: 'db1.internal', groupId: g.id, password: 'super-secret-pw' });
    a.keys.generate({ label: 'Laptop key', algorithm: 'ed25519' });
    ({ recoveryKey } = await a.sync.register({ serverUrl, email, password }));
    await a.sync.syncNow();
    expect(a.sync.status()).toMatchObject({ signedIn: true, state: 'idle', pending: 0 });
    const dump = JSON.stringify([...serverStore.items.values()]);
    for (const secret of ['db-primary', 'db1.internal', 'super-secret-pw', 'Production', 'Laptop key', 'OPENSSH']) expect(dump).not.toContain(secret);
    expect(serverStore.items.size).toBe(3);
  });

  it('device B signs in, keeps its own data, and receives A’s data with secrets intact', async () => {
    b = device('b');
    b.hosts.create({ label: 'b-local', address: 'b.example', password: 'b-pw' });
    expect((await b.sync.login({ serverUrl, email, password })).status).toBe('ok');
    await b.sync.syncNow();
    expect(labels(b)).toEqual(['b-local', 'db-primary']);
    const remote = b.hosts.list({ query: 'db-primary' }).items[0]!;
    expect(b.hosts.getPassword(remote.id)).toBe('super-secret-pw');
    expect(b.hosts.getPassword(b.hosts.list({ query: 'b-local' }).items[0]!.id)).toBe('b-pw'); // re-sealed for the new vault
    expect(b.keys.getPrivate(b.keys.list()[0]!.id)).toContain('OPENSSH PRIVATE KEY');
    await a.sync.syncNow();
    expect(labels(a)).toEqual(['b-local', 'db-primary']);
  });

  it('merges concurrent edits field by field', async () => {
    const idA = a.hosts.list({ query: 'db-primary' }).items[0]!.id;
    a.hosts.update(idA, { label: 'db-main' });
    b.hosts.update(idA, { settings: { port: 2222 } });
    await a.sync.syncNow();
    await b.sync.syncNow(); // conflict → merge → push
    await a.sync.syncNow();
    for (const d of [a, b]) expect(d.hosts.get(idA)).toMatchObject({ label: 'db-main', settings: { port: 2222 } });
  });

  it('refuses rollbacks: a stale version served by the server never replaces newer local data', async () => {
    const id = a.hosts.list({ query: 'db-main' }).items[0]!.id;
    const key = [...serverStore.items.keys()].find((k) => k.endsWith(`/${id}`))!;
    const stale = structuredClone(serverStore.items.get(key)!);
    a.hosts.update(id, { notes: 'newer' });
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(b.hosts.get(id).notes).toBe('newer');
    // A malicious/buggy server replays the old ciphertext under a new revision.
    const cur = serverStore.items.get(key)!;
    const vault = serverStore.vaults.get(cur.vaultId)!;
    vault.seq += 1;
    serverStore.items.set(key, { ...stale, rev: cur.rev + 1, seq: vault.seq });
    await b.sync.syncNow();
    expect(b.hosts.get(id).notes).toBe('newer');
    await a.sync.syncNow();
    expect(a.hosts.get(id).notes).toBe('newer');
  });

  it('propagates deletions', async () => {
    const id = a.hosts.list({ query: 'b-local' }).items[0]!.id;
    a.hosts.remove([id]);
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(labels(b)).toEqual(['db-main']);
  });

  it('pushes live changes to other devices over WebSocket', async () => {
    b.sync.start();
    const before = b.remoteChanges;
    a.hosts.create({ label: 'live-host', address: 'live.example' });
    await a.sync.syncNow();
    await expect.poll(() => labels(b), { timeout: 10_000 }).toContain('live-host');
    expect(b.remoteChanges).toBeGreaterThan(before);
    b.sync.stop();
  });

  it('requires TOTP once enabled', async () => {
    const { secret } = await a.sync.totpSetup();
    const code = (o = 0) => hotp(base32Decode(secret), totpStep() + o);
    const { recoveryCodes } = await a.sync.totpEnable(code());
    const c = device('c');
    expect((await c.sync.login({ serverUrl, email, password })).status).toBe('totp_required');
    expect((await c.sync.login({ serverUrl, email, password, totp: code(1) })).status).toBe('ok');
    await c.sync.syncNow();
    expect(labels(c)).toContain('live-host');
    // Codes at or before the last accepted step are replays; a recovery code still works.
    await expect(a.sync.totpDisable({ code: code(0) })).rejects.toMatchObject({ code: 'invalid_totp' });
    await a.sync.totpDisable({ recoveryCode: recoveryCodes[0] });
  });

  it('rejects wrong passwords and changes the password', async () => {
    const d = device('d');
    await expect(d.sync.login({ serverUrl, email, password: 'wrong' })).rejects.toMatchObject({ code: 'invalid_credentials' });
    await a.sync.changePassword(password, 'new password 2');
    await expect(d.sync.login({ serverUrl, email, password })).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect((await d.sync.login({ serverUrl, email, password: 'new password 2' })).status).toBe('ok');
  });

  it('recovers a forgotten password with the recovery key — data stays decryptable', async () => {
    const e = device('e');
    expect((await e.sync.recover({ serverUrl, email, recoveryKey, newPassword: 'after recovery' })).status).toBe('ok');
    await e.sync.syncNow();
    const host = e.hosts.list({ query: 'db-main' }).items[0]!;
    expect(e.hosts.getPassword(host.id)).toBe('super-secret-pw');
    const f = device('f');
    expect((await f.sync.login({ serverUrl, email, password: 'after recovery' })).status).toBe('ok');
  });

  it('signing out can keep or remove local data', async () => {
    const g = device('g');
    await g.sync.login({ serverUrl, email, password: 'after recovery' });
    await g.sync.syncNow();
    expect(labels(g).length).toBeGreaterThan(0);
    await g.sync.logout(false);
    expect(g.sync.status().signedIn).toBe(false);
    expect(labels(g)).toEqual([]);
  });
});
