import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePrivateKey } from '@cy-ssh/key-formats';
import { randomKey } from '@cy-ssh/vault-crypto';
import { openDatabase, type Db } from '../../../src/main/db/database';
import { GroupsRepo } from '../../../src/main/db/groups-repo';
import { HostsRepo } from '../../../src/main/db/hosts-repo';
import { IdentitiesRepo } from '../../../src/main/db/identities-repo';
import { ItemStore } from '../../../src/main/db/item-store';
import { KeysRepo } from '../../../src/main/db/keys-repo';
import { KnownHostsRepo } from '../../../src/main/db/known-hosts-repo';
import { LocalVault } from '../../../src/main/vault/local-vault';

const FIX = join(__dirname, '../../../../../packages/key-formats/test/fixtures');
const fixture = (f: string) => readFileSync(join(FIX, f), 'utf8');

let dir: string;
let db: Db;
let keys: KeysRepo;
let identities: IdentitiesRepo;
let hosts: HostsRepo;
let groups: GroupsRepo;
let known: KnownHostsRepo;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cy-keychain-'));
  const k = randomKey();
  db = openDatabase(join(dir, 'db'), k);
  const vault = LocalVault.openOrCreate(db, k);
  const store = new ItemStore(db, 'dev1', vault.id);
  groups = new GroupsRepo(store);
  hosts = new HostsRepo(store, vault, groups);
  keys = new KeysRepo(store, vault);
  identities = new IdentitiesRepo(store, vault);
  known = new KnownHostsRepo(store);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('KeysRepo', () => {
  it('generates keys whose private part never leaves the repo unsealed', async () => {
    const k = keys.generate({ label: 'laptop', algorithm: 'ed25519', comment: 'me@laptop' });
    expect(k.publicKey).toMatch(/^ssh-ed25519 AAAA\S+ me@laptop$/);
    expect(JSON.stringify(k)).not.toContain('PRIVATE');
    const priv = keys.getPrivate(k.id);
    expect(priv).toContain('BEGIN OPENSSH PRIVATE KEY');
    expect((await parsePrivateKey(priv)).comment).toBe('me@laptop');
    const raw = db.prepare('SELECT fields FROM items WHERE id = ?').get(k.id) as { fields: string };
    expect(raw.fields).not.toContain('OPENSSH');
  });

  it('imports with passphrase flow and detects duplicates', async () => {
    expect((await keys.importText(fixture('openssh-ed25519-enc'))).status).toBe('passphrase_required');
    expect((await keys.importText(fixture('openssh-ed25519-enc'), undefined, 'nope')).status).toBe('bad_passphrase');
    const ok = await keys.importText(fixture('openssh-ed25519-enc'), undefined, 'test-pass');
    expect(ok.status).toBe('imported');
    if (ok.status !== 'imported') return;
    expect(ok.key.label).toBe('cy-test-ed25519');
    // The stored copy is decrypted (vault protects it) so connecting needs no passphrase.
    expect((await parsePrivateKey(keys.getPrivate(ok.key.id))).type).toBe('ssh-ed25519');
    expect((await keys.importText(fixture('openssh-ed25519-enc'), undefined, 'test-pass')).status).toBe('duplicate');
    // Same key in a different format is still a duplicate.
    expect((await keys.importText(fixture('openssh-ed25519'))).status).toBe('imported');
    expect((await keys.importText(fixture('ppk3-ed25519.ppk'))).status).toBe('duplicate');
  });

  it('imports PuTTY keys and exports re-encrypted OpenSSH', async () => {
    const res = await keys.importText(fixture('ppk2-rsa2048-enc.ppk'), 'putty', 'test-pass');
    if (res.status !== 'imported') throw new Error(res.status);
    expect(res.key).toMatchObject({ label: 'putty', origin: 'ppk2', bits: 2048 });
    const exported = await keys.exportPrivate(res.key.id, 'new-pass');
    await expect(parsePrivateKey(exported)).rejects.toThrow();
    expect((await parsePrivateKey(exported, 'new-pass')).bits).toBe(2048);
  });

  it('removing a key clears references from hosts, groups and identities', () => {
    const k = keys.generate({ label: 'k', algorithm: 'ecdsa', bits: 256 });
    const g = groups.create({ label: 'g', settings: { keyId: k.id } });
    const h = hosts.create({ label: 'h', address: 'h', settings: { keyId: k.id } });
    const i = identities.create({ label: 'i', keyId: k.id });
    expect(keys.usage(k.id).sort()).toEqual(['g', 'h', 'i']);
    keys.remove([k.id]);
    expect(keys.list()).toHaveLength(0);
    expect(hosts.get(h.id).settings.keyId).toBeUndefined();
    expect(groups.list().find((x) => x.id === g.id)!.settings.keyId).toBeUndefined();
    expect(identities.get(i.id).keyId).toBeNull();
  });
});

