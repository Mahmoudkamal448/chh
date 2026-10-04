import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { utils } from 'ssh2';

/** Same default identity files OpenSSH tries, in its order. */
const DEFAULT_KEY_FILES = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

/**
 * Load unencrypted default private keys from ~/.ssh. Passphrase-protected keys are skipped here
 * (Phase 2 adds the key manager with passphrase prompts); the system agent covers them meanwhile.
 */
export async function loadDefaultKeys(): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const name of DEFAULT_KEY_FILES) {
    try {
      const data = await readFile(join(homedir(), '.ssh', name));
      const parsed = utils.parseKey(data);
      if (parsed instanceof Error) continue;
      out.push(data);
    } catch {
      // missing or unreadable — skip
    }
  }
  return out;
}

/** Path of the system SSH agent, if one is reachable. */
export function systemAgentPath(): string | null {
  if (process.platform === 'win32') {
    // Prefer an explicit socket, then the Windows OpenSSH agent service pipe.
    return process.env.SSH_AUTH_SOCK || '\\\\.\\pipe\\openssh-ssh-agent';
  }
  return process.env.SSH_AUTH_SOCK || null;
}
