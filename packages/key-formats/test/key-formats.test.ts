import { execFileSync } from 'node:child_process';
import { createPublicKey, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utils } from 'ssh2';
import { describe, expect, it } from 'vitest';
import {
  KeyFormatError,
  detectFormat,
  entryMatches,
  fingerprint,
  generateKey,
  hashHostName,
  hostKeyName,
  isEncrypted,
  parseKnownHosts,
  parsePrivateKey,
  parsePublicKeyLine,
  publicKeyLine,
  writeOpenSshPrivate,
  type PrivateKey,
} from '../src';
import { WireReader } from '../src/wire';

const FIX = join(__dirname, 'fixtures');
const read = (f: string) => readFileSync(join(FIX, f), 'utf8');
const PASS = 'test-pass';

/** Expected fingerprint from the matching .pub written by ssh-keygen. */
const expectedFp = (pubFile: string) => fingerprint(parsePublicKeyLine(read(pubFile)).publicBlob);

/**
 * Same private key? RSA files may legitimately order p/q differently (PuTTY keeps p > q), so for
 * RSA compare n, e and d; other types must match byte for byte.
 */
function sameKey(a: PrivateKey, b: PrivateKey): boolean {
  if (a.type !== 'ssh-rsa') return a.privateFields.equals(b.privateFields);
  const ra = new WireReader(a.privateFields);
  const rb = new WireReader(b.privateFields);
  return [0, 1, 2].every(() => ra.mpint().equals(rb.mpint()));
}

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof KeyFormatError && e.code === code);
}

const hasSshKeygen = (() => {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return (e as { status?: number }).status !== undefined && (e as { code?: string }).code !== 'ENOENT';
  }
})();

describe('OpenSSH private keys', () => {
  for (const n of ['ed25519', 'ecdsa256', 'ecdsa384', 'ecdsa521', 'rsa2048']) {
    it(`parses ${n} (plain and encrypted)`, async () => {
      const plain = await parsePrivateKey(read(`openssh-${n}`));
      expect(fingerprint(plain.publicBlob)).toBe(expectedFp(`openssh-${n}.pub`));
      expect(plain.comment).toBe(`cy-test-${n}`);
      expect(isEncrypted(read(`openssh-${n}`))).toBe(false);

      const encText = read(`openssh-${n}-enc`);
      expect(isEncrypted(encText)).toBe(true);
      await expectCode(parsePrivateKey(encText), 'passphrase_required');
      await expectCode(parsePrivateKey(encText, 'wrong'), 'bad_passphrase');
      const enc = await parsePrivateKey(encText, PASS);
      expect(fingerprint(enc.publicBlob)).toBe(expectedFp(`openssh-${n}-enc.pub`));
    });
  }

  it('reports bit sizes', async () => {
    expect((await parsePrivateKey(read('openssh-rsa2048'))).bits).toBe(2048);
    expect((await parsePrivateKey(read('openssh-ecdsa521'))).bits).toBe(521);
    expect((await parsePrivateKey(read('openssh-ed25519'))).bits).toBe(256);
  });
});

describe('PEM / PKCS#8', () => {
  it('parses PKCS#1 RSA, SEC1 EC and PKCS#8 keys', async () => {
    expect(fingerprint((await parsePrivateKey(read('pem-rsa'))).publicBlob)).toBe(expectedFp('pem-rsa.pub'));
    expect(fingerprint((await parsePrivateKey(read('pem-ecdsa256'))).publicBlob)).toBe(expectedFp('pem-ecdsa256.pub'));
    expect(fingerprint((await parsePrivateKey(read('pkcs8-rsa'))).publicBlob)).toBe(expectedFp('pkcs8-rsa.pub'));
    const ed = await parsePrivateKey(read('pkcs8-ed25519'));
    const raw = createPublicKey(read('pkcs8-ed25519')).export({ format: 'jwk' });
    expect(ed.type).toBe('ssh-ed25519');
    expect(ed.publicBlob.subarray(-32).equals(Buffer.from(raw.x!, 'base64url'))).toBe(true);
  });

  it('handles encrypted PEM and PKCS#8', async () => {
    for (const f of ['pem-rsa-enc', 'pkcs8-rsa-enc']) {
      expect(isEncrypted(read(f))).toBe(true);
      await expectCode(parsePrivateKey(read(f)), 'passphrase_required');
      await expectCode(parsePrivateKey(read(f), 'wrong'), 'bad_passphrase');
    }
    expect(fingerprint((await parsePrivateKey(read('pem-rsa-enc'), PASS)).publicBlob)).toBe(expectedFp('pem-rsa-enc.pub'));
    expect(fingerprint((await parsePrivateKey(read('pkcs8-rsa-enc'), PASS)).publicBlob)).toBe(expectedFp('pkcs8-rsa.pub'));
  });
});