describe('IdentitiesRepo', () => {
  it('stores passwords sealed, exposes only hasPassword, and unlinks on delete', () => {
    const i = identities.create({ label: 'ops', username: 'deploy', password: 'pw' });
    expect(i).toMatchObject({ username: 'deploy', hasPassword: true });
    expect(JSON.stringify(i)).not.toContain('pw"');
    expect(identities.getSecrets(i.id)).toEqual({ username: 'deploy', password: 'pw', keyId: null });
    identities.update(i.id, { password: null });
    expect(identities.getSecrets(i.id)!.password).toBeNull();
    const h = hosts.create({ label: 'h', address: 'h', settings: { identityId: i.id } });
    identities.remove([i.id]);
    expect(hosts.get(h.id).settings.identityId).toBeUndefined();
  });

  it('rejects unknown keys', () => {
    expect(() => identities.create({ label: 'x', keyId: 'nope' })).toThrow();
  });
});

describe('KnownHostsRepo import', () => {
  it('imports plain and hashed entries and matches them on connect', () => {
    const blobOf = (pub: string) => pub.split(' ')[1]!;
    const hostKey = blobOf(fixture('kh-host.pub'));
    const rsaKey = blobOf(fixture('openssh-rsa2048.pub'));

    const r1 = known.importText(fixture('known_hosts'));
    expect(r1).toEqual({ imported: 2, skipped: 1 }); // @revoked line skipped
    expect(known.check('example.com', 'ssh-ed25519', hostKey).kind).toBe('match');
    expect(known.check('192.0.2.10', 'ssh-ed25519', hostKey).kind).toBe('match');
    expect(known.check('[git.example.com]:2222', 'ssh-rsa', rsaKey).kind).toBe('match');
    expect(known.check('example.com', 'ssh-ed25519', rsaKey).kind).toBe('changed');

    known.remove(known.list().map((k) => k.id));
    const r2 = known.importText(fixture('known_hosts_hashed'));
    expect(r2.imported).toBe(3);
    expect(known.check('example.com', 'ssh-ed25519', hostKey).kind).toBe('match');
    expect(known.check('other.example', 'ssh-ed25519', hostKey).kind).toBe('unknown');
    expect(known.importText(fixture('known_hosts_hashed'))).toEqual({ imported: 0, skipped: 3 });
  });

  it('lists and searches entries without exposing raw keys', () => {
    known.save({ hostPattern: 'a.example', keyType: 'ssh-ed25519', fingerprint: 'SHA256:aaa', publicKey: 'AAAA' });
    known.save({ hostPattern: 'b.example', keyType: 'ssh-ed25519', fingerprint: 'SHA256:bbb', publicKey: 'BBBB' });
    expect(known.list('b.ex').map((k) => k.hostPattern)).toEqual(['b.example']);
    expect(known.list('SHA256:aa').map((k) => k.hostPattern)).toEqual(['a.example']);
    expect('publicKey' in known.list()[0]!).toBe(false);
  });
});
