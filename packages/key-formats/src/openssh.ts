import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto';
import { pbkdf as bcryptPbkdf } from 'bcrypt-pbkdf';
import { readOpenSshFields } from './build';
import { KeyFormatError, type PrivateKey } from './types';
import { WireReader, WireWriter } from './wire';

const MAGIC = Buffer.from('openssh-key-v1\0', 'latin1');
const BEGIN = '-----BEGIN OPENSSH PRIVATE KEY-----';
const END = '-----END OPENSSH PRIVATE KEY-----';

interface CipherSpec {
  node: string;
  keyLen: number;
  ivLen: number;
  blockSize: number;
  authTagLen?: number;
}

const CIPHERS: Record<string, CipherSpec> = {
  'aes128-ctr': { node: 'aes-128-ctr', keyLen: 16, ivLen: 16, blockSize: 16 },
  'aes192-ctr': { node: 'aes-192-ctr', keyLen: 24, ivLen: 16, blockSize: 16 },
  'aes256-ctr': { node: 'aes-256-ctr', keyLen: 32, ivLen: 16, blockSize: 16 },
  'aes128-cbc': { node: 'aes-128-cbc', keyLen: 16, ivLen: 16, blockSize: 16 },
  'aes192-cbc': { node: 'aes-192-cbc', keyLen: 24, ivLen: 16, blockSize: 16 },
  'aes256-cbc': { node: 'aes-256-cbc', keyLen: 32, ivLen: 16, blockSize: 16 },
  'aes128-gcm@openssh.com': { node: 'aes-128-gcm', keyLen: 16, ivLen: 12, blockSize: 16, authTagLen: 16 },
  'aes256-gcm@openssh.com': { node: 'aes-256-gcm', keyLen: 32, ivLen: 12, blockSize: 16, authTagLen: 16 },
};

export function isOpenSshPrivate(text: string): boolean {
  return text.includes(BEGIN);
}

function decodeArmor(text: string): Buffer {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start < 0 || end < 0) throw new KeyFormatError('invalid', 'missing OpenSSH armor');
  const raw = Buffer.from(text.slice(start + BEGIN.length, end).replace(/\s+/g, ''), 'base64');
  if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new KeyFormatError('invalid', 'bad OpenSSH magic');
  return raw.subarray(MAGIC.length);
}

function deriveKeyIv(passphrase: string, salt: Buffer, rounds: number, spec: CipherSpec): { key: Buffer; iv: Buffer } {
  const out = new Uint8Array(spec.keyLen + spec.ivLen);
  const pass = Buffer.from(passphrase, 'utf8');
  if (bcryptPbkdf(pass, pass.length, salt, salt.length, out, out.length, rounds) !== 0) {
    throw new KeyFormatError('invalid', 'bcrypt_pbkdf failed');
  }
  const b = Buffer.from(out);
  return { key: b.subarray(0, spec.keyLen), iv: b.subarray(spec.keyLen) };
}

/** True if the OpenSSH key is passphrase-protected. */
export function openSshIsEncrypted(text: string): boolean {
  const r = new WireReader(decodeArmor(text));
  return r.text() !== 'none';
}

export function parseOpenSshPrivate(text: string, passphrase?: string): PrivateKey {
  let r: WireReader;
  try {
    r = new WireReader(decodeArmor(text));
  } catch (e) {
    if (e instanceof KeyFormatError) throw e;
    throw new KeyFormatError('invalid');
  }
  try {
    const cipherName = r.text();
    const kdfName = r.text();
    const kdfOpts = new WireReader(r.string());
    const nkeys = r.uint32();
    if (nkeys !== 1) throw new KeyFormatError('unsupported', 'multiple keys in one file');
    const publicBlob = Buffer.from(r.string());
    let section = r.string();

    if (cipherName !== 'none') {
      const spec = CIPHERS[cipherName];
      if (!spec) throw new KeyFormatError('unsupported', `unsupported cipher ${cipherName}`);
      if (kdfName !== 'bcrypt') throw new KeyFormatError('unsupported', `unsupported KDF ${kdfName}`);
      if (passphrase === undefined || passphrase === '') throw new KeyFormatError('passphrase_required');
      const salt = kdfOpts.string();
      const rounds = kdfOpts.uint32();
      const { key, iv } = deriveKeyIv(passphrase, salt, rounds, spec);
      const decipher = createDecipheriv(spec.node, key, iv);
      decipher.setAutoPadding(false);
      if (spec.authTagLen) {
        const tag = r.bytes(spec.authTagLen);
        (decipher as unknown as { setAuthTag(t: Buffer): void }).setAuthTag(tag);
      }
      try {
        section = Buffer.concat([decipher.update(section), decipher.final()]);
      } catch {
        throw new KeyFormatError('bad_passphrase');
      }
    }

    const s = new WireReader(section);
    const check1 = s.uint32();
    const check2 = s.uint32();
    if (check1 !== check2) throw new KeyFormatError(cipherName === 'none' ? 'invalid' : 'bad_passphrase');
    const type = s.text();
    const key = readOpenSshFields(type, s);
    const comment = s.text();
    if (!key.publicBlob.equals(publicBlob)) throw new KeyFormatError('integrity', 'public key does not match private key');
    return { ...key, comment, sourceFormat: 'openssh' };
  } catch (e) {
    if (e instanceof KeyFormatError) throw e;
    throw new KeyFormatError('invalid', (e as Error).message);
  }
}

/**
 * Serializes to the OpenSSH private key format. With a passphrase the key is encrypted with
 * aes256-ctr and bcrypt-pbkdf (same defaults as ssh-keygen).
 */
export function writeOpenSshPrivate(key: PrivateKey, passphrase?: string, rounds = 16): string {
  const encrypt = !!passphrase;
  const blockSize = encrypt ? 16 : 8;
  const check = randomInt(0, 2 ** 32 - 1);
  const body = new WireWriter().uint32(check).uint32(check).string(key.type).raw(key.privateFields).string(key.comment).toBuffer();
  const padLen = (blockSize - (body.length % blockSize)) % blockSize;
  const pad = Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1));
  let section = Buffer.concat([body, pad]);

  const w = new WireWriter().raw(MAGIC);
  if (encrypt) {
    const spec = CIPHERS['aes256-ctr']!;
    const salt = randomBytes(16);
    const { key: k, iv } = deriveKeyIv(passphrase!, salt, rounds, spec);
    const cipher = createCipheriv(spec.node, k, iv);
    section = Buffer.concat([cipher.update(section), cipher.final()]);
    w.string('aes256-ctr').string('bcrypt').string(new WireWriter().string(salt).uint32(rounds).toBuffer());
  } else {
    w.string('none').string('none').string(Buffer.alloc(0));
  }
  w.uint32(1).string(key.publicBlob).string(section);
  const b64 = w.toBuffer().toString('base64');
  const lines = b64.match(/.{1,70}/g) ?? [];
  return `${BEGIN}\n${lines.join('\n')}\n${END}\n`;
}
