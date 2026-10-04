import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import {
  DEFAULT_KDF,
  CryptoError,
  deriveMasterKey,
  memzero,
  newKdfParams,
  randomKey,
  unwrapKey,
  wrapKey,
  type KdfParams,
} from '@chh/vault-crypto';

export type KeystoreKind = 'os' | 'weak';

/**
 * Which protection the OS gives us for the local database key.
 * - 'os': Keychain (macOS), DPAPI (Windows), libsecret/kwallet (Linux)
 * - 'weak': Linux without a secret service — no real protection for the key at rest.
 */
export function keystoreKind(): KeystoreKind {
  if (!safeStorage.isEncryptionAvailable()) return 'weak';
  if (process.platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend();
    if (backend === 'basic_text' || backend === 'unknown') return 'weak';
  }
  return 'os';
}

const KEY_FILE = 'db.key';

/**
 * Prefix for a key stored without OS protection (no keyring at all, e.g. headless Linux). The file
 * is only readable by the user (0600), equivalent to Electron's own "basic_text" fallback. The user
 * is warned before this mode is used; the master password option closes the gap.
 */
const PLAIN_PREFIX = 'cy-plain-v1:';
const PASSWORD_AD = 'cy/dbkey/v2';

export type KeyFile =
  | { kind: 'none' }
  | { kind: 'os'; key: Buffer }
  /** Master-password protected: the key can only be recovered with the password. */
  | { kind: 'password'; kdf: KdfParams; wrapped: Buffer };

function decode(data: Buffer): string {
  const text = data.toString('latin1');
  if (text.startsWith(PLAIN_PREFIX)) return text.slice(PLAIN_PREFIX.length).trim();
  return safeStorage.decryptString(data);
}

function encode(hex: string): Buffer {
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(hex);
  return Buffer.from(PLAIN_PREFIX + hex, 'latin1');
}

function writeAtomic(path: string, data: Buffer | string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export function readKeyFile(userDataDir: string): KeyFile {
  const path = join(userDataDir, KEY_FILE);
  if (!existsSync(path)) return { kind: 'none' };
  const raw = readFileSync(path);
  if (raw[0] === 0x7b /* { */) {
    const j = JSON.parse(raw.toString('utf8')) as { v: number; kdf: KdfParams; wrapped: string };
    if (j.v !== 2) throw new Error('unsupported key file version');
    return { kind: 'password', kdf: j.kdf, wrapped: Buffer.from(j.wrapped, 'base64') };
  }
  const key = Buffer.from(decode(raw), 'hex');
  if (key.length !== 32) throw new Error('local key file is corrupt');
  return { kind: 'os', key };
}

/** Stores the key protected by the OS keychain (or the weak fallback). */
export function writeOsKey(userDataDir: string, key: Buffer): void {
  writeAtomic(join(userDataDir, KEY_FILE), encode(key.toString('hex')));
}

/** Stores the key encrypted with a key derived from the master password (Argon2id). */
export async function writePasswordKey(userDataDir: string, key: Buffer, password: string, cost = DEFAULT_KDF): Promise<void> {
  const kdf = newKdfParams(cost);
  const kek = await deriveMasterKey(password, kdf);
  try {
    writeAtomic(join(userDataDir, KEY_FILE), JSON.stringify({ v: 2, kdf, wrapped: wrapKey(key, kek, PASSWORD_AD).toString('base64') }));
  } finally {
    memzero(kek);
  }
}

/** Returns the database key, or null if the password is wrong. */
export async function unlockPasswordKey(file: { kdf: KdfParams; wrapped: Buffer }, password: string): Promise<Buffer | null> {
  const kek = await deriveMasterKey(password, file.kdf);
  try {
    return unwrapKey(file.wrapped, kek, PASSWORD_AD);
  } catch (e) {
    if (e instanceof CryptoError) return null;
    throw e;
  } finally {
    memzero(kek);
  }
}

/** First run: a fresh random key, stored with OS protection. */
export function createLocalKey(userDataDir: string): Buffer {
  const key = randomKey();
  writeOsKey(userDataDir, key);
  return key;
}

export { memzero };
