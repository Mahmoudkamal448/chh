import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import { memzero, randomKey } from '@cy-ssh/vault-crypto';

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
 * is warned before this mode is used; a master-password lock (Phase 4) closes the gap.
 */
const PLAIN_PREFIX = 'cy-plain-v1:';

function decode(data: Buffer): string {
  const text = data.toString('latin1');
  if (text.startsWith(PLAIN_PREFIX)) return text.slice(PLAIN_PREFIX.length).trim();
  return safeStorage.decryptString(data);
}

function encode(hex: string): Buffer {
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(hex);
  return Buffer.from(PLAIN_PREFIX + hex, 'latin1');
}

/**
 * Returns the 32-byte local database key, creating it on first run.
 * The key is stored only in OS-protected form when available; the caller must memzero it when done.
 */
export function loadOrCreateLocalKey(userDataDir: string): { key: Buffer; created: boolean } {
  const path = join(userDataDir, KEY_FILE);
  if (existsSync(path)) {
    const key = Buffer.from(decode(readFileSync(path)), 'hex');
    if (key.length !== 32) throw new Error('local key file is corrupt');
    return { key, created: false };
  }
  const key = randomKey();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, encode(key.toString('hex')), { mode: 0o600 });
  renameSync(tmp, path);
  return { key, created: true };
}

export { memzero };
