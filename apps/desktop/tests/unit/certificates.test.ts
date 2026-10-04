import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectChain, type ConnectCallbacks } from '../../src/session-host/ssh/connect';
import { sshConfig } from '../support/config';
import { startSshServer, type TestSshServer } from '../support/ssh-server';

// Certificates for user "tester", signed by fixtures/cert-ca (see packages/key-formats/test/fixtures).
const FIX = join(__dirname, '../../../../packages/key-formats/test/fixtures');
const read = (name: string) => readFileSync(join(FIX, name), 'utf8');
const cb = (): ConnectCallbacks => ({
  status: () => undefined,
  verifyHostKey: async () => true,
  requestAuth: async () => null,
  authSucceeded: () => undefined,
  isCancelled: () => false,
});

let server: TestSshServer;
let withKeyToo: TestSshServer;

beforeAll(async () => {
  // Trusts only the CA: no authorized_keys, no password.
  server = await startSshServer({ password: 'not-offered', trustedUserCAKeys: [read('cert-ca.pub')] });
  // Doesn't trust the CA, but has the plain key in authorized_keys.
  withKeyToo = await startSshServer({ authorizedKeys: [read('openssh-ed25519.pub')] });
});

afterAll(async () => {
  await server.close();
  await withKeyToo.close();
});

async function login(port: number, key: string, cert: string | null): Promise<boolean> {
  try {
    const client = await connectChain(sshConfig(port, { privateKey: read(key), certificate: cert && read(cert) }), cb());
    client.end();
    return true;
  } catch {
    return false;
  }
}

describe('SSH certificate authentication', () => {
  it.each([
    ['ed25519', 'openssh-ed25519'],
    ['ECDSA (signature conversion)', 'openssh-ecdsa256'],
    ['RSA (rsa-sha2 certificate algorithms)', 'openssh-rsa2048'],
  ])('logs in with an %s certificate the server checks like sshd', async (_name, key) => {
    const before = server.certificateLogins.length;
    const ok = await login(server.port, key, `${key}-tester-cert.pub`);
    expect(server.certificateLogins.slice(before)).toEqual(['ok']);
    expect(ok).toBe(true);
  });

  it('is refused for an expired certificate, an unknown CA or no certificate', async () => {
    expect(await login(server.port, 'openssh-ed25519', 'openssh-ed25519-tester-expired-cert.pub')).toBe(false);
    expect(await login(server.port, 'openssh-ed25519', 'openssh-ed25519-tester-otherca-cert.pub')).toBe(false);
    expect(await login(server.port, 'openssh-ed25519', null)).toBe(false);
  });

  it('falls back to the plain key when the server does not trust the CA', async () => {
    expect(await login(withKeyToo.port, 'openssh-ed25519', 'openssh-ed25519-tester-cert.pub')).toBe(true);
  });

  it('uses only the certificate when the plain key is not allowed', async () => {
    const attempt = (usePlainKey: boolean) =>
      connectChain(
        sshConfig(withKeyToo.port, { privateKey: read('openssh-ed25519'), certificate: read('openssh-ed25519-tester-cert.pub'), usePlainKey }),
        cb(),
      ).then((c) => (c.end(), true), () => false);
    expect(await attempt(true)).toBe(true);
    expect(await attempt(false)).toBe(false); // this server only knows the plain key
  });

  it('works on a jump host', async () => {
    const client = await connectChain(
      sshConfig(withKeyToo.port, {
        privateKey: read('openssh-ed25519'),
        jumps: [sshConfig(server.port, { privateKey: read('openssh-ed25519'), certificate: read('openssh-ed25519-tester-cert.pub'), label: 'bastion' })],
      }),
      cb(),
    );
    client.end();
  });
});
