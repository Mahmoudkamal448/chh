import { describe, expect, it } from 'vitest';
import { planAuth, type AuthInputs } from '../../../src/main/auth-plan';

const base: Omit<AuthInputs, 'method'> = {
  settings: { username: 'deploy', keyId: 'host-key', useAgent: true, tryDefaultKeys: true },
  identity: { username: 'ops', password: 'identity-pw', keyId: 'identity-key' },
  hostPassword: 'host-pw',
};
const plan = (method: AuthInputs['method'], over: Partial<AuthInputs> = {}) => planAuth({ ...base, method, ...over });

describe('planAuth', () => {
  it('"auto" keeps the original behaviour: everything configured', () => {
    expect(plan('auto')).toEqual({
      username: 'deploy',
      password: 'host-pw',
      keyId: 'host-key',
      useCertificate: true,
      usePlainKey: true,
      requireCertificate: false,
      useAgent: true,
      tryDefaultKeys: true,
    });
    // Falls back to the identity for what the host doesn't set.
    expect(plan('auto', { settings: { ...base.settings, username: '', keyId: null }, hostPassword: null })).toMatchObject({
      username: 'ops',
      password: 'identity-pw',
      keyId: 'identity-key',
    });
  });

  it('"password" never offers a key, the agent or default keys', () => {
    expect(plan('password')).toMatchObject({ password: 'host-pw', keyId: null, useAgent: false, tryDefaultKeys: false, useCertificate: false });
  });

  it('"key" uses only the key, without its certificate', () => {
    expect(plan('key')).toMatchObject({ keyId: 'host-key', usePlainKey: true, useCertificate: false, password: null, useAgent: false, tryDefaultKeys: false });
  });

  it('"certificate" requires the key\'s certificate and doesn\'t fall back to the plain key', () => {
    expect(plan('certificate')).toMatchObject({ keyId: 'host-key', useCertificate: true, usePlainKey: false, requireCertificate: true, password: null, useAgent: false });
  });

  it('"agent" uses only the SSH agent, even if the agent is off in "auto" settings', () => {
    expect(plan('agent', { settings: { ...base.settings, useAgent: false } })).toMatchObject({ useAgent: true, keyId: null, password: null, tryDefaultKeys: false });
  });

  it('"identity" takes everything from the identity, not the host', () => {
    expect(plan('identity', { settings: { ...base.settings, username: '' } })).toMatchObject({
      username: 'ops',
      password: 'identity-pw',
      keyId: 'identity-key',
      useCertificate: true,
      usePlainKey: true,
      useAgent: false,
      tryDefaultKeys: false,
    });
    expect(plan('identity').username).toBe('deploy'); // a username on the host still wins
  });

  it('"ask" stores nothing: the password (and a missing username) is asked when connecting', () => {
    expect(plan('ask')).toMatchObject({ username: 'deploy', password: null, keyId: null, useAgent: false, tryDefaultKeys: false });
    expect(plan('ask', { settings: { ...base.settings, username: '' } }).username).toBe('');
  });
});