describe('PuTTY .ppk', () => {
  for (const v of ['2', '3']) {
    for (const n of ['ed25519', 'ecdsa256', 'ecdsa384', 'rsa2048']) {
      it(`parses PPK v${v} ${n} (plain and encrypted)`, async () => {
        const plain = await parsePrivateKey(read(`ppk${v}-${n}.ppk`));
        expect(plain.sourceFormat).toBe(`ppk${v}`);
        expect(fingerprint(plain.publicBlob)).toBe(expectedFp(`openssh-${n}.pub`));
        expect(plain.comment).toBe(`cy-test-${n}`);

        const enc = read(`ppk${v}-${n}-enc.ppk`);
        expect(isEncrypted(enc)).toBe(true);
        await expectCode(parsePrivateKey(enc), 'passphrase_required');
        await expectCode(parsePrivateKey(enc, 'wrong'), 'bad_passphrase');
        const k = await parsePrivateKey(enc, PASS);
        // The decrypted private key must be identical to the OpenSSH original.
        const orig = await parsePrivateKey(read(`openssh-${n}`));
        expect(sameKey(k, orig)).toBe(true);
      });
    }
  }

  it('supports Argon2i and Argon2d key derivation', async () => {
    for (const f of ['ppk3-ed25519-argon2i.ppk', 'ppk3-ed25519-argon2d.ppk']) {
      const k = await parsePrivateKey(read(f), PASS);
      expect(fingerprint(k.publicBlob)).toBe(expectedFp('openssh-ed25519.pub'));
    }
  });

  it('detects tampering via the MAC', async () => {
    const text = read('ppk3-ed25519.ppk').replace(/Comment: .*/, 'Comment: evil');
    await expectCode(parsePrivateKey(text), 'integrity');
  });
});

describe('writing OpenSSH keys', () => {
  it('round-trips every fixture through the writer, plain and encrypted', async () => {
    for (const f of ['openssh-ed25519', 'openssh-ecdsa384', 'openssh-rsa2048', 'ppk3-ecdsa256.ppk', 'pem-rsa']) {
      const k = await parsePrivateKey(read(f));
      const plain = await parsePrivateKey(writeOpenSshPrivate(k));
      expect(plain.privateFields.equals(k.privateFields)).toBe(true);
      const enc = writeOpenSshPrivate(k, 'pw', 4);
      expect(isEncrypted(enc)).toBe(true);
      expect((await parsePrivateKey(enc, 'pw')).publicBlob.equals(k.publicBlob)).toBe(true);
    }
  });

  it('produces keys that ssh2 accepts', async () => {
    for (const f of ['openssh-ed25519', 'openssh-ecdsa256', 'pem-rsa', 'ppk2-rsa2048.ppk']) {
      const k = await parsePrivateKey(read(f));
      const parsed = utils.parseKey(writeOpenSshPrivate(k));
      expect(parsed).not.toBeInstanceOf(Error);
      const one = Array.isArray(parsed) ? parsed[0]! : (parsed as Exclude<typeof parsed, Error | unknown[]>);
      expect(one.getPublicSSH().equals(k.publicBlob)).toBe(true);
      // A signature made by ssh2 with our serialized key must verify against the public key.
      const data = randomBytes(32);
      expect(one.verify(data, one.sign(data))).toBe(true);
    }
  });

  it.skipIf(!hasSshKeygen)('produces keys (incl. encrypted) that ssh-keygen reads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cy-kf-'));
    for (const spec of [{ algorithm: 'ed25519' }, { algorithm: 'ecdsa', bits: 384 }, { algorithm: 'rsa', bits: 2048 }] as const) {
      const k = generateKey(spec, 'generated');
      const plainPath = join(dir, `${spec.algorithm}-plain`);
      const encPath = join(dir, `${spec.algorithm}-enc`);
      writeFileSync(plainPath, writeOpenSshPrivate(k), { mode: 0o600 });
      writeFileSync(encPath, writeOpenSshPrivate(k, 'secret-pw'), { mode: 0o600 });
      const expected = publicKeyLine({ ...k, comment: '' });
      expect(execFileSync('ssh-keygen', ['-y', '-f', plainPath], { encoding: 'utf8' }).trim().split(' ').slice(0, 2).join(' ')).toBe(expected);
      expect(execFileSync('ssh-keygen', ['-y', '-P', 'secret-pw', '-f', encPath], { encoding: 'utf8' }).trim().split(' ').slice(0, 2).join(' ')).toBe(expected);
    }
  });
});

