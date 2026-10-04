import { fingerprint } from './public';
import { KeyFormatError, isKeyType, type KeyType } from './types';
import { WireReader, WireWriter } from './wire';

const CERT_SUFFIX = '-cert-v01@openssh.com';

/** An OpenSSH certificate (PROTOCOL.certkeys), as found in "id_ed25519-cert.pub". */
export interface CertificateInfo {
  /** Certificate algorithm, e.g. "ssh-ed25519-cert-v01@openssh.com". */
  certType: string;
  /** Algorithm of the certified key, e.g. "ssh-ed25519". */
  keyType: KeyType;
  /** Wire blob of the certified public key (what the private key it belongs to has). */
  publicBlob: Buffer;
  /** The whole certificate blob, sent as the public key when authenticating. */
  blob: Buffer;
  kind: 'user' | 'host';
  serial: string;
  keyId: string;
  /** Empty means valid for any principal. */
  principals: string[];
  /** Milliseconds since the epoch. */
  validAfter: number;
  /** Milliseconds since the epoch; null means it never expires. */
  validBefore: number | null;
  criticalOptions: string[];
  extensions: string[];
  /** SHA256 fingerprint of the CA key that signed it. */
  caFingerprint: string;
  /** Wire blob of the CA key, the bytes it signed and its signature (string algo + string sig). */
  caKey: Buffer;
  signedData: Buffer;
  signature: Buffer;
  comment: string;
}

export function isCertificateType(type: string): boolean {
  return type.endsWith(CERT_SUFFIX) && isKeyType(type.slice(0, -CERT_SUFFIX.length));
}

/** Parses a "ssh-ed25519-cert-v01@openssh.com AAAA… comment" line. */
export function parseCertificate(line: string): CertificateInfo {
  const [certType, b64, ...rest] = line.trim().split(/\s+/);
  if (!certType || !b64 || !isCertificateType(certType)) throw new KeyFormatError('cert_invalid', 'not an OpenSSH certificate');
  const blob = Buffer.from(b64, 'base64');
  const keyType = certType.slice(0, -CERT_SUFFIX.length) as KeyType;
  try {
    const r = new WireReader(blob);
    if (r.text() !== certType) throw new Error('certificate type mismatch');
    r.string(); // nonce
    const pub = new WireWriter().string(keyType);
    const fields = keyType === 'ssh-rsa' ? 2 : keyType === 'ssh-ed25519' ? 1 : 2; // rsa: e, n; ecdsa: curve, Q
    for (let i = 0; i < fields; i++) pub.string(r.string());
    const serial = uint64(r);
    const kindCode = r.uint32();
    const keyId = r.text();
    const principals = strings(r.string());
    const validAfter = uint64(r);
    const validBefore = uint64(r);
    const criticalOptions = names(r.string());
    const extensions = names(r.string());
    r.string(); // reserved
    const caKey = r.string();
    const signedData = blob.subarray(0, blob.length - r.remaining);
    const signature = r.string();
    if (kindCode !== 1 && kindCode !== 2) throw new Error('unknown certificate type');
    return {
      certType,
      keyType,
      publicBlob: pub.toBuffer(),
      blob,
      kind: kindCode === 1 ? 'user' : 'host',
      serial: serial.toString(),
      keyId,
      principals,
      validAfter: toMs(validAfter) ?? 0,
      validBefore: toMs(validBefore),
      criticalOptions,
      extensions,
      caFingerprint: fingerprint(caKey),
      caKey,
      signedData,
      signature,
      comment: rest.join(' '),
    };
  } catch (err) {
    throw new KeyFormatError('cert_invalid', `malformed certificate: ${(err as Error).message}`);
  }
}

function uint64(r: WireReader): bigint {
  return r.bytes(8).readBigUInt64BE();
}

/** Seconds → milliseconds; the all-ones value means "forever". */
function toMs(seconds: bigint): number | null {
  if (seconds === 0xffffffffffffffffn) return null;
  return Number(seconds) * 1000;
}

function strings(buf: Buffer): string[] {
  const r = new WireReader(buf);
  const out: string[] = [];
  while (r.remaining > 0) out.push(r.text());
  return out;
}

/** Option/extension lists are name + data pairs; only the names are interesting here. */
function names(buf: Buffer): string[] {
  const r = new WireReader(buf);
  const out: string[] = [];
  while (r.remaining > 0) {
    out.push(r.text());
    r.string();
  }
  return out;
}
