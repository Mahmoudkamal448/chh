import { describe, expect, it } from 'vitest';
import { allMethods, channel, contract, events } from '@cy-ssh/shared';
import { REDACT_PATHS } from '../../src/main/log';

describe('IPC contract', () => {
  it('has unique channels for every method', () => {
    const chans = allMethods().map(([ns, m]) => channel(ns, m));
    expect(new Set(chans).size).toBe(chans.length);
    expect(chans).toContain('cy:hosts.list');
  });

  it('validates inputs strictly', () => {
    expect(contract.hosts.create.input.safeParse({ label: 'x', address: 'x' }).success).toBe(true);
    expect(contract.hosts.create.input.safeParse({ label: 'x' }).success).toBe(false);
    expect(contract.sessions.openSsh.input.safeParse({ hostId: 'a', cols: 0, rows: 10 }).success).toBe(false);
    expect(contract.app.openExternal.input.safeParse({ url: 'https://example.com' }).success).toBe(true);
    expect(contract.app.openExternal.input.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
    expect(contract.app.openExternal.input.safeParse({ url: 'javascript:alert(1)' }).success).toBe(false);
  });

  it('never sends secrets to the renderer in Host objects', () => {
    const shape = contract.hosts.get.output.shape as Record<string, unknown>;
    expect('password' in shape).toBe(false);
    expect('hasPassword' in shape).toBe(true);
  });

  it('declares every event with a schema', () => {
    for (const schema of Object.values(events)) expect(typeof schema.safeParse).toBe('function');
  });

  it('redacts secret-bearing fields in logs', () => {
    for (const p of ['password', '*.password', '*.privateKey', '*.passphrase', 'config.password']) expect(REDACT_PATHS).toContain(p);
  });
});
