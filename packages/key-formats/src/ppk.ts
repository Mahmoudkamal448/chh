import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { argon2d, argon2i, argon2id } from 'hash-wasm';
import { ecdsaKey, ed25519Key, rsaKey } from './build';
import { KeyFormatError, type PrivateKey } from './types';
import { WireReader, WireWriter } from './wire';

interface PpkFile {
  version: 2 | 3;
  algorithm: string;
  encryption: string;
  comment: string;
  publicBlob: Buffer;
  privateBlob: Buffer;
  mac: Buffer;
  headers: Record<string, string>;
}

export function isPpk(text: string): boolean {
  return /^PuTTY-User-Key-File-[23]:/m.test(text);
}

function parseFile(text: string): PpkFile {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const headers: Record<string, string> = {};
  let publicBlob: Buffer | null = null;
  let privateBlob: Buffer | null = null;
  let version: 2 | 3 | null = null;
  let algorithm = '';
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9-]+):\s?(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const [, name, value] = m as unknown as [string, string, string];
    const vm = /^PuTTY-User-Key-File-([23])$/.exec(name);
    if (vm) {
      version = Number(vm[1]) as 2 | 3;
      algorithm = value.trim();
      continue;
    }
    if (name === 'Public-Lines' || name === 'Private-Lines') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 1000) throw new KeyFormatError('invalid', 'bad line count');
      const b = Buffer.from(lines.slice(i + 1, i + 1 + n).join(''), 'base64');
      if (name === 'Public-Lines') publicBlob = b;
      else privateBlob = b;
      i += n;
      continue;
    }
    headers[name] = value.trim();
  }
  if (!version || !publicBlob || !privateBlob || !headers['Private-MAC']) throw new KeyFormatError('invalid', 'incomplete PPK file');
  return {
    version,
    algorithm,
    encryption: headers.Encryption ?? 'none',
    comment: headers.Comment ?? '',
    publicBlob,
    privateBlob,
    mac: Buffer.from(headers['Private-MAC'], 'hex'),
    headers,
  };
}

export function ppkIsEncrypted(text: string): boolean {
  return parseFile(text).encryption !== 'none';
}

async function argon2(kind: string, password: Buffer, salt: Buffer, memoryKiB: number, passes: number, parallelism: number) {
  const opts = { password, salt, memorySize: memoryKiB, iterations: passes, parallelism, hashLength: 80, outputType: 'binary' as const };
  if (memoryKiB > 1024 * 1024 || passes > 1000 || parallelism > 64) throw new KeyFormatError('unsupported', 'Argon2 parameters too large');
  switch (kind) {
    case 'Argon2id':
      return Buffer.from(await argon2id(opts));
    case 'Argon2i':
      return Buffer.from(await argon2i(opts));
    case 'Argon2d':
      return Buffer.from(await argon2d(opts));
    default:
      throw new KeyFormatError('unsupported', `unsupported KDF ${kind}`);
  }
}

/** Parses PuTTY .ppk v2/v3 (unencrypted or aes256-cbc), verifying the file MAC. */
export async function parsePpk(text: string, passphrase?: string): Promise<PrivateKey> {
  const f = parseFile(text);
  if (f.encryption !== 'none' && f.encryption !== 'aes256-cbc') throw new KeyFormatError('unsupported', `unsupported encryption ${f.encryption}`);
  const encrypted = f.encryption === 'aes256-cbc';
  if (encrypted && !passphrase) throw new KeyFormatError('passphrase_required');
  const pass = Buffer.from(encrypted ? passphrase! : '', 'utf8');

  let macKey: Buffer;
  let privateBlob = f.privateBlob;
  let macAlgo: 'sha1' | 'sha256';
  if (f.version === 2) {
    macAlgo = 'sha1';
    macKey = createHash('sha1').update('putty-private-key-file-mac-key').update(pass).digest();
    if (encrypted) {
      const k = Buffer.concat([
        createHash('sha1').update(Buffer.from([0, 0, 0, 0])).update(pass).digest(),
        createHash('sha1').update(Buffer.from([0, 0, 0, 1])).update(pass).digest(),
      ]).subarray(0, 32);
      privateBlob = decrypt(privateBlob, k, Buffer.alloc(16));
    }
  } else {
    macAlgo = 'sha256';
    if (encrypted) {
      const h = f.headers;
      const derived = await argon2(
        h['Key-Derivation'] ?? '',
        pass,
        Buffer.from(h['Argon2-Salt'] ?? '', 'hex'),
        Number(h['Argon2-Memory']),
        Number(h['Argon2-Passes']),
        Number(h['Argon2-Parallelism']),
      );
      privateBlob = decrypt(privateBlob, derived.subarray(0, 32), derived.subarray(32, 48));
      macKey = derived.subarray(48, 80);
    } else {
      macKey = Buffer.alloc(0);
    }
  }

  const macData = new WireWriter()
    .string(f.algorithm)
    .string(f.encryption)
    .string(f.comment)
    .string(f.publicBlob)
    .string(privateBlob)
    .toBuffer();
  const mac = createHmac(macAlgo, macKey).update(macData).digest();
  if (mac.length !== f.mac.length || !timingSafeEqual(mac, f.mac)) {
    throw new KeyFormatError(encrypted ? 'bad_passphrase' : 'integrity');
  }

  const pub = new WireReader(f.publicBlob);
  const type = pub.text();
  if (type !== f.algorithm) throw new KeyFormatError('invalid', 'algorithm mismatch');
  const priv = new WireReader(privateBlob);
  const fmt = f.version === 2 ? 'ppk2' : 'ppk3';
  let key: PrivateKey;
  switch (type) {
    case 'ssh-ed25519': {
      const pubKey = pub.string();
      key = ed25519Key(priv.string(), pubKey, f.comment, fmt);
      break;
    }
    case 'ecdsa-sha2-nistp256':
    case 'ecdsa-sha2-nistp384':
    case 'ecdsa-sha2-nistp521': {
      const curve = pub.text();
      const q = pub.string();
      key = ecdsaKey(curve, q, priv.mpint(), f.comment, fmt);
      break;
    }
    case 'ssh-rsa': {
      const e = pub.mpint();
      const n = pub.mpint();
      const d = priv.mpint();
      const p = priv.mpint();
      const q = priv.mpint();
      const iqmp = priv.mpint();
      key = rsaKey({ n, e, d, p, q, iqmp }, f.comment, fmt);
      break;
    }
    default:
      throw new KeyFormatError('unsupported', `unsupported key type ${type}`);
  }
  if (!key.publicBlob.equals(f.publicBlob)) throw new KeyFormatError('integrity', 'public key does not match');
  return key;
}

function decrypt(data: Buffer, key: Buffer, iv: Buffer): Buffer {
  if (data.length % 16 !== 0) throw new KeyFormatError('invalid', 'bad private blob length');
  const d = createDecipheriv('aes-256-cbc', key, iv);
  d.setAutoPadding(false);
  return Buffer.concat([d.update(data), d.final()]);
}
