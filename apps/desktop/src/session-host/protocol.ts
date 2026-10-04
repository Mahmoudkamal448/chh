/**
 * Control protocol between the main process and the session host (utilityProcess).
 * Terminal bytes never travel on this channel — they use a per-session MessagePort that goes
 * straight to the renderer.
 */
import type { HostKeyDecision, Transfer } from '@cy-ssh/shared';

export interface SshConnectConfig {
  host: string;
  port: number;
  username: string;
  /** Plaintext password, only if the user saved one. Lives in memory for the session only. */
  password: string | null;
  /** Unencrypted OpenSSH private key from the vault, tried first. */
  privateKey: string | null;
  useAgent: boolean;
  tryDefaultKeys: boolean;
  keepAliveSec: number;
  connectTimeoutSec: number;
}

export type RpcMethod =
  | 'sftp.open'
  | 'fs.home'
  | 'fs.list'
  | 'fs.mkdir'
  | 'fs.rename'
  | 'fs.remove'
  | 'fs.chmod'
  | 'fs.existing'
  | 'transfer.start'
  | 'transfer.cancel';

/** RPC failures carry an i18n key ("files.error.not_found", "session.error.auth", ...) plus detail. */
export interface RpcError {
  key: string;
  detail?: string;
}

export type MainToHost =
  | { type: 'open-ssh'; sessionId: string; label: string; cols: number; rows: number; config: SshConnectConfig }
  | { type: 'open-local'; sessionId: string; cols: number; rows: number; shell: { path: string; args: string[] }; cwd: string }
  | { type: 'close'; sessionId: string }
  | { type: 'hostkey-result'; promptId: string; decision: HostKeyDecision }
  | { type: 'auth-result'; promptId: string; responses: string[] | null }
  | { type: 'rpc'; id: number; method: RpcMethod; params: Record<string, unknown> }
  | { type: 'shutdown' };

export type HostToMain =
  | { type: 'ready' }
  | {
      type: 'hostkey-check';
      sessionId: string;
      promptId: string;
      hostPattern: string;
      keyType: string;
      fingerprint: string;
      publicKey: string;
    }
  | {
      type: 'auth-prompt';
      sessionId: string;
      promptId: string;
      kind: 'password' | 'keyboard-interactive' | 'username' | 'passphrase';
      title: string;
      instructions: string;
      prompts: Array<{ prompt: string; echo: boolean }>;
      retry: boolean;
    }
  | { type: 'status'; sessionId: string; status: 'connecting' | 'authenticating' | 'ready' | 'closed' | 'error'; message?: string }
  /** The password that just succeeded, so main can store it if the user ticked "remember". */
  | { type: 'auth-succeeded'; sessionId: string; password: string | null }
  | { type: 'closed'; sessionId: string }
  | { type: 'rpc-result'; id: number; ok: true; value: unknown }
  | { type: 'rpc-result'; id: number; ok: false; error: RpcError }
  | { type: 'transfer'; transfer: Transfer };