describe('generateKey', () => {
  it('generates every supported type with correct sizes', () => {
    expect(generateKey({ algorithm: 'ed25519' }).type).toBe('ssh-ed25519');
    expect(generateKey({ algorithm: 'ecdsa', bits: 521 })).toMatchObject({ type: 'ecdsa-sha2-nistp521', bits: 521 });
    expect(generateKey({ algorithm: 'rsa', bits: 3072 })).toMatchObject({ type: 'ssh-rsa', bits: 3072 });
  });
});

describe('format detection and errors', () => {
  it('detects formats and rejects junk', async () => {
    expect(detectFormat(read('openssh-ed25519'))).toBe('openssh');
    expect(detectFormat(read('ppk2-rsa2048.ppk'))).toBe('ppk');
    expect(detectFormat(read('pkcs8-rsa'))).toBe('pem');
    expect(detectFormat('hello')).toBe('unknown');
    await expectCode(parsePrivateKey('hello'), 'unsupported');
    await expectCode(parsePrivateKey('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----'), 'invalid');
  });
});

describe('known_hosts', () => {
  it('parses plain, ported, marker and comment lines', () => {
    const entries = parseKnownHosts(read('known_hosts'));
    expect(entries).toHaveLength(3);
    expect(entries[0]!.patterns).toEqual(['example.com', '192.0.2.10']);
    expect(entries[2]!.marker).toBe('@revoked');
    expect(entryMatches(entries[0]!, hostKeyName('example.com', 22))).toBe(true);
    expect(entryMatches(entries[0]!, hostKeyName('example.com', 2222))).toBe(false);
    expect(entryMatches(entries[1]!, hostKeyName('git.example.com', 2222))).toBe(true);
  });

  it('matches hashed entries', () => {
    const entries = parseKnownHosts(read('known_hosts_hashed'));
    expect(entries.every((e) => e.hashed)).toBe(true);
    expect(entries.some((e) => entryMatches(e, 'example.com'))).toBe(true);
    expect(entries.some((e) => entryMatches(e, '[git.example.com]:2222'))).toBe(true);
    expect(entries.some((e) => entryMatches(e, 'other.com'))).toBe(false);
    const salt = randomBytes(20);
    const [e] = parseKnownHosts(`${hashHostName('h.example', salt)} ${read('openssh-ed25519.pub').split(' ').slice(0, 2).join(' ')}`);
    expect(entryMatches(e!, 'h.example')).toBe(true);
  });

  it('supports wildcards and negation', () => {
    const [e] = parseKnownHosts(`*.example.com,!bad.example.com ${read('openssh-ed25519.pub').split(' ').slice(0, 2).join(' ')}`);
    expect(entryMatches(e!, 'a.example.com')).toBe(true);
    expect(entryMatches(e!, 'bad.example.com')).toBe(false);
    expect(entryMatches(e!, 'example.org')).toBe(false);
  });
});
