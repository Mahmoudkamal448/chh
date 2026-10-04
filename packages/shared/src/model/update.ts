import { z } from 'zod';

export const UpdateStatusSchema = z.object({
  /** False when this build can't update itself; `reason` says why. */
  supported: z.boolean(),
  /**
   * dev: not a packaged build. package: installed from a .deb/.rpm (use your package manager).
   * unsigned: an unsigned macOS build (Squirrel.Mac only installs signed updates).
   * disabled: turned off with CHH_DISABLE_UPDATES.
   */
  reason: z.enum(['dev', 'package', 'unsigned', 'disabled']).optional(),
  state: z.enum(['idle', 'checking', 'available', 'not-available', 'downloading', 'downloaded', 'error']),
  currentVersion: z.string(),
  /** The newer version found, if any. */
  version: z.string().nullable(),
  releaseNotes: z.string().nullable(),
  /** Download progress 0–100 while downloading. */
  progress: z.number().nullable(),
  /** i18n key. */
  error: z.string().optional(),
  lastCheckedAt: z.number().nullable(),
  /** Where to download manually (release page). */
  downloadUrl: z.string(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;
