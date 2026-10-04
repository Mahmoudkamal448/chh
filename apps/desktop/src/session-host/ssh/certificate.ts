import { utils, type ParsedKey } from 'ssh2';

/**
 * Builds the key object that makes ssh2 log in with an OpenSSH certificate: it signs with the private key
 * but presents the certificate (algorithm "…-cert-v01@openssh.com" and the certificate blob) instead of
 * the bare public key. ssh2 (patched, see patches/ssh2@1.17.0.patch) labels the signature with the plain
 * algorithm as PROTOCOL.certkeys requires. Returns null if the key or certificate can't be used.
 */
export function withCertificate(privateKey: string | Buffer, certificate: string, passphrase?: string): ParsedKey | null {
  const parsed = utils.parseKey(privateKey, passphrase);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) return null;
  const [certType, b64] = certificate.trim().split(/\s+/);
  if (!certType?.endsWith('-cert-v01@openssh.com') || !b64) return null;
  if (certType.slice(0, -'-cert-v01@openssh.com'.length) !== key.type) return null;
  const blob = Buffer.from(b64, 'base64');
  // Inherit from the parsed key: ssh2 recognises it as a parsed key and sign() uses the private key.
  const cert = Object.create(key) as ParsedKey;
  Object.defineProperty(cert, 'type', { value: certType });
  Object.defineProperty(cert, 'getPublicSSH', { value: () => blob });
  return cert;
}
