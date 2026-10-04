import { z } from 'zod';

export const HistoryEntrySchema = z.object({
  id: z.number(),
  hostId: z.string().nullable(),
  /** Host label, or the shell name for local terminals. */
  source: z.string(),
  command: z.string(),
  at: z.number(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
