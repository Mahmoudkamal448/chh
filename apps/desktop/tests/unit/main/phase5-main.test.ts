import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomKey } from '@chh/vault-crypto';
import { AiProvider, parseSuggestions } from '../../../src/main/ai';
import { CloudImporter } from '../../../src/main/cloud/import';
import { openDatabase, type Db } from '../../../src/main/db/database';
import { GroupsRepo } from '../../../src/main/db/groups-repo';
import { HistoryRepo } from '../../../src/main/db/history-repo';
import { HostsRepo } from '../../../src/main/db/hosts-repo';
import { ItemStore } from '../../../src/main/db/item-store';
import { SettingsRepo } from '../../../src/main/db/settings-repo';
import { LocalVault } from '../../../src/main/vault/local-vault';

let dir: string;
let db: Db;
let vault: LocalVault;
let settings: SettingsRepo;
let hosts: HostsRepo;
let groups: GroupsRepo;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cy-p5-'));
  const k = randomKey();
  db = openDatabase(join(dir, 'db'), k);
  vault = LocalVault.openOrCreate(db, k);
  const store = new ItemStore(db, 'dev', vault.id);
  groups = new GroupsRepo(store);
  hosts = new HostsRepo(store, vault, groups);
  settings = new SettingsRepo(db);
});

