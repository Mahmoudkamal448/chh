/**
 * Zero-knowledge account cryptography (see docs/ARCHITECTURE.md §5).
 *
 *   password ──Argon2id(salt, params)──▶ masterKey
 *   masterKey ──KDF #1 "cy-auth_"──▶ authKey   (sent to the server, which stores only argon2id(authKey))
 *   masterKey ──KDF #2 "cy-kek__"──▶ KEK       (never leaves the device)
 *   KEK        ──wraps──▶ accountKey (random)
 *   accountKey ──wraps──▶ vault keys, X25519 private key
 *   recoveryKey (random, shown once) ──wraps──▶ accountKey
 */
import sodium from 'sodium-native';
import { CryptoError, aeadDecrypt, aeadEncrypt, deriveSubkey, memzero, randomBytes, randomKey, unwrapKey, wrapKey } from './index';

export interface KdfParams {
  alg: 'argon2id13';
  /** base64, 16 bytes */
  salt: string;
  ops: number;
  /** bytes */
  mem: number;
}

/** Desktop defaults: ~0.5–1 s on a modern laptop. */
export const DEFAULT_KDF = { ops: 3, mem: 256 * 1024 * 1024 } as const;
/** Lower bound accepted from a server (prevents a malicious server from downgrading the KDF). */
export const MIN_KDF = { ops: 2, mem: 64 * 1024 * 1024 } as const;

export function newKdfParams(cost: { ops: number; mem: number } = DEFAULT_KDF): KdfParams {
  return { alg: 'argon2id13', salt: randomBytes(sodium.crypto_pwhash_SALTBYTES).toString('base64'), ops: cost.ops, mem: cost.mem };
}

/** Argon2id; runs on libsodium's thread pool so it doesn't block the event loop. */
export function deriveMasterKey(password: string, params: KdfParams): Promise<Buffer> {
  const salt = Buffer.from(params.salt, 'base64');
  if (params.alg !== 'argon2id13' || salt.length !== sodium.crypto_pwhash_SALTBYTES) return Promise.reject(new CryptoError('bad KDF params'));
  const out = Buffer.alloc(32);
  const pw = Buffer.from(password.normalize('NFKC'), 'utf8');
  return new Promise((resolve, reject) => {
    sodium.crypto_pwhash_async(out, pw, salt, params.ops, params.mem, sodium.crypto_pwhash_ALG_ARGON2ID13, (err) => {
      memzero(pw);
      if (err) reject(new CryptoError('key derivation failed'));
      else resolve(out);
    });
  });
}

export interface DerivedKeys {
  /** Proves knowledge of the password to the server. */
  authKey: Buffer;
  /** Wraps the account key; never leaves the device. */
  kek: Buffer;
}

export function splitMasterKey(masterKey: Buffer): DerivedKeys {
  return { authKey: deriveSubkey(masterKey, 1, 'cy-auth_'), kek: deriveSubkey(masterKey, 2, 'cy-kek__') };
}

const accountAd = (email: string) => `cy/account/v1|${email.trim().toLowerCase()}`;
const recoveryAd = (email: string) => `cy/recovery/v1|${email.trim().toLowerCase()}`;
const privateKeyAd = 'cy/x25519/v1';
export const vaultKeyAd = (vaultId: string) => `cy/vaultkey/v1|${vaultId}`;

export interface AccountSecrets {
  accountKey: Buffer;
  publicKey: Buffer;
  privateKey: Buffer;
}

/** Everything the server stores for an account (all opaque to it). */
export interface AccountBlobs {
  accountKeyWrapped: string;
  publicKey: string;
  privateKeyWrapped: string;
  recoveryWrapped: string;
}

export function createAccountSecrets(): AccountSecrets {
  const publicKey = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES);
  const privateKey = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES);
  sodium.crypto_box_keypair(publicKey, privateKey);
  return { accountKey: randomKey(), publicKey, privateKey };
}

