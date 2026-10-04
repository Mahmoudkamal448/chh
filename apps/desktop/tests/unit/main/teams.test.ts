import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomKey } from '@chh/vault-crypto';
import { buildApp } from '../../../../server/src/app';
import { MemoryStore } from '../../../../server/src/store/memory';
import { openDatabase, type Db } from '../../../src/main/db/database';
import { GroupsRepo } from '../../../src/main/db/groups-repo';
import { HostsRepo } from '../../../src/main/db/hosts-repo';
import { ItemStore } from '../../../src/main/db/item-store';
import { SnippetsRepo } from '../../../src/main/db/snippets-repo';
import { SyncEngine } from '../../../src/main/sync/engine';
import { TeamService } from '../../../src/main/sync/teams';
import { LocalVault } from '../../../src/main/vault/local-vault';

const KDF = { ops: 2, mem: 64 * 1024 * 1024 };
let serverUrl: string;
let serverStore: MemoryStore;
let close: () => Promise<void>;
const dirs: string[] = [];
const opened: Device[] = [];

interface Device {
  db: Db;
  vault: LocalVault;
  hosts: HostsRepo;
  snippets: SnippetsRepo;
  sync: SyncEngine;
  teams: TeamService;
  teamEvents: number;
}

function device(name: string): Device {
  const dir = mkdtempSync(join(tmpdir(), `chh-teams-${name}-`));
  dirs.push(dir);
  const key = randomKey();
  const db = openDatabase(join(dir, 'db'), key);
  const vault = LocalVault.openOrCreate(db, key);
  const store = new ItemStore(db, `dev-${name}`, vault.id);
  store.setWritePolicy((id) => vault.canWrite(id));
  const groups = new GroupsRepo(store);
  const d = { db, vault, hosts: new HostsRepo(store, vault, groups), snippets: new SnippetsRepo(store), teamEvents: 0 } as Device;
  opened.push(d);
  const onTeamsChanged = () => d.teamEvents++;
  d.sync = new SyncEngine({ db, store, vault, kdfCost: KDF, deviceName: name, onStatus: () => undefined, onRemoteChange: () => undefined, onTeamsChanged });
  d.teams = new TeamService({ sync: d.sync, vault, store, onRemoteChange: () => undefined, onTeamsChanged });
  return d;
}

const labels = (d: Device) => d.hosts.list({}).items.map((h) => h.label).sort();
const host = (d: Device, label: string) => d.hosts.list({}).items.find((h) => h.label === label)!;

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

