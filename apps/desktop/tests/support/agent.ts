import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SSH2_AGENTC_REQUEST_IDENTITIES = 11;
const SSH2_AGENT_IDENTITIES_ANSWER = 12;
const SSH_AGENT_FAILURE = 5;

/**
 * A minimal SSH agent holding no keys, listening where ssh2 looks for one: a Unix socket, or a
 * named pipe on Windows (whose OpenSSH agent runs as a service and can't be started per test).
 */
export async function startFakeAgent(): Promise<{ path: string; close(): Promise<void> }> {
  const dir = process.platform === 'win32' ? null : mkdtempSync(join(tmpdir(), 'chh-agent-'));
  const path = dir ? join(dir, 'agent.sock') : `\\\\.\\pipe\\chh-test-agent-${randomBytes(6).toString('hex')}`;
  const server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('error', () => undefined);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const type = buf[4];
        buf = buf.subarray(4 + buf.readUInt32BE(0));
        // Identities: an empty list. Anything else (signing): failure, since we hold no keys.
        const reply = type === SSH2_AGENTC_REQUEST_IDENTITIES ? Buffer.from([0, 0, 0, 5, SSH2_AGENT_IDENTITIES_ANSWER, 0, 0, 0, 0]) : Buffer.from([0, 0, 0, 1, SSH_AGENT_FAILURE]);
        sock.write(reply);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
  return {
    path,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          if (dir) rmSync(dir, { recursive: true, force: true });
          resolve();
        }),
      ),
  };
}
