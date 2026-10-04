import { describe, expect, it } from 'vitest';
import {
  concreteAliases,
  importCandidates,
  matchPatternList,
  parseForward,
  parseSshConfig,
  resolveHost,
  tokenize,
  toAlias,
  writeSshConfig,
} from '../src';

const ctx = { home: '/home/me', localUser: 'me' };

const SAMPLE = `
# global defaults
ServerAliveInterval 30

Host web-*  !web-legacy
    User deploy
    IdentityFile ~/.ssh/deploy_ed25519

Host web-1
    HostName 10.0.0.11
    Port 2222
    User root            # overridden? no: first value wins, web-* came first
    LocalForward 8080 localhost:80
    LocalForward 0.0.0.0:9090 [::1]:9000

Host db db-replica
    HostName %h.internal.example
    User=postgres
    DynamicForward 1080
    RemoteForward 2222 localhost:22
    ProxyJump bastion
    ForwardAgent yes
    IdentityFile "~/.ssh/with space"
    IdentityFile %d/.ssh/id_%r

Host web-legacy
    HostName old.example.com
    KexAlgorithms +diffie-hellman-group1-sha1

Match exec "test -f /tmp/x"
    User nobody

Host *
    User fallback
    IdentityFile ~/.ssh/id_ed25519
`;

describe('tokenize', () => {
  it('handles =, quotes, comments and case', () => {
    expect(tokenize('  HostName = example.com')).toEqual({ keyword: 'hostname', args: ['example.com'] });
    expect(tokenize('IdentityFile "~/my key" other # c')).toEqual({ keyword: 'identityfile', args: ['~/my key', 'other'] });
    expect(tokenize('# comment')).toBeNull();
    expect(tokenize('')).toBeNull();
  });
});

describe('pattern matching', () => {
  it('supports wildcards, lists and negation', () => {
    expect(matchPatternList(['web-*', '!web-legacy'], 'web-1')).toBe(true);
    expect(matchPatternList(['web-*', '!web-legacy'], 'web-legacy')).toBe(false);
    expect(matchPatternList(['a,b?'], 'bx')).toBe(true);
    expect(matchPatternList(['*.EXAMPLE.com'], 'x.example.com')).toBe(true);
  });
});

describe('resolveHost (first value wins, multi-valued accumulate)', () => {
  const cfg = parseSshConfig(SAMPLE);

  it('lists concrete aliases only', () => {
    expect(concreteAliases(cfg)).toEqual(['web-1', 'db', 'db-replica', 'web-legacy']);
  });

  it('applies blocks in order', () => {
    const r = resolveHost(cfg, 'web-1');
    expect(r.options.get('user')).toEqual([['deploy']]);
    expect(r.options.get('hostname')).toEqual([['10.0.0.11']]);
    expect(r.options.get('identityfile')).toEqual([['~/.ssh/deploy_ed25519'], ['~/.ssh/id_ed25519']]);
    expect(r.options.get('serveraliveinterval')).toEqual([['30']]);
    expect(r.skippedMatches).toBe(1);
  });

  it('honours negation', () => {
    expect(resolveHost(cfg, 'web-legacy').options.get('user')).toEqual([['fallback']]);
  });
});

describe('importCandidates', () => {
  const byAlias = Object.fromEntries(importCandidates(parseSshConfig(SAMPLE), ctx).map((c) => [c.alias, c]));

  it('maps fields, expands tokens and parses forwards', () => {
    expect(byAlias['web-1']).toMatchObject({
      hostName: '10.0.0.11',
      port: 2222,
      user: 'deploy',
      identityFiles: ['/home/me/.ssh/deploy_ed25519', '/home/me/.ssh/id_ed25519'],
      forwards: [
        { kind: 'local', bindHost: '127.0.0.1', bindPort: 8080, destHost: 'localhost', destPort: 80 },
        { kind: 'local', bindHost: '0.0.0.0', bindPort: 9090, destHost: '::1', destPort: 9000 },
      ],
    });
    expect(byAlias['db-replica']).toMatchObject({
      hostName: 'db-replica.internal.example',
      user: 'postgres',
      proxyJump: 'bastion',
      forwardAgent: true,
      identityFiles: ['/home/me/.ssh/with space', '/home/me/.ssh/id_postgres', '/home/me/.ssh/id_ed25519'],
    });
    expect(byAlias.db!.forwards.map((f) => f.kind)).toEqual(['remote', 'dynamic']);
    expect(byAlias['web-legacy']!.unsupported).toEqual(['kexalgorithms']);
  });
});

describe('Include', () => {
  it('inlines included files (with globs resolved by the caller) and guards recursion', () => {
    const files: Record<string, string> = {
      '/home/me/.ssh/conf.d/a': 'Host inc-a\n  HostName a.example',
      '/home/me/.ssh/loop': 'Include loop',
    };
    const cfg = parseSshConfig('Include conf.d/*\nInclude loop\nHost top\n  HostName t', {
      file: '/home/me/.ssh/config',
      include: (p) => {
        if (p === 'conf.d/*') return [{ path: '/home/me/.ssh/conf.d/a', text: files['/home/me/.ssh/conf.d/a']! }];
        return [{ path: '/home/me/.ssh/loop', text: files['/home/me/.ssh/loop']! }];
      },
    });
    expect(concreteAliases(cfg)).toEqual(['inc-a', 'top']);
    expect(cfg.warnings.some((w) => /too deeply/.test(w.message))).toBe(true);
  });
});

describe('parseForward', () => {
  it('parses all forms and rejects bad ports and unix sockets', () => {
    expect(parseForward('local', ['localhost:5432', 'db:5432'])).toMatchObject({ bindHost: 'localhost', bindPort: 5432 });
    expect(parseForward('local', ['*:80', 'web:80'])).toMatchObject({ bindHost: '0.0.0.0' });
    expect(parseForward('local', ['8080:intranet:80'])).toMatchObject({ bindPort: 8080, destHost: 'intranet', destPort: 80 });
    expect(parseForward('dynamic', ['[::1]:1080'])).toMatchObject({ bindHost: '::1', bindPort: 1080 });
    expect(parseForward('local', ['70000', 'a:1'])).toBeNull();
    expect(parseForward('local', ['/tmp/sock', 'a:1'])).toBeNull();
  });
});

describe('writeSshConfig', () => {
  it('round-trips through the parser', () => {
    const text = writeSshConfig([
      { alias: 'My Server', hostName: 'srv.example', port: 2200, user: 'me', forwards: [{ kind: 'local', bindHost: '127.0.0.1', bindPort: 5432, destHost: 'db', destPort: 5432 }] },
      { alias: 'My Server', hostName: 'other.example', comment: 'duplicate label' },
      { alias: 'socks', hostName: 'h', forwards: [{ kind: 'dynamic', bindHost: '127.0.0.1', bindPort: 1080, destHost: null, destPort: null }] },
    ]);
    const c = importCandidates(parseSshConfig(text), ctx);
    expect(c.map((x) => x.alias)).toEqual(['My-Server', 'My-Server-2', 'socks']);
    expect(c[0]).toMatchObject({ hostName: 'srv.example', port: 2200, user: 'me' });
    expect(c[0]!.forwards[0]).toMatchObject({ kind: 'local', bindPort: 5432, destHost: 'db' });
    expect(c[2]!.forwards[0]!.kind).toBe('dynamic');
    expect(toAlias('  a b*c ')).toBe('a-b-c');
  });
});
