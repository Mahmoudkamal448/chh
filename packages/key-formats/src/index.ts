import { isOpenSshPrivate, openSshIsEncrypted, parseOpenSshPrivate } from './openssh';
import { isPem, parsePem, pemIsEncrypted } from './pem';
import { isPpk, parsePpk, ppkIsEncrypted } from './ppk';
import { KeyFormatError, type PrivateKey } from './types';

export * from './types';
export { writeOpenSshPrivate } from './openssh';
export { fingerprint, publicKeyLine, parsePublicKeyLine, describeKey, type PublicKeyInfo } from './public';
export { generateKey, type GenerateSpec } from './generate';
export * from './known-hosts';

export type DetectedFormat = 'openssh' | 'pem' | 'ppk' | 'unknown';

export function detectFormat(text: string): DetectedFormat {
  if (isOpenSshPrivate(text)) return 'openssh';
  if (isPpk(text)) return 'ppk';
  if (isPem(text)) return 'pem';
  return 'unknown';
}

/** Whether importing this key needs a passphrase. */
export function isEncrypted(text: string): boolean {
  switch (detectFormat(text)) {
    case 'openssh':
      return openSshIsEncrypted(text);
    case 'ppk':
      return ppkIsEncrypted(text);
    case 'pem':
      return pemIsEncrypted(text);
    default:
      throw new KeyFormatError('unsupported', 'unrecognized key format');
  }
}

/** Parses (and decrypts) a private key in OpenSSH, PEM/PKCS#8 or PuTTY .ppk v2/v3 format. */
export async function parsePrivateKey(text: string, passphrase?: string): Promise<PrivateKey> {
  switch (detectFormat(text)) {
    case 'openssh':
      return parseOpenSshPrivate(text, passphrase);
    case 'ppk':
      return parsePpk(text, passphrase);
    case 'pem':
      return parsePem(text, passphrase);
    default:
      throw new KeyFormatError('unsupported', 'unrecognized key format');
  }
}
