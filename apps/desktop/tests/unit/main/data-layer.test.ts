import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomKey } from '@chh/vault-crypto';
import { openDatabase, type Db } from '../../../src/main/db/database';
import { GroupsRepo } from '../../../src/main/db/groups-repo';
import { HostsRepo } from '../../../src/main/db/hosts-repo';
import { ItemStore, uuidv7 } from '../../../src/main/db/item-store';
import { KnownHostsRepo } from '../../../src/main/db/known-hosts-repo';
import { SettingsRepo } from '../../../src/main/db/settings-repo';
import { LocalVault } from '../../../src/main/vault/local-vault';

let dir: string;
let dbPath: string;
let key: Buffer;
let db: Db;
let vault: LocalVault;
let store: ItemStore;
let groups: GroupsRepo;
let hosts: HostsRepo;

function open() {
  db = openDatabase(dbPath, key);
  vault = LocalVault.openOrCreate(db, key);
  store = new ItemStore(db, 'device-1', vault.id);
  groups = new GroupsRepo(store);
  hosts = new HostsRepo(store, vault, groups);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chh-test-'));
  dbPath = join(dir, 'test.db');
  key = randomKey();
  open();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('encrypted database', () => {
  it('stores nothing in plaintext on disk', () => {
    hosts.create({ label: 'very-secret-label', address: 'db.internal.example', password: 'hunter2-password' });
    db.pragma('wal_checkpoint(TRUNCATE)');
    const raw = readFileSync(dbPath);
    expect(raw.subarray(0, 16).toString('latin1')).not.toContain('SQLite format');
    expect(raw.includes(Buffer.from('very-secret-label'))).toBe(false);
    expect(raw.includes(Buffer.from('hunter2-password'))).toBe(false);
  });

  it('refuses to open with the wrong key', () => {
    db.close();
    expect(() => openDatabase(dbPath, randomKey())).toThrow();
    open();
  });

  it('reopens with the right key and keeps data', () => {
    const h = hosts.create({ label: 'a', address: 'a.example', password: 'pw' });
    db.close();
    open();
    expect(hosts.get(h.id).label).toBe('a');
    expect(hosts.getPassword(h.id)).toBe('pw');
  });
});

describe('HostsRepo', () => {
  it('never exposes the password, only hasPassword', () => {
    const h = hosts.create({ label: 'web', address: 'web.example', password: 's3cret' });
    expect(h.hasPassword).toBe(true);
    expect(JSON.stringify(h)).not.toContain('s3cret');
    expect('password' in h).toBe(false);
    expect(hosts.getPassword(h.id)).toBe('s3cret');
  });

  it('seals passwords bound to their item (ciphertext cannot be moved)', () => {
    const a = hosts.create({ label: 'a', address: 'a', password: 'pa' });
    const b = hosts.create({ label: 'b', address: 'b' });
    const sealed = hosts.getFields(a.id).password;
    store.update(b.id, 'host', { password: sealed });
    expect(() => hosts.getPassword(b.id)).toThrow();
  });

  it('updates, clears passwords, and leaves them unchanged when undefined', () => {
    const h = hosts.create({ label: 'x', address: 'x', password: 'one' });
    hosts.update(h.id, { label: 'y' });
    expect(hosts.getPassword(h.id)).toBe('one');
    hosts.update(h.id, { password: 'two' });
    expect(hosts.getPassword(h.id)).toBe('two');
    hosts.update(h.id, { password: null });
    expect(hosts.getPassword(h.id)).toBeNull();
    expect(hosts.get(h.id).label).toBe('y');
  });

  it('duplicates including a re-sealed password', () => {
    const h = hosts.create({ label: 'x', address: 'x', password: 'pw', tags: ['a'] });
    const d = hosts.duplicate(h.id);
    expect(d.id).not.toBe(h.id);
    expect(d.label).toBe('x (copy)');
    expect(hosts.getPassword(d.id)).toBe('pw');
  });

  it('searches label, address, username and tags; filters favorites, tags, groups', () => {
    const g = groups.create({ label: 'prod' });
    const sub = groups.create({ label: 'eu', parentId: g.id });
    hosts.create({ label: 'web-1', address: '10.0.0.1', tags: ['nginx'], groupId: sub.id });
    hosts.create({ label: 'db-1', address: 'db.example.com', settings: { username: 'postgres' }, favorite: true, groupId: g.id });
    hosts.create({ label: 'misc', address: 'misc.local' });

    expect(hosts.list({ query: 'web' }).items.map((h) => h.label)).toEqual(['web-1']);
    expect(hosts.list({ query: 'example' }).items.map((h) => h.label)).toEqual(['db-1']);
    expect(hosts.list({ query: 'postgres' }).items.map((h) => h.label)).toEqual(['db-1']);
    expect(hosts.list({ query: 'ngi' }).items.map((h) => h.label)).toEqual(['web-1']);
    expect(hosts.list({ query: '1 web' }).items.map((h) => h.label)).toEqual(['web-1']);
    expect(hosts.list({ query: '%' }).items).toHaveLength(0);
    expect(hosts.list({ favoritesOnly: true }).items.map((h) => h.label)).toEqual(['db-1']);
    expect(hosts.list({ tag: 'nginx' }).items.map((h) => h.label)).toEqual(['web-1']);
    expect(hosts.list({ groupId: g.id }).items.map((h) => h.label).sort()).toEqual(['db-1', 'web-1']);
    expect(hosts.list({ groupId: g.id, includeSubgroups: false }).items.map((h) => h.label)).toEqual(['db-1']);
    expect(hosts.list({ groupId: null }).items.map((h) => h.label)).toEqual(['misc']);
    expect(hosts.tags()).toEqual([{ tag: 'nginx', count: 1 }]);
  });

  it('lists favorites first, then alphabetically', () => {
    hosts.create({ label: 'b', address: 'b' });
    hosts.create({ label: 'A', address: 'a' });
    hosts.create({ label: 'z', address: 'z', favorite: true });
    expect(hosts.list({}).items.map((h) => h.label)).toEqual(['z', 'A', 'b']);
  });

  it('soft-deletes so the deletion can sync later', () => {
    const h = hosts.create({ label: 'x', address: 'x' });
    hosts.remove([h.id]);
    expect(hosts.list({}).total).toBe(0);
    const row = db.prepare('SELECT deleted, dirty, fields FROM items WHERE id = ?').get(h.id) as {
      deleted: number;
      dirty: number;
      fields: string;
    };
    expect(row).toMatchObject({ deleted: 1, dirty: 1 });
    expect(JSON.parse(row.fields)).toEqual({ _deleted: true });
  });

  it('rejects invalid input', () => {
    expect(() => hosts.create({ label: '', address: 'x' })).toThrow();
    expect(() => hosts.create({ label: 'x', address: 'has space' })).toThrow();
    expect(() => hosts.create({ label: 'x', address: 'x', groupId: 'missing' })).toThrow();
  });

  it('handles 10k hosts quickly', () => {
    hosts.seed(10_000);
    const t0 = performance.now();
    const all = hosts.list({});
    const search = hosts.list({ query: 'seed-0999' });
    const elapsed = performance.now() - t0;
    expect(all.total).toBe(10_000);
    expect(search.items.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1500);
  });
});

describe('ItemStore sync metadata', () => {
  it('stamps per-field clocks and bumps the version vector only on real changes', () => {
    const h = hosts.create({ label: 'x', address: 'x' });
    const read = () =>
      db.prepare('SELECT clocks, vv FROM items WHERE id = ?').get(h.id) as { clocks: string; vv: string };
    const before = read();
    expect(JSON.parse(before.vv)).toEqual({ 'device-1': 1 });
    hosts.update(h.id, { label: 'x' }); // no-op
    expect(read().vv).toBe(before.vv);
    hosts.update(h.id, { label: 'y' });
    const after = read();
    expect(JSON.parse(after.vv)).toEqual({ 'device-1': 2 });
    expect(JSON.parse(after.clocks).label > JSON.parse(before.clocks).label).toBe(true);
    expect(JSON.parse(after.clocks).address).toBe(JSON.parse(before.clocks).address);
  });

  it('generates time-ordered UUIDv7 ids', () => {
    const a = uuidv7(1000);
    const b = uuidv7(2000);
    expect(a < b).toBe(true);
    expect(a[14]).toBe('7');
  });
});

describe('GroupsRepo', () => {
  it('prevents cycles and moves children up on delete', () => {
    const a = groups.create({ label: 'a' });
    const b = groups.create({ label: 'b', parentId: a.id });
    const c = groups.create({ label: 'c', parentId: b.id });
    expect(() => groups.update(a.id, { parentId: c.id })).toThrow();
    expect(() => groups.update(a.id, { parentId: a.id })).toThrow();
    const h = hosts.create({ label: 'h', address: 'h', groupId: b.id });
    groups.remove(b.id);
    expect(groups.list().find((g) => g.id === c.id)?.parentId).toBe(a.id);
    expect(hosts.get(h.id).groupId).toBe(a.id);
  });
});

describe('KnownHostsRepo', () => {
  it('detects unknown, match, changed and new-type keys', () => {
    const kh = new KnownHostsRepo(store);
    expect(kh.check('h', 'ssh-ed25519', 'AAA').kind).toBe('unknown');
    kh.save({ hostPattern: 'h', keyType: 'ssh-ed25519', fingerprint: 'SHA256:a', publicKey: 'AAA' });
    expect(kh.check('h', 'ssh-ed25519', 'AAA').kind).toBe('match');
    expect(kh.check('h', 'ssh-ed25519', 'BBB').kind).toBe('changed');
    expect(kh.check('h', 'rsa-sha2-512', 'CCC').kind).toBe('new-type');
    expect(kh.check('[h]:2222', 'ssh-ed25519', 'AAA').kind).toBe('unknown');
    kh.save({ hostPattern: 'h', keyType: 'ssh-ed25519', fingerprint: 'SHA256:b', publicKey: 'BBB' });
    expect(kh.check('h', 'ssh-ed25519', 'BBB').kind).toBe('match');
    expect(kh.check('h', 'ssh-ed25519', 'AAA').kind).toBe('changed');
  });
});

describe('SettingsRepo', () => {
  it('merges patches over defaults and validates', () => {
    const s = new SettingsRepo(db);
    expect(s.getApp().uiTheme).toBe('system');
    s.setApp({ uiTheme: 'dark', keymap: { 'tab.close': 'Ctrl+Q' } });
    expect(s.getApp()).toMatchObject({ uiTheme: 'dark', keymap: { 'tab.close': 'Ctrl+Q' } });
    expect(() => s.setApp({ uiTheme: 'neon' as never })).toThrow();
  });
});
