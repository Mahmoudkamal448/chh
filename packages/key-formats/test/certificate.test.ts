import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KeyFormatError, fingerprint, isCertificateType, parseCertificate, parsePublicKeyLine } from '../src';

// Certificates made with: ssh-keygen -s cert-ca -I <key>-id -n alice,deploy -z 42 -V 20200101:20991231 <key>.pub
const FIX = join(__dirname, 'fixtures');
const read = (name: string) => readFileSync(join(FIX, name), 'utf8');

describe('OpenSSH certificates', () => {
  it.each([
    ['openssh-ed25519', 'ssh-ed25519'],
    ['openssh-ecdsa256', 'ecdsa-sha2-nistp256'],
    ['openssh-rsa2048', 'ssh-rsa'],
  ])('parses a %s user certificate and links it to its key', (name, keyType) => {
    const cert = parseCertificate(read(`${name}-cert.pub`));
    expect(cert).toMatchObject({
      certType: `${keyType}-cert-v01@openssh.com`,
      keyType,
      kind: 'user',
      serial: '42',
      keyId: `${name}-id`,
      principals: ['alice', 'deploy'],
      criticalOptions: [],
    });
    expect(cert.extensions).toContain('permit-pty');
    expect(cert.publicBlob.equals(parsePublicKeyLine(read(`${name}.pub`)).publicBlob)).toBe(true);
    expect(cert.caFingerprint).toBe(fingerprint(parsePublicKeyLine(read('cert-ca.pub')).publicBlob));
    expect(cert.blob.toString('base64')).toBe(read(`${name}-cert.pub`).split(/\s+/)[1]);
  });

  it('reads validity periods, including "forever"', () => {
    const cert = parseCertificate(read('openssh-ed25519-cert.pub'));
    // ssh-keygen interprets the dates in the local time zone, so allow a day either way.
    expect(Math.abs(cert.validAfter - Date.UTC(2020, 0, 1))).toBeLessThanOrEqual(86_400_000);
    expect(Math.abs(cert.validBefore! - Date.UTC(2099, 11, 31))).toBeLessThanOrEqual(86_400_000);
    expect(parseCertificate(read('openssh-ed25519-expired-cert.pub')).validBefore).toBeLessThan(Date.now());
    const forever = parseCertificate(read('openssh-ed25519-forever-cert.pub'));
    expect(forever).toMatchObject({ validAfter: 0, validBefore: null, principals: [] });
  });

  it('rejects things that are not certificates', () => {
    expect(isCertificateType('ssh-ed25519-cert-v01@openssh.com')).toBe(true);
    expect(isCertificateType('ssh-ed25519')).toBe(false);
    expect(() => parseCertificate(read('openssh-ed25519.pub'))).toThrow(KeyFormatError);
    const line = read('openssh-ed25519-cert.pub').split(/\s+/);
    const truncated = Buffer.from(line[1]!, 'base64').subarray(0, 60).toString('base64');
    expect(() => parseCertificate(`${line[0]} ${truncated}`)).toThrow(/malformed certificate/);
  });
});
