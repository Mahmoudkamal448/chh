import sodium from 'sodium-native';

export const KEY_BYTES = 32;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;

export class CryptoError extends Error {
  constructor(message = 'decryption failed') {
    super(message);
    this.name = 'CryptoError';
  }
}

/**
 * Key buffers. libsodium's guarded `sodium_malloc` memory can't be used: it is an external
 * ArrayBuffer, which Electron's V8 memory cage forbids. Keys live in ordinary buffers instead and
 * callers wipe them with `memzero` when done.
 */
function keyBuffer(): Buffer {
  return Buffer.alloc(KEY_BYTES);
}

/** A fresh random 32-byte key. */
export function randomKey(): Buffer {
  const k = keyBuffer();
  sodium.randombytes_buf(k);
  return k;
}

export function randomBytes(n: number): Buffer {
  const b = Buffer.alloc(n);
  sodium.randombytes_buf(b);
  return b;
}

export function memzero(b: Buffer | null | undefined): void {
  if (b) sodium.sodium_memzero(b);
}

function checkKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) throw new CryptoError('invalid key length');
}

/** XChaCha20-Poly1305 (IETF). `ad` binds the ciphertext to its context (e.g. vault/item id). */
export function aeadEncrypt(plaintext: Buffer, key: Buffer, ad: string): { nonce: Buffer; ciphertext: Buffer } {
  checkKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = Buffer.alloc(plaintext.length + TAG_BYTES);
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ciphertext, plaintext, Buffer.from(ad, 'utf8'), null, nonce, key);
  return { nonce, ciphertext };
}

export function aeadDecrypt(ciphertext: Buffer, nonce: Buffer, key: Buffer, ad: string): Buffer {
  checkKey(key);
  if (nonce.length !== NONCE_BYTES || ciphertext.length < TAG_BYTES) throw new CryptoError();
  const out = Buffer.alloc(ciphertext.length - TAG_BYTES);
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(out, null, ciphertext, Buffer.from(ad, 'utf8'), nonce, key);
  } catch {
    throw new CryptoError();
  }
  return out;
}

/**
 * Derive an independent subkey. `context` must be exactly 8 ASCII chars (libsodium requirement),
 * e.g. "cylocal_".
 */
export function deriveSubkey(master: Buffer, id: number, context: string): Buffer {
  checkKey(master);
  const ctx = Buffer.from(context, 'ascii');
  if (ctx.length !== 8) throw new CryptoError('KDF context must be 8 bytes');
  const sub = keyBuffer();
  sodium.crypto_kdf_derive_from_key(sub, id, ctx, master);
  return sub;
}

/** Wrap (encrypt) a key with another key. Output: nonce || ciphertext. */
export function wrapKey(key: Buffer, wrappingKey: Buffer, ad: string): Buffer {
  const { nonce, ciphertext } = aeadEncrypt(key, wrappingKey, ad);
  return Buffer.concat([nonce, ciphertext]);
}

export function unwrapKey(wrapped: Buffer, wrappingKey: Buffer, ad: string): Buffer {
  if (wrapped.length !== NONCE_BYTES + KEY_BYTES + TAG_BYTES) throw new CryptoError('invalid wrapped key');
  const plain = aeadDecrypt(wrapped.subarray(NONCE_BYTES), wrapped.subarray(0, NONCE_BYTES), wrappingKey, ad);
  const k = keyBuffer();
  plain.copy(k);
  memzero(plain);
  return k;
}

/** Sealed string format stored inside item fields (matches `SealedSchema` in @chh/shared). */
export interface SealedString {
  v: 1;
  n: string;
  c: string;
}

export function sealString(value: string, key: Buffer, ad: string): SealedString {
  const plain = Buffer.from(value, 'utf8');
  const { nonce, ciphertext } = aeadEncrypt(plain, key, ad);
  memzero(plain);
  return { v: 1, n: nonce.toString('base64'), c: ciphertext.toString('base64') };
}

export function openString(sealed: SealedString, key: Buffer, ad: string): string {
  if (sealed.v !== 1) throw new CryptoError('unsupported sealed version');
  const plain = aeadDecrypt(Buffer.from(sealed.c, 'base64'), Buffer.from(sealed.n, 'base64'), key, ad);
  const s = plain.toString('utf8');
  memzero(plain);
  return s;
}

export * from './account';
