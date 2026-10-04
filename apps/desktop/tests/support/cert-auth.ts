import { utils } from 'ssh2';
import { parseCertificate, parsePublicKeyLine } from '@chh/key-formats';

/**
 * Checks a certificate login the way OpenSSH's sshd does (PROTOCOL.certkeys): the certificate is a user
 * certificate signed by a trusted CA, valid now and for this user; the signature is labelled with the plain
 * key's algorithm (not the certificate's) and verifies with the certified key. ssh2's own server can't do
 * this, so the test server uses it for "…-cert-v01@openssh.com" requests.
 */
export function verifyCertificateLogin(input: {
  trustedCAs: string[];
  username: string;
  keyAlgo: string;
  keyData: Buffer;
  /** Raw signature from the request ("string algo, string sig"), or undefined for a "would you accept?" query. */
  signature?: Buffer;
  signedBlob?: Buffer;
}): { ok: true } | { ok: false; reason: string } {
  let cert;
  try {
    // RSA certificates are requested as rsa-sha2-256/512-cert-v01; the blob itself says ssh-rsa-cert-v01.
    const certType = input.keyAlgo.replace(/^rsa-sha2-(256|512)-cert/, 'ssh-rsa-cert');
    cert = parseCertificate(`${certType} ${input.keyData.toString('base64')}`);
  } catch {
    return { ok: false, reason: 'malformed certificate' };
  }
  if (cert.kind !== 'user') return { ok: false, reason: 'not a user certificate' };
  const now = Date.now();
  if (now < cert.validAfter || (cert.validBefore !== null && now >= cert.validBefore)) return { ok: false, reason: 'expired' };
  if (cert.principals.length && !cert.principals.includes(input.username)) return { ok: false, reason: 'principal' };
  const ca = input.trustedCAs.map((l) => parsePublicKeyLine(l)).find((k) => k.publicBlob.equals(cert.caKey));
  if (!ca) return { ok: false, reason: 'untrusted CA' };
  const caKey = utils.parseKey(`${ca.type} ${ca.publicBlob.toString('base64')}`);
  if (caKey instanceof Error || Array.isArray(caKey) || ca.type !== 'ssh-ed25519') return { ok: false, reason: 'test CAs must be ed25519' };
  const caSig = splitSignature(cert.signature);
  if (!caSig || !caKey.verify(cert.signedData, caSig.sig)) return { ok: false, reason: 'bad CA signature' };
  if (!input.signature || !input.signedBlob) return { ok: true };

  // The signature: plain algorithm name, made by the certified key.
  const sig = splitSignature(input.signature);
  const expected = input.keyAlgo.slice(0, -'-cert-v01@openssh.com'.length);
  if (!sig || sig.algo !== expected) return { ok: false, reason: `signature labelled ${sig?.algo}, expected ${expected}` };
  const userKey = utils.parseKey(`${cert.keyType} ${cert.publicBlob.toString('base64')}`);
  if (userKey instanceof Error || Array.isArray(userKey)) return { ok: false, reason: 'bad certified key' };
  const hash = expected === 'rsa-sha2-256' ? 'sha256' : expected === 'rsa-sha2-512' ? 'sha512' : undefined;
  const raw = cert.keyType.startsWith('ecdsa-') ? ecdsaSshToDer(sig.sig) : sig.sig;
  return userKey.verify(input.signedBlob, raw, hash) ? { ok: true } : { ok: false, reason: 'bad signature' };
}

function splitSignature(buf: Buffer): { algo: string; sig: Buffer } | null {
  if (buf.length < 8) return null;
  const algoLen = buf.readUInt32BE(0);
  const algo = buf.subarray(4, 4 + algoLen).toString();
  const sigLen = buf.readUInt32BE(4 + algoLen);
  return { algo, sig: buf.subarray(8 + algoLen, 8 + algoLen + sigLen) };
}

/** SSH ECDSA signature (string mpint r, string mpint s) → DER, which ssh2's verify() expects. */
function ecdsaSshToDer(sig: Buffer): Buffer {
  const rLen = sig.readUInt32BE(0);
  const r = sig.subarray(4, 4 + rLen);
  const s = sig.subarray(8 + rLen, 8 + rLen + sig.readUInt32BE(4 + rLen));
  const int = (b: Buffer) => {
    let v = b;
    while (v.length > 1 && v[0] === 0 && !(v[1]! & 0x80)) v = v.subarray(1);
    if (v[0]! & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  };
  const body = Buffer.concat([int(r), int(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}
