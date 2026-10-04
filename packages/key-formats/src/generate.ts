import { generateKeyPairSync } from 'node:crypto';
import { fromJwk } from './build';
import { KeyFormatError, type PrivateKey } from './types';

export type GenerateSpec =
  | { algorithm: 'ed25519' }
  | { algorithm: 'ecdsa'; bits: 256 | 384 | 521 }
  | { algorithm: 'rsa'; bits: 2048 | 3072 | 4096 };

/** Generates a new key pair with Node's crypto (OpenSSL). */
export function generateKey(spec: GenerateSpec, comment = ''): PrivateKey {
  let jwk;
  switch (spec.algorithm) {
    case 'ed25519':
      jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
      break;
    case 'ecdsa': {
      const namedCurve = { 256: 'P-256', 384: 'P-384', 521: 'P-521' }[spec.bits];
      jwk = generateKeyPairSync('ec', { namedCurve }).privateKey.export({ format: 'jwk' });
      break;
    }
    case 'rsa':
      if (![2048, 3072, 4096].includes(spec.bits)) throw new KeyFormatError('unsupported', 'RSA keys must be 2048, 3072 or 4096 bits');
      jwk = generateKeyPairSync('rsa', { modulusLength: spec.bits, publicExponent: 65537 }).privateKey.export({ format: 'jwk' });
      break;
  }
  return { ...fromJwk(jwk, comment, 'openssh'), sourceFormat: 'openssh' };
}
