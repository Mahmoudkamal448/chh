/**
 * Control protocol between the main process and the session host (utilityProcess).
 * Terminal bytes never travel on this channel — they use a per-session MessagePort that goes
 * straight to the renderer.
 */
import type { ForwardStatus, HostKeyDecision, ProxyConfig, RunHostStatus, RunOutput, SerialSettings, Transfer } from '@chh/shared';

export interface SshConnectConfig {
  host: string;
  port: number;
  username: string;
  /** Plaintext password, only if the user saved one. Lives in memory for the session only. */
  password: string | null;
  /** Unencrypted OpenSSH private key from the vault, tried first. */
  privateKey: string | null;
  /** OpenSSH certificate for `privateKey` ("…-cert.pub" line): tried before the plain key. */
  certificate?: string | null;
  /** Also log in with `privateKey` itself (default true); false when only its certificate may be used. */
  usePlainKey?: boolean;
  useAgent: boolean;
  tryDefaultKeys: boolean;
  keepAliveSec: number;
  connectTimeoutSec: number;
  /** Shown in prompts so the user knows which hop is asking. */
  label: string;
  /** Agent: "" = system default, "pageant", or a socket/pipe path. */
  agent: string;
  agentForward: boolean;
  /** Jump hosts, nearest first (each a complete config of its own; their own jumps are ignored). */
  jumps: SshConnectConfig[];
  /** Proxy for the first hop. */
  proxy: ProxyConfig | null;
  env: Record<string, string>;
  envMethod: 'request' | 'export';
}

/** How to run mosh-client locally (direct, or through WSL on Windows). */
export interface MoshClientSpec {
  path: string;
  args: string[];
  env: Record<string, string>;
}

export type RpcMethod =
  | 'exec.start'
  | 'exec.cancel'
  | 'forward.start'
  | 'forward.stop'
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
  | { type: 'open-telnet'; sessionId: string; cols: number; rows: number; host: string; port: number; connectTimeoutSec: number }
  | {
      type: 'open-mosh';
      sessionId: string;
      cols: number;
      rows: number;
      config: SshConnectConfig;
      moshServer: string;
      client: MoshClientSpec;
    }
  | { type: 'open-serial'; sessionId: string; path: string; settings: SerialSettings }
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
      kind: 'password' | 'keyboard-interactive' | 'username' | 'passphrase' | 'proxy';
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
  | { type: 'transfer'; transfer: Transfer }
  | { type: 'forward'; status: ForwardStatus }
  /** OS detected after an SSH shell started (e.g. "ubuntu", "debian", "macos"). */
  | { type: 'os-detected'; sessionId: string; os: string }
  | { type: 'run-status'; status: RunHostStatus }
  | { type: 'run-output'; output: RunOutput };