function cleanupDb() {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

async function fakeServer(handler: (req: IncomingMessage, body: string) => { status?: number; body: string; type?: string }): Promise<{ url: string; server: Server; requests: Array<{ url: string; body: string; auth?: string }> }> {
  const requests: Array<{ url: string; body: string; auth?: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push({ url: req.url ?? '', body, auth: req.headers.authorization });
      const r = handler(req, body);
      res.writeHead(r.status ?? 200, { 'content-type': r.type ?? 'application/json' });
      res.end(r.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, requests };
}

describe('history suggestions', () => {
  it('suggests longer commands with the typed prefix, same host first, case-sensitive', () => {
    const h = new HistoryRepo(db);
    h.add('h1', 'web', 'git status');
    h.add('h2', 'db', 'git stash pop');
    h.add('h2', 'db', 'git stash pop');
    h.add('h2', 'db', 'ls');
    h.add('h2', 'db', 'git stash pop');
    h.add('h1', 'web', 'GIT ignored');
    expect(h.suggest('git st', 'h1', 5)).toEqual(['git status', 'git stash pop']);
    expect(h.suggest('git st', 'h2', 5)).toEqual(['git stash pop', 'git status']);
    expect(h.suggest('git status', 'h1', 5)).toEqual([]);
    expect(h.suggest('  ', null, 5)).toEqual([]);
    cleanupDb();
  });
});

describe('AI provider', () => {
  it('is off by default, stores the key sealed, sends minimal context, and parses replies', async () => {
    const fake = await fakeServer(() => ({
      body: JSON.stringify({ choices: [{ message: { content: '```bash\n1. tar -czf backup.tgz /etc\n- tar -tzf backup.tgz\n```' } }] }),
    }));
    const ai = new AiProvider(settings, vault);
    await expect(ai.suggest({ line: 'tar', os: 'ubuntu', recent: ['ls'] })).rejects.toMatchObject({ messageKey: 'suggest.error.aiOff' });
    settings.setApp({ ai: { enabled: true, endpoint: `${fake.url}/v1`, model: 'm', sendHistory: false } });
    ai.setKey('sk-test-123');
    expect(settings.getRaw('ai_key')).not.toContain('sk-test-123');
    expect(ai.hasKey()).toBe(true);
    const out = await ai.suggest({ line: 'tar', os: 'ubuntu', recent: ['secret-cmd'] });
    expect(out).toEqual(['tar -czf backup.tgz /etc', 'tar -tzf backup.tgz']);
    expect(fake.requests[0]!.url).toBe('/v1/chat/completions');
    expect(fake.requests[0]!.auth).toBe('Bearer sk-test-123');
    const sent = fake.requests[0]!.body;
    expect(sent).toContain('ubuntu');
    expect(sent).not.toContain('secret-cmd'); // history only when allowed
    settings.setApp({ ai: { enabled: true, endpoint: 'http://evil.example.com/v1', model: 'm', sendHistory: false } });
    await expect(ai.suggest({ line: 'x', os: null, recent: [] })).rejects.toMatchObject({ messageKey: 'suggest.error.aiUrl' });
    fake.server.close();
    cleanupDb();
  });

  it('cleans model output', () => {
    expect(parseSuggestions('`ls -la`\n\n2) du -sh *\n$ df -h\nfoo\nbar')).toEqual(['ls -la', 'du -sh *', 'df -h']);
  });
});

describe('cloud import', () => {
  let doApi: Awaited<ReturnType<typeof fakeServer>>;
  let ec2: Awaited<ReturnType<typeof fakeServer>>;
  let providers: typeof import('../../../src/main/cloud/providers');

  beforeAll(async () => {
    doApi = await fakeServer((req) => {
      if (req.headers.authorization !== 'Bearer good') return { status: 401, body: '{}' };
      const page = new URL(req.url!, 'http://x').searchParams.get('page');
      return {
        body: JSON.stringify(
          page === '1'
            ? {
                droplets: [{ id: 1, name: 'web-1', region: { slug: 'fra1' }, tags: ['prod'], image: { distribution: 'Ubuntu' }, networks: { v4: [{ ip_address: '203.0.113.5', type: 'public' }, { ip_address: '10.0.0.5', type: 'private' }] } }],
                links: { pages: { next: 'page2' } },
              }
            : { droplets: [{ id: 2, name: 'db-1', region: { slug: 'fra1' }, image: { distribution: 'Debian' }, networks: { v4: [{ ip_address: '10.0.0.6', type: 'private' }] } }], links: {} },
        ),
      };
    });
    ec2 = await fakeServer(() => ({
      type: 'text/xml',
      body: `<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>r</requestId><reservationSet><item><reservationId>r-1</reservationId><instancesSet><item>
        <instanceId>i-0abc</instanceId><instanceType>t3.micro</instanceType><platformDetails>Linux/UNIX</platformDetails>
        <privateIpAddress>172.31.0.10</privateIpAddress><ipAddress>198.51.100.7</ipAddress><dnsName>ec2-198-51-100-7.compute.amazonaws.com</dnsName>
        <tagSet><item><key>Name</key><value>bastion</value></item></tagSet></item></instancesSet></item></reservationSet></DescribeInstancesResponse>`,
    }));
    process.env.CHH_TEST = '1';
    process.env.CHH_DO_ENDPOINT = doApi.url;
    process.env.CHH_AWS_ENDPOINT = ec2.url;
    providers = await import('../../../src/main/cloud/providers');
  });

  afterAll(() => {
    doApi.server.close();
    ec2.server.close();
  });

  it('lists DigitalOcean droplets across pages and rejects bad tokens', async () => {
    const list = await providers.listDigitalOcean('good');
    expect(list.map((d) => [d.externalId, d.publicAddress, d.privateAddress, d.osHint, d.user])).toEqual([
      ['do:1', '203.0.113.5', '10.0.0.5', 'ubuntu', 'root'],
      ['do:2', null, '10.0.0.6', 'debian', 'root'],
    ]);
    await expect(providers.listDigitalOcean('bad')).rejects.toMatchObject({ status: 401 });
    cleanupDb();
  });

  it('lists EC2 instances and imports/updates hosts idempotently', async () => {
    const list = await providers.listAws({ regions: ['eu-central-1'], accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' });
    expect(list).toEqual([
      expect.objectContaining({ externalId: 'aws:i-0abc', name: 'bastion', publicAddress: '198.51.100.7', publicDns: 'ec2-198-51-100-7.compute.amazonaws.com', region: 'eu-central-1' }),
    ]);
    const importer = new CloudImporter(hosts, groups);
    const staged = importer.stage(list);
    expect(staged.candidates[0]!.exists).toBe(false);
    expect(importer.import({ token: staged.token, externalIds: ['aws:i-0abc'], groupLabel: 'AWS', username: 'ec2-user', address: 'dns' })).toEqual({ created: 1, updated: 0 });
    const h = hosts.list({}).items[0]!;
    expect(h).toMatchObject({ label: 'bastion', address: 'ec2-198-51-100-7.compute.amazonaws.com', settings: { username: 'ec2-user' }, tags: ['aws', 'eu-central-1', 't3.micro'] });
    expect(groups.list().map((g) => g.label)).toEqual(['AWS']);
    // Re-import with a new IP updates the same host, keeps the username, reuses the group.
    const again = importer.stage([{ ...list[0]!, publicAddress: '198.51.100.99' }]);
    expect(again.candidates[0]!.exists).toBe(true);
    expect(importer.import({ token: again.token, externalIds: ['aws:i-0abc'], groupLabel: 'AWS', address: 'public' })).toEqual({ created: 0, updated: 1 });
    expect(hosts.list({}).items).toHaveLength(1);
    expect(hosts.list({}).items[0]).toMatchObject({ address: '198.51.100.99', settings: { username: 'ec2-user' } });
    expect(groups.list()).toHaveLength(1);
    cleanupDb();
  });
});
