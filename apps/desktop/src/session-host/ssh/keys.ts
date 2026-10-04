import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { utils } from 'ssh2';

/** Same default identity files OpenSSH tries, in its order. */
const DEFAULT_KEY_FILES = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

export interface DefaultKey {
  name: string;
  data: Buffer;
  /** Passphrase-protected: needs a prompt before use. */
  encrypted: boolean;
}

/** Loads ~/.ssh default private keys; unreadable or unsupported files are skipped. */
export async function loadDefaultKeys(): Promise<DefaultKey[]> {
  const out: DefaultKey[] = [];
  for (const name of DEFAULT_KEY_FILES) {
    try {
      const data = await readFile(join(homedir(), '.ssh', name));
      const parsed = utils.parseKey(data);
      if (parsed instanceof Error) {
        if (/encrypted|passphrase/i.test(parsed.message)) out.push({ name, data, encrypted: true });
        continue;
      }
      out.push({ name, data, encrypted: false });
    } catch {
      // missing or unreadable — skip
    }
  }
  return out;
}

/** True if the passphrase decrypts the key. */
export function keyAcceptsPassphrase(data: Buffer, passphrase: string): boolean {
  return !(utils.parseKey(data, passphrase) instanceof Error);
}

/** Path of the system SSH agent, if one is reachable. */
export function systemAgentPath(): string | null {
  if (process.platform === 'win32') {
    // Prefer an explicit socket, then the Windows OpenSSH agent service pipe.
    return process.env.SSH_AUTH_SOCK || '\\\\.\\pipe\\openssh-ssh-agent';
  }
  return process.env.SSH_AUTH_SOCK || null;
}
