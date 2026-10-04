import { z } from 'zod';
import { IdSchema } from './common';

export const SessionStatusSchema = z.enum(['connecting', 'authenticating', 'ready', 'closed', 'error']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const LocalShellSchema = z.object({
  id: z.string(),
  label: z.string(),
  path: z.string(),
  args: z.array(z.string()),
});
export type LocalShell = z.infer<typeof LocalShellSchema>;

export const HostKeyPromptSchema = z.object({
  promptId: IdSchema,
  sessionId: IdSchema,
  hostLabel: z.string(),
  hostPattern: z.string(),
  keyType: z.string(),
  fingerprint: z.string(),
  /** Present when we already know a different key for this host — a possible MITM. */
  previousFingerprint: z.string().nullable(),
  previousKeyType: z.string().nullable(),
});
export type HostKeyPrompt = z.infer<typeof HostKeyPromptSchema>;

export const HostKeyDecisionSchema = z.enum(['accept-save', 'accept-once', 'reject']);
export type HostKeyDecision = z.infer<typeof HostKeyDecisionSchema>;

export const AuthPromptSchema = z.object({
  promptId: IdSchema,
  sessionId: IdSchema,
  hostLabel: z.string(),
  kind: z.enum(['password', 'keyboard-interactive', 'username']),
  title: z.string(),
  instructions: z.string(),
  prompts: z.array(z.object({ prompt: z.string(), echo: z.boolean() })),
  /** Offer "remember password" (only for plain password prompts on saved hosts). */
  canSave: z.boolean(),
  /** Set after a failed attempt so the UI can say "try again". */
  retry: z.boolean(),
});
export type AuthPrompt = z.infer<typeof AuthPromptSchema>;

/** Messages exchanged on a session's MessagePort (renderer <-> session host). */
export type PortToHost =
  | { t: 'in'; d: string }
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'ack'; n: number };

export type PortToRenderer =
  | { t: 'out'; d: string | Uint8Array }
  | { t: 'status'; s: SessionStatus; msg?: string }
  | { t: 'exit'; code: number | null };
