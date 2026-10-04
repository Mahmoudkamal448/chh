import { describe, expect, it } from 'vitest';
import {
  CryptoError,
  createAccountSecrets,
  decryptItem,
  deriveMasterKey,
  encryptItem,
  formatRecoveryKey,
  hashPasscode,
  verifyPasscode,
  newKdfParams,
  newRecoveryKey,
  openSealed,
  parseRecoveryKey,
  randomKey,
  rewrapAccountKey,
  sealTo,
  splitMasterKey,
  unwrapAccountKey,
  unwrapAccountKeyWithRecovery,
  unwrapPrivateKey,
  unwrapVaultKey,
  wrapAccount,
  wrapVaultKey,
} from '../src';

const FAST = { ops: 2, mem: 8 * 1024 * 1024 };

describe('password KDF', () => {
  it('is deterministic for the same salt and differs across salts/passwords', async () => {
    const p = newKdfParams(FAST);
    const a = await deriveMasterKey('correct horse', p);
    expect((await deriveMasterKey('correct horse', p)).equals(a)).toBe(true);
    expect((await deriveMasterKey('correct horse!', p)).equals(a)).toBe(false);
    expect((await deriveMasterKey('correct horse', newKdfParams(FAST))).equals(a)).toBe(false);
  });

  it('normalizes unicode so the same password works across keyboards', async () => {
    const p = newKdfParams(FAST);
    expect((await deriveMasterKey('café', p)).equals(await deriveMasterKey('café', p))).toBe(true);
  });

  it('separates auth key and KEK', async () => {
    const { authKey, kek } = splitMasterKey(await deriveMasterKey('pw', newKdfParams(FAST)));
    expect(authKey.equals(kek)).toBe(false);
  });
});

describe('account key hierarchy', () => {
  it('wraps and unwraps everything, bound to the email', async () => {
    const { kek } = splitMasterKey(await deriveMasterKey('pw', newKdfParams(FAST)));
    const secrets = createAccountSecrets();
    const recovery = newRecoveryKey();
    const blobs = wrapAccount(secrets, kek, recovery.key, 'Me@Example.com');
    expect(unwrapAccountKey(blobs.accountKeyWrapped, kek, 'me@example.com').equals(secrets.accountKey)).toBe(true);
    expect(() => unwrapAccountKey(blobs.accountKeyWrapped, kek, 'other@example.com')).toThrow(CryptoError);
    expect(unwrapAccountKeyWithRecovery(blobs.recoveryWrapped, parseRecoveryKey(recovery.text.toLowerCase()), 'me@example.com').equals(secrets.accountKey)).toBe(true);
    expect(unwrapPrivateKey(blobs.privateKeyWrapped, secrets.accountKey).equals(secrets.privateKey)).toBe(true);

    const vaultKey = randomKey();
    const w = wrapVaultKey(vaultKey, secrets.accountKey, 'vault-1');
    expect(unwrapVaultKey(w, secrets.accountKey, 'vault-1').equals(vaultKey)).toBe(true);
    expect(() => unwrapVaultKey(w, secrets.accountKey, 'vault-2')).toThrow(CryptoError);
  });

  it('password change only rewraps the account key', async () => {
    const secrets = createAccountSecrets();
    const { kek: newKek } = splitMasterKey(await deriveMasterKey('new pw', newKdfParams(FAST)));
    const blob = rewrapAccountKey(secrets.accountKey, newKek, 'a@b.c');
    expect(unwrapAccountKey(blob, newKek, 'a@b.c').equals(secrets.accountKey)).toBe(true);
  });

  it('recovery keys round-trip and reject typos', () => {
    const { key, text } = newRecoveryKey();
    expect(text).toMatch(/^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
    expect(parseRecoveryKey(text).equals(key)).toBe(true);
    expect(formatRecoveryKey(parseRecoveryKey(text))).toBe(text);
    expect(() => parseRecoveryKey(text.slice(0, -2))).toThrow(CryptoError);
  });

  it('sealed boxes open only with the right private key', () => {
    const a = createAccountSecrets();
    const b = createAccountSecrets();
    const sealed = sealTo(a.publicKey, Buffer.from('team key'));
    expect(openSealed(a.publicKey, a.privateKey, sealed).toString()).toBe('team key');
    expect(() => openSealed(b.publicKey, b.privateKey, sealed)).toThrow(CryptoError);
  });
});

describe('item envelopes', () => {
  it('round-trip, pad to 256-byte buckets, and bind to vault and item', () => {
    const k = randomKey();
    const payload = { type: 'host', fields: { label: 'web' }, clocks: {}, vv: { a: 1 } };
    const enc = encryptItem(payload, k, 'v1', 'i1');
    expect(decryptItem(enc, k, 'v1', 'i1')).toEqual(payload);
    expect(Buffer.from(enc.ciphertext, 'base64').length).toBe(256 + 16);
    expect(Buffer.from(encryptItem({ x: 'y'.repeat(300) }, k, 'v1', 'i1').ciphertext, 'base64').length).toBe(512 + 16);
    expect(() => decryptItem(enc, k, 'v1', 'i2')).toThrow(CryptoError);
    expect(() => decryptItem(enc, k, 'v2', 'i1')).toThrow(CryptoError);
  });
});

describe('passcodes', () => {
  it('hashes with a salt and verifies', async () => {
    const cost = { ops: 2, mem: 8 * 1024 * 1024 };
    const h = await hashPasscode('1234-abcd', cost);
    expect(h).toMatch(/^\$argon2id\$/);
    expect(await hashPasscode('1234-abcd', cost)).not.toBe(h);
    expect(await verifyPasscode('1234-abcd', h)).toBe(true);
    expect(await verifyPasscode('1234-abce', h)).toBe(false);
    expect(await verifyPasscode('x', 'garbage')).toBe(false);
  });
});
