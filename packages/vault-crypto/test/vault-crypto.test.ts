import { describe, expect, it } from 'vitest';
import {
  CryptoError,
  aeadDecrypt,
  aeadEncrypt,
  deriveSubkey,
  openString,
  randomKey,
  sealString,
  unwrapKey,
  wrapKey,
} from '../src';

describe('aead', () => {
  it('round-trips', () => {
    const k = randomKey();
    const { nonce, ciphertext } = aeadEncrypt(Buffer.from('hello'), k, 'ad');
    expect(aeadDecrypt(ciphertext, nonce, k, 'ad').toString()).toBe('hello');
  });

  it('uses a fresh nonce every time', () => {
    const k = randomKey();
    const a = aeadEncrypt(Buffer.from('x'), k, 'ad');
    const b = aeadEncrypt(Buffer.from('x'), k, 'ad');
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('rejects tampered ciphertext, wrong key, and wrong associated data', () => {
    const k = randomKey();
    const { nonce, ciphertext } = aeadEncrypt(Buffer.from('secret'), k, 'vault1|item1');
    const tampered = Buffer.from(ciphertext);
    tampered[0]! ^= 1;
    expect(() => aeadDecrypt(tampered, nonce, k, 'vault1|item1')).toThrow(CryptoError);
    expect(() => aeadDecrypt(ciphertext, nonce, randomKey(), 'vault1|item1')).toThrow(CryptoError);
    expect(() => aeadDecrypt(ciphertext, nonce, k, 'vault1|item2')).toThrow(CryptoError);
  });

  it('rejects malformed inputs', () => {
    expect(() => aeadEncrypt(Buffer.from('x'), Buffer.alloc(16), 'ad')).toThrow(CryptoError);
    expect(() => aeadDecrypt(Buffer.alloc(4), Buffer.alloc(24), randomKey(), 'ad')).toThrow(CryptoError);
  });
});

describe('key derivation and wrapping', () => {
  it('derives deterministic, independent subkeys', () => {
    const m = randomKey();
    expect(deriveSubkey(m, 1, 'cylocal_').equals(deriveSubkey(m, 1, 'cylocal_'))).toBe(true);
    expect(deriveSubkey(m, 1, 'cylocal_').equals(deriveSubkey(m, 2, 'cylocal_'))).toBe(false);
    expect(deriveSubkey(m, 1, 'cylocal_').equals(deriveSubkey(m, 1, 'cyother_'))).toBe(false);
    expect(() => deriveSubkey(m, 1, 'short')).toThrow(CryptoError);
  });

  it('wraps and unwraps keys bound to their context', () => {
    const kek = randomKey();
    const k = randomKey();
    const w = wrapKey(k, kek, 'vaultkey|v1');
    expect(unwrapKey(w, kek, 'vaultkey|v1').equals(k)).toBe(true);
    expect(() => unwrapKey(w, kek, 'vaultkey|v2')).toThrow(CryptoError);
  });
});

describe('sealed strings', () => {
  it('round-trips unicode and binds to context', () => {
    const k = randomKey();
    const s = sealString('pässwörd 🔑', k, 'item:abc:password');
    expect(s.v).toBe(1);
    expect(JSON.stringify(s)).not.toContain('pässwörd');
    expect(openString(s, k, 'item:abc:password')).toBe('pässwörd 🔑');
    expect(() => openString(s, k, 'item:xyz:password')).toThrow(CryptoError);
  });
});
