import { createPrivateKey, type JsonWebKey } from 'node:crypto';
import { fromJwk } from './build';
import { KeyFormatError, type PrivateKey } from './types';

const PEM_RE = /-----BEGIN (RSA |EC |ENCRYPTED |DSA )?PRIVATE KEY-----/;

export function isPem(text: string): boolean {
  return PEM_RE.test(text);
}

export function pemIsEncrypted(text: string): boolean {
  return text.includes('BEGIN ENCRYPTED PRIVATE KEY') || /Proc-Type:\s*4,ENCRYPTED/.test(text);
}

/** PKCS#1 (RSA), SEC1 (EC) and PKCS#8 keys, optionally encrypted. Parsed by Node's OpenSSL. */
export function parsePem(text: string, passphrase?: string): PrivateKey {
  const m = PEM_RE.exec(text);
  if (!m) throw new KeyFormatError('invalid');
  if (m[1] === 'DSA ') throw new KeyFormatError('unsupported', 'DSA keys are not supported (insecure)');
  const encrypted = pemIsEncrypted(text);
  if (encrypted && !passphrase) throw new KeyFormatError('passphrase_required');
  let jwk: JsonWebKey;
  try {
    const key = createPrivateKey({ key: text, format: 'pem', passphrase: encrypted ? passphrase : undefined });
    jwk = key.export({ format: 'jwk' });
  } catch (e) {
    const msg = (e as Error).message;
    if (encrypted && /decrypt|bad|passphrase/i.test(msg)) throw new KeyFormatError('bad_passphrase');
    throw new KeyFormatError('unsupported', msg);
  }
  return fromJwk(jwk, '', m[1] ? 'pem' : 'pkcs8');
}