/** Recovery key: 32 random bytes rendered as 13 groups of base32 for writing down. */
export function newRecoveryKey(): { key: Buffer; text: string } {
  const key = randomKey();
  return { key, text: formatRecoveryKey(key) };
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function formatRecoveryKey(key: Buffer): string {
  let bits = '';
  for (const b of key) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out.match(/.{1,4}/g)!.join('-');
}

export function parseRecoveryKey(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (clean.length !== 52) throw new CryptoError('invalid recovery key');
  let bits = '';
  for (const c of clean) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}

export function wrapAccount(secrets: AccountSecrets, kek: Buffer, recoveryKey: Buffer, email: string): AccountBlobs {
  return {
    accountKeyWrapped: wrapKey(secrets.accountKey, kek, accountAd(email)).toString('base64'),
    publicKey: secrets.publicKey.toString('base64'),
    privateKeyWrapped: Buffer.concat(Object.values(aeadEncrypt(secrets.privateKey, secrets.accountKey, privateKeyAd))).toString('base64'),
    recoveryWrapped: wrapKey(secrets.accountKey, recoveryKey, recoveryAd(email)).toString('base64'),
  };
}

/** Rewraps the account key under a new KEK (password change); vault data is untouched. */
export function rewrapAccountKey(accountKey: Buffer, kek: Buffer, email: string): string {
  return wrapKey(accountKey, kek, accountAd(email)).toString('base64');
}

export function unwrapAccountKey(blob: string, kek: Buffer, email: string): Buffer {
  return unwrapKey(Buffer.from(blob, 'base64'), kek, accountAd(email));
}

export function unwrapAccountKeyWithRecovery(blob: string, recoveryKey: Buffer, email: string): Buffer {
  return unwrapKey(Buffer.from(blob, 'base64'), recoveryKey, recoveryAd(email));
}

export function unwrapPrivateKey(blob: string, accountKey: Buffer): Buffer {
  const raw = Buffer.from(blob, 'base64');
  return aeadDecrypt(raw.subarray(24), raw.subarray(0, 24), accountKey, privateKeyAd);
}

export function wrapVaultKey(vaultKey: Buffer, accountKey: Buffer, vaultId: string): string {
  return wrapKey(vaultKey, accountKey, vaultKeyAd(vaultId)).toString('base64');
}

export function unwrapVaultKey(blob: string, accountKey: Buffer, vaultId: string): Buffer {
  return unwrapKey(Buffer.from(blob, 'base64'), accountKey, vaultKeyAd(vaultId));
}

/** Anonymous public-key encryption (used for team vault key distribution). */
export function sealTo(publicKey: Buffer, message: Buffer): Buffer {
  const out = Buffer.alloc(message.length + sodium.crypto_box_SEALBYTES);
  sodium.crypto_box_seal(out, message, publicKey);
  return out;
}

export function openSealed(publicKey: Buffer, privateKey: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < sodium.crypto_box_SEALBYTES) throw new CryptoError();
  const out = Buffer.alloc(sealed.length - sodium.crypto_box_SEALBYTES);
  if (!sodium.crypto_box_seal_open(out, sealed, publicKey, privateKey)) throw new CryptoError();
  return out;
}

// --- Synced item envelopes ---------------------------------------------------------------------

const PAD_BUCKET = 256;
const itemAd = (vaultId: string, itemId: string) => `cy/item/v1|${vaultId}|${itemId}`;

/**
 * Encrypts an item for the sync server. Plaintext is padded to 256-byte buckets so sizes leak
 * little, and bound to (vault, item) so the server can't move ciphertexts around.
 */
export function encryptItem(payload: unknown, vaultKey: Buffer, vaultId: string, itemId: string): { nonce: string; ciphertext: string } {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length);
  const total = Math.ceil((json.length + 4) / PAD_BUCKET) * PAD_BUCKET;
  const plain = Buffer.concat([len, json, Buffer.alloc(total - json.length - 4)]);
  const { nonce, ciphertext } = aeadEncrypt(plain, vaultKey, itemAd(vaultId, itemId));
  memzero(plain);
  return { nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64') };
}

export function decryptItem<T>(enc: { nonce: string; ciphertext: string }, vaultKey: Buffer, vaultId: string, itemId: string): T {
  const plain = aeadDecrypt(Buffer.from(enc.ciphertext, 'base64'), Buffer.from(enc.nonce, 'base64'), vaultKey, itemAd(vaultId, itemId));
  const n = plain.readUInt32BE(0);
  if (n > plain.length - 4) throw new CryptoError('bad padding');
  const out = JSON.parse(plain.subarray(4, 4 + n).toString('utf8')) as T;
  memzero(plain);
  return out;
}

// --- local passcodes (app lock) ----------------------------------------------------------------

/** Argon2id password-hash string (libsodium format, includes salt and parameters). */
export function hashPasscode(passcode: string, cost: { ops: number; mem: number } = { ops: 3, mem: 64 * 1024 * 1024 }): Promise<string> {
  const out = Buffer.alloc(sodium.crypto_pwhash_STRBYTES);
  const pw = Buffer.from(passcode.normalize('NFKC'), 'utf8');
  return new Promise((resolve, reject) => {
    sodium.crypto_pwhash_str_async(out, pw, cost.ops, cost.mem, (err) => {
      memzero(pw);
      if (err) return reject(new CryptoError('hashing failed'));
      resolve(out.toString('utf8').replace(/\0+$/, ''));
    });
  });
}

export function verifyPasscode(passcode: string, hash: string): Promise<boolean> {
  const str = Buffer.alloc(sodium.crypto_pwhash_STRBYTES);
  Buffer.from(hash, 'utf8').copy(str);
  const pw = Buffer.from(passcode.normalize('NFKC'), 'utf8');
  return new Promise((resolve) => {
    sodium.crypto_pwhash_str_verify_async(str, pw, (err, ok) => {
      memzero(pw);
      resolve(!err && !!ok);
    });
  });
}
