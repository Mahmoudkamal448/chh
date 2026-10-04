import type { JsonWebKey } from 'node:crypto';
import { CURVES, KeyFormatError, type KeyType, type PrivateKey, type SourceFormat } from './types';
import { WireReader, WireWriter, b64url } from './wire';

function bitLength(unsigned: Buffer): number {
  let i = 0;
  while (i < unsigned.length && unsigned[i] === 0) i++;
  if (i === unsigned.length) return 0;
  return (unsigned.length - i - 1) * 8 + (32 - Math.clz32(unsigned[i]!));
}

export function ed25519Key(seed: Buffer, pub: Buffer, comment: string, sourceFormat: SourceFormat): PrivateKey {
  if (seed.length !== 32 || pub.length !== 32) throw new KeyFormatError('invalid', 'bad ed25519 key length');
  const type: KeyType = 'ssh-ed25519';
  return {
    type,
    publicBlob: new WireWriter().string(type).string(pub).toBuffer(),
    privateFields: new WireWriter().string(pub).string(Buffer.concat([seed, pub])).toBuffer(),
    comment,
    bits: 256,
    sourceFormat,
  };
}

export function ecdsaKey(curveName: string, q: Buffer, d: Buffer, comment: string, sourceFormat: SourceFormat): PrivateKey {
  const curve = CURVES[curveName];
  if (!curve) throw new KeyFormatError('unsupported', `unsupported curve ${curveName}`);
  return {
    type: curve.type,
    publicBlob: new WireWriter().string(curve.type).string(curve.name).string(q).toBuffer(),
    privateFields: new WireWriter().string(curve.name).string(q).mpint(d).toBuffer(),
    comment,
    bits: curve.bits,
    sourceFormat,
  };
}

export interface RsaParts {
  n: Buffer;
  e: Buffer;
  d: Buffer;
  p: Buffer;
  q: Buffer;
  iqmp: Buffer;
}

export function rsaKey(k: RsaParts, comment: string, sourceFormat: SourceFormat): PrivateKey {
  return {
    type: 'ssh-rsa',
    publicBlob: new WireWriter().string('ssh-rsa').mpint(k.e).mpint(k.n).toBuffer(),
    privateFields: new WireWriter().mpint(k.n).mpint(k.e).mpint(k.d).mpint(k.iqmp).mpint(k.p).mpint(k.q).toBuffer(),
    comment,
    bits: bitLength(k.n),
    sourceFormat,
  };
}

export function fromJwk(jwk: JsonWebKey, comment: string, sourceFormat: SourceFormat): PrivateKey {
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && jwk.d && jwk.x) {
    return ed25519Key(b64url(jwk.d), b64url(jwk.x), comment, sourceFormat);
  }
  if (jwk.kty === 'EC' && jwk.d && jwk.x && jwk.y) {
    const curve = Object.values(CURVES).find((c) => c.jwk === jwk.crv);
    if (!curve) throw new KeyFormatError('unsupported', `unsupported curve ${jwk.crv}`);
    const q = Buffer.concat([Buffer.from([4]), b64url(jwk.x), b64url(jwk.y)]);
    return ecdsaKey(curve.name, q, b64url(jwk.d), comment, sourceFormat);
  }
  if (jwk.kty === 'RSA' && jwk.n && jwk.e && jwk.d && jwk.p && jwk.q && jwk.qi) {
    return rsaKey(
      { n: b64url(jwk.n), e: b64url(jwk.e), d: b64url(jwk.d), p: b64url(jwk.p), q: b64url(jwk.q), iqmp: b64url(jwk.qi) },
      comment,
      sourceFormat,
    );
  }
  throw new KeyFormatError('unsupported', `unsupported key type ${jwk.kty}/${jwk.crv ?? ''}`);
}

/**
 * Reads the key-specific private fields for `type` from an OpenSSH private section and returns the
 * key in normalized form.
 */
export function readOpenSshFields(type: string, r: WireReader): Omit<PrivateKey, 'comment' | 'sourceFormat'> {
  const sub = (): Buffer => r.string();
  let key: Omit<PrivateKey, 'comment' | 'sourceFormat'>;
  switch (type) {
    case 'ssh-ed25519': {
      const pub = sub();
      const priv = sub();
      const k = ed25519Key(priv.subarray(0, 32), pub, '', 'openssh');
      key = { type: k.type, publicBlob: k.publicBlob, privateFields: k.privateFields, bits: k.bits };
      break;
    }
    case 'ecdsa-sha2-nistp256':
    case 'ecdsa-sha2-nistp384':
    case 'ecdsa-sha2-nistp521': {
      const curve = sub().toString('ascii');
      const q = sub();
      const d = r.mpint();
      const k = ecdsaKey(curve, q, d, '', 'openssh');
      if (k.type !== type) throw new KeyFormatError('invalid', 'curve does not match key type');
      key = { type: k.type, publicBlob: k.publicBlob, privateFields: k.privateFields, bits: k.bits };
      break;
    }
    case 'ssh-rsa': {
      const n = r.mpint();
      const e = r.mpint();
      const d = r.mpint();
      const iqmp = r.mpint();
      const p = r.mpint();
      const q = r.mpint();
      const k = rsaKey({ n, e, d, p, q, iqmp }, '', 'openssh');
      key = { type: k.type, publicBlob: k.publicBlob, privateFields: k.privateFields, bits: k.bits };
      break;
    }
    default:
      throw new KeyFormatError('unsupported', `unsupported key type ${type}`);
  }
  return key;
}
