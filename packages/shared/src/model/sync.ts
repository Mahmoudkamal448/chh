import { z } from 'zod';

export const SyncStatusSchema = z.object({
  signedIn: z.boolean(),
  serverUrl: z.string().nullable(),
  email: z.string().nullable(),
  state: z.enum(['off', 'idle', 'syncing', 'offline', 'error']),
  lastSyncAt: z.number().nullable(),
  /** i18n key of the last error. */
  error: z.string().optional(),
  totpEnabled: z.boolean(),
  /** Local changes not yet uploaded. */
  pending: z.number(),
});
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

export const LockMethodSchema = z.enum(['passcode', 'biometric']);

/** App lock configuration (device-local). */
export const LockSettingsSchema = z.object({
  /** UI lock: a passcode (and optionally Touch ID / Windows Hello) is required to see the app. */
  enabled: z.boolean(),
  biometric: z.boolean(),
  /** Lock after this many minutes without any keyboard/mouse input on this computer (0 = never). */
  autoLockMinutes: z.number().int().min(0).max(24 * 60),
  /** Lock when the computer sleeps or its screen locks. */
  lockOnSleep: z.boolean(),
});
export type LockSettings = z.infer<typeof LockSettingsSchema>;

export const DEFAULT_LOCK_SETTINGS: LockSettings = { enabled: false, biometric: false, autoLockMinutes: 15, lockOnSleep: true };

export const LockStateSchema = z.object({
  /** "startup": the database is still encrypted with the master password and not open yet. */
  locked: z.enum(['no', 'idle', 'startup']),
  settings: LockSettingsSchema,
  /** A master password protects the local database key at rest. */
  masterPassword: z.boolean(),
  biometricAvailable: z.enum(['touchid', 'windows-hello', 'none']),
  /** Seconds the UI must wait before the next attempt (after repeated failures). */
  retryAfter: z.number(),
});
export type LockState = z.infer<typeof LockStateSchema>;
