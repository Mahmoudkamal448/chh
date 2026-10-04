import { createHash } from 'node:crypto';
import { KeyFormatError, isKeyType, type KeyType, type PrivateKey } from './types';
import { WireReader } from './wire';

/** OpenSSH-style SHA256 fingerprint of a public key blob. */
export function fingerprint(publicBlob: Buffer): string {
  return `SHA256:${createHash('sha256').update(publicBlob).digest('base64').replace(/=+$/, '')}`;
}

/** "ssh-ed25519 AAAA… comment" */
export function publicKeyLine(key: Pick<PrivateKey, 'type' | 'publicBlob' | 'comment'>): string {
  return `${key.type} ${key.publicBlob.toString('base64')}${key.comment ? ` ${key.comment}` : ''}`;
}

export interface PublicKeyInfo {
  type: KeyType;
  publicBlob: Buffer;
  comment: string;
}

export function parsePublicKeyLine(line: string): PublicKeyInfo {
  const parts = line.trim().split(/\s+/);
  const [type, b64, ...rest] = parts;
  if (!type || !b64 || !isKeyType(type)) throw new KeyFormatError('unsupported');
  const blob = Buffer.from(b64, 'base64');
  if (new WireReader(blob).text() !== type) throw new KeyFormatError('invalid', 'key type mismatch');
  return { type, publicBlob: blob, comment: rest.join(' ') };
}

/** Human-readable algorithm label, e.g. "ED25519", "ECDSA 384", "RSA 4096". */
export function describeKey(k: Pick<PrivateKey, 'type' | 'bits'>): string {
  if (k.type === 'ssh-ed25519') return 'ED25519';
  if (k.type === 'ssh-rsa') return `RSA ${k.bits}`;
  return `ECDSA ${k.bits}`;
}