describe('team vaults between two accounts', () => {
  const alice = { email: `alice-${Date.now()}@example.com`, password: 'alice password 1' };
  const bob = { email: `bob-${Date.now()}@example.com`, password: 'bob password 1' };
  let a: Device;
  let b: Device;
  let teamId: string;
  let teamVault: string;

  it('creates a team whose name and items the server never sees', async () => {
    a = device('alice');
    b = device('bob');
    await a.sync.register({ serverUrl, ...alice });
    await b.sync.register({ serverUrl, ...bob });
    const t = await a.teams.create('Platform Ops');
    expect(t).toMatchObject({ name: 'Platform Ops', role: 'owner', status: 'confirmed', memberCount: 1 });
    teamId = t.id;
    teamVault = t.vaultId;
    a.hosts.create({ label: 'shared-db', address: 'db.shared', password: 'team-secret', vaultId: teamVault });
    a.hosts.create({ label: 'alice-only', address: 'alice.example', password: 'alice-secret' });
    await a.sync.syncNow();
    const dump = JSON.stringify([...serverStore.items.values(), ...serverStore.teams.values()]);
    for (const s of ['Platform Ops', 'shared-db', 'db.shared', 'team-secret']) expect(dump).not.toContain(s);
    expect(host(a, 'shared-db').vaultId).toBe(teamVault);
    expect(a.hosts.getPassword(host(a, 'shared-db').id)).toBe('team-secret');
  });

  it('invites, accepts and confirms with a fingerprint check', async () => {
    await a.teams.invite(teamId, bob.email, 'editor');
    const mine = await b.teams.list();
    expect(mine.invites).toEqual([expect.objectContaining({ teamId, invitedBy: alice.email, role: 'editor' })]);
    await b.teams.acceptInvite(mine.invites[0]!.id);
    expect((await b.teams.list()).teams).toEqual([expect.objectContaining({ id: teamId, status: 'accepted', name: null })]);

    const { members } = await a.teams.members(teamId);
    const m = members.find((x) => x.email === bob.email)!;
    expect(m.fingerprint).toBe(mine.myFingerprint);
    await expect(a.teams.confirm(teamId, m.userId, '0000 0000 0000 0000 0000 0000 0000 0000')).rejects.toMatchObject({ code: 'fingerprint_mismatch' });
    await a.teams.confirm(teamId, m.userId, m.fingerprint);

    await b.sync.syncNow();
    expect((await b.teams.list()).teams[0]).toMatchObject({ name: 'Platform Ops', status: 'confirmed', role: 'editor' });
    expect(labels(b)).toEqual(['shared-db']);
    expect(b.hosts.getPassword(host(b, 'shared-db').id)).toBe('team-secret');
  });

  it('syncs edits both ways and moves items into the team', async () => {
    b.hosts.update(host(b, 'shared-db').id, { notes: 'edited by bob', password: 'rotated-by-bob' });
    b.snippets.create({ label: 'restart', script: 'systemctl restart app', vaultId: teamVault });
    await b.sync.syncNow();
    await a.sync.syncNow();
    expect(host(a, 'shared-db').notes).toBe('edited by bob');
    expect(a.hosts.getPassword(host(a, 'shared-db').id)).toBe('rotated-by-bob');
    expect(a.snippets.list().map((s) => s.label)).toContain('restart');

    expect(a.teams.move('host', [host(a, 'alice-only').id], teamVault)).toEqual({ moved: 1 });
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(labels(b)).toEqual(['alice-only', 'shared-db']);
    expect(b.hosts.getPassword(host(b, 'alice-only').id)).toBe('alice-secret');
  });

  it('a second device of the same account sees each item once after moves', async () => {
    const id = host(a, 'alice-only').id;
    // Move it back to the personal vault: the team copy becomes a tombstone for everyone else.
    a.teams.move('host', [id], a.vault.id);
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(labels(b)).toEqual(['shared-db']);

    const a2 = device('alice2');
    await a2.sync.login({ serverUrl, ...alice });
    await a2.sync.syncNow();
    expect(labels(a2)).toEqual(['alice-only', 'shared-db']);
    expect(host(a2, 'alice-only').vaultId).toBe(a2.vault.id);
    expect(a2.hosts.getPassword(host(a2, 'alice-only').id)).toBe('alice-secret');
  });

  it('viewers are read-only, locally and on the server', async () => {
    const bobId = (await a.teams.members(teamId)).members.find((m) => m.email === bob.email)!.userId;
    await a.teams.setRole(teamId, bobId, 'viewer');
    await b.sync.syncNow();
    expect(() => b.hosts.update(host(b, 'shared-db').id, { notes: 'nope' })).toThrow(expect.objectContaining({ code: 'read_only' }));
    expect(b.teams.vaults().find((v) => v.id === teamVault)).toMatchObject({ writable: false, role: 'viewer' });
    await a.teams.setRole(teamId, bobId, 'editor');
    await b.sync.syncNow();
  });

  it('records client-reported events in the audit log', async () => {
    const id = host(b, 'shared-db').id;
    b.sync.reportAudit(teamVault, 'host.connected', id);
    b.sync.reportAudit(b.vault.id, 'host.connected', id); // personal vault: never reported
    await b.sync.syncNow();
    const { entries } = await a.teams.audit(teamId);
    const connected = entries.find((e) => e.action === 'host.connected')!;
    expect(connected).toMatchObject({ actorEmail: bob.email, clientReported: true, itemLabel: 'shared-db' });
    expect(entries.filter((e) => e.action === 'host.connected')).toHaveLength(1);
    expect(entries.some((e) => e.action === 'item.written')).toBe(true);
  });

  it('removing a member rotates the key and wipes their local copy', async () => {
    const bobId = (await a.teams.members(teamId)).members.find((m) => m.email === bob.email)!.userId;
    const before = serverStore.vaults.get(teamVault)!.keyGen;
    await a.teams.remove(teamId, bobId);
    expect(serverStore.vaults.get(teamVault)!.keyGen).toBe(before + 1);
    expect(a.vault.teamVault(teamVault)!.keyGen).toBe(before + 1);
    // Alice still reads everything under the new key, including re-sealed secrets.
    await a.sync.syncNow();
    expect(a.hosts.getPassword(host(a, 'shared-db').id)).toBe('rotated-by-bob');

    await b.sync.syncNow();
    expect(labels(b)).toEqual([]);
    expect(b.vault.teamVaults()).toEqual([]);
    expect((await b.teams.list()).teams).toEqual([]);

    // Alice's other device picks up the new key on its next sync.
    const a3 = device('alice3');
    await a3.sync.login({ serverUrl, ...alice });
    await a3.sync.syncNow();
    expect(a3.hosts.getPassword(host(a3, 'shared-db').id)).toBe('rotated-by-bob');
  });

  it('signing out removes team data from the device', async () => {
    await a.sync.logout(true);
    expect(a.vault.teamVaults()).toEqual([]);
    expect(labels(a)).toEqual(['alice-only']);
  });
});
