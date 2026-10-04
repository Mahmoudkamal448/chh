import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fillSnippet, snippetVariables } from '@cy-ssh/shared';
import { randomKey } from '@cy-ssh/vault-crypto';
import { openDatabase, type Db } from '../../../src/main/db/database';
import { ForwardsRepo } from '../../../src/main/db/forwards-repo';
import { GroupsRepo } from '../../../src/main/db/groups-repo';
import { HistoryRepo } from '../../../src/main/db/history-repo';
import { HostsRepo } from '../../../src/main/db/hosts-repo';
import { ItemStore } from '../../../src/main/db/item-store';
import { SnippetsRepo } from '../../../src/main/db/snippets-repo';
import { LocalVault } from '../../../src/main/vault/local-vault';

let dir: string;
let db: Db;
let hosts: HostsRepo;
let forwards: ForwardsRepo;
let snippets: SnippetsRepo;
let history: HistoryRepo;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cy-p3-'));
  const k = randomKey();
  db = openDatabase(join(dir, 'db'), k);
  const vault = LocalVault.openOrCreate(db, k);
  const store = new ItemStore(db, 'dev1', vault.id);
  hosts = new HostsRepo(store, vault, new GroupsRepo(store));
  forwards = new ForwardsRepo(store);
  snippets = new SnippetsRepo(store);
  history = new HistoryRepo(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ForwardsRepo', () => {
  it('validates rules, normalizes dynamic forwards and keeps fields on partial updates', () => {
    const h = hosts.create({ label: 'h', address: 'h' });
    expect(() => forwards.create({ label: 'x', hostId: h.id, kind: 'local', bindPort: 8080 })).toThrow(); // no destination
    expect(() => forwards.create({ label: 'x', hostId: 'nope', kind: 'dynamic', bindPort: 1080 })).toThrow();
    const f = forwards.create({ label: 'db', hostId: h.id, kind: 'local', bindPort: 5432, destHost: 'db', destPort: 5432 });
    expect(f.bindHost).toBe('127.0.0.1');
    const renamed = forwards.update(f.id, { label: 'postgres' });
    expect(renamed).toMatchObject({ label: 'postgres', bindPort: 5432, destHost: 'db', autoStart: false });
    const dyn = forwards.update(f.id, { kind: 'dynamic' });
    expect(dyn).toMatchObject({ destHost: null, destPort: null });
    expect(forwards.idsForHosts([h.id])).toEqual([f.id]);
  });
});

describe('SnippetsRepo + variables', () => {
  it('stores snippets and fills placeholders', () => {
    const s = snippets.create({ label: 'tail', script: 'tail -n {{lines}} {{ file }} # {{lines}}', tags: ['logs', 'logs'] });
    expect(s.tags).toEqual(['logs']);
    expect(snippetVariables(s.script)).toEqual(['lines', 'file']);
    expect(fillSnippet(s.script, { lines: '50', file: '/var/log/syslog' })).toBe('tail -n 50 /var/log/syslog # 50');
    expect(fillSnippet('{{missing}}', {})).toBe('{{missing}}');
    expect(snippets.update(s.id, { description: 'd' }).script).toBe(s.script);
  });
});

describe('HistoryRepo', () => {
  it('records, dedupes consecutive repeats, searches newest-first, and clears', () => {
    history.add('h1', 'web', 'ls -la');
    history.add('h1', 'web', 'ls -la');
    history.add('h1', 'web', 'cd /var/log');
    history.add(null, 'bash', 'git status');
    history.add(null, 'bash', '   ');
    expect(history.search(undefined, undefined, 10).map((h) => h.command)).toEqual(['git status', 'cd /var/log', 'ls -la']);
    expect(history.search('var log', undefined, 10).map((h) => h.command)).toEqual(['cd /var/log']);
    expect(history.search('%', undefined, 10)).toEqual([]);
    expect(history.search(undefined, 'h1', 10)).toHaveLength(2);
    history.remove([history.search('git', undefined, 1)[0]!.id]);
    expect(history.search('git', undefined, 10)).toEqual([]);
    history.clear();
    expect(history.search(undefined, undefined, 10)).toEqual([]);
  });
});
