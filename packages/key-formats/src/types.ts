export type KeyType =
  | 'ssh-ed25519'
  | 'ecdsa-sha2-nistp256'
  | 'ecdsa-sha2-nistp384'
  | 'ecdsa-sha2-nistp521'
  | 'ssh-rsa';

export type SourceFormat = 'openssh' | 'pem' | 'pkcs8' | 'ppk2' | 'ppk3';

/** A decrypted private key in a neutral form that can be re-serialized to OpenSSH. */
export interface PrivateKey {
  type: KeyType;
  /** SSH wire-format public key blob. */
  publicBlob: Buffer;
  /** OpenSSH private-section fields following the key type string. */
  privateFields: Buffer;
  comment: string;
  bits: number;
  sourceFormat: SourceFormat;
}

export type KeyErrorCode = 'passphrase_required' | 'bad_passphrase' | 'unsupported' | 'invalid' | 'integrity' | 'cert_invalid' | 'cert_mismatch' | 'cert_host';

export class KeyFormatError extends Error {
  constructor(
    readonly code: KeyErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'KeyFormatError';
  }
}

export const CURVES: Record<string, { name: string; jwk: string; bits: number; type: KeyType }> = {
  nistp256: { name: 'nistp256', jwk: 'P-256', bits: 256, type: 'ecdsa-sha2-nistp256' },
  nistp384: { name: 'nistp384', jwk: 'P-384', bits: 384, type: 'ecdsa-sha2-nistp384' },
  nistp521: { name: 'nistp521', jwk: 'P-521', bits: 521, type: 'ecdsa-sha2-nistp521' },
};

export function isKeyType(t: string): t is KeyType {
  return ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa'].includes(t);
}
