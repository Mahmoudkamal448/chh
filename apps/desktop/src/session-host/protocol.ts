/**
 * Control protocol between the main process and the session host (utilityProcess).
 * Terminal bytes never travel on this channel — they use a per-session MessagePort that goes
 * straight to the renderer.
 */
import type { HostKeyDecision } from '@cy-ssh/shared';

export interface SshConnectConfig {
  host: string;
  port: number;
  username: string;
  /** Plaintext password, only if the user saved one. Lives in memory for the session only. */
  password: string | null;
  useAgent: boolean;
  tryDefaultKeys: boolean;
  keepAliveSec: number;
  connectTimeoutSec: number;
}

export type MainToHost =
  | { type: 'open-ssh'; sessionId: string; label: string; cols: number; rows: number; config: SshConnectConfig }
  | { type: 'open-local'; sessionId: string; cols: number; rows: number; shell: { path: string; args: string[] }; cwd: string }
  | { type: 'close'; sessionId: string }
  | { type: 'hostkey-result'; promptId: string; decision: HostKeyDecision }
  | { type: 'auth-result'; promptId: string; responses: string[] | null }
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
      kind: 'password' | 'keyboard-interactive' | 'username';
      title: string;
      instructions: string;
      prompts: Array<{ prompt: string; echo: boolean }>;
      retry: boolean;
    }
  | { type: 'status'; sessionId: string; status: 'connecting' | 'authenticating' | 'ready' | 'closed' | 'error'; message?: string }
  /** The password that just succeeded, so main can store it if the user ticked "remember". */
  | { type: 'auth-succeeded'; sessionId: string; password: string | null }
  | { type: 'closed'; sessionId: string };
