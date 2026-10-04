import { createHash } from 'node:crypto';

/** OpenSSH-style SHA256 fingerprint ("SHA256:<base64 without padding>") of a raw public key blob. */
export function fingerprintSha256(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** The key type is the first SSH string inside the blob, e.g. "ssh-ed25519". */
export function keyTypeOf(blob: Buffer): string {
  if (blob.length < 4) return 'unknown';
  const len = blob.readUInt32BE(0);
  if (len > 64 || 4 + len > blob.length) return 'unknown';
  return blob.subarray(4, 4 + len).toString('ascii');
}
