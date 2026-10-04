import { z } from 'zod';

/** One host's progress in a multi-host snippet run. */
export const RunHostStatusSchema = z.object({
  runId: z.string(),
  hostId: z.string(),
  status: z.enum(['queued', 'connecting', 'running', 'done', 'error', 'cancelled']),
  exitCode: z.number().nullable().optional(),
  /** i18n key (+ "::detail") when status is error. */
  error: z.string().optional(),
});
export type RunHostStatus = z.infer<typeof RunHostStatusSchema>;

export const RunOutputSchema = z.object({
  runId: z.string(),
  hostId: z.string(),
  stream: z.enum(['stdout', 'stderr', 'info']),
  data: z.string(),
});
export type RunOutput = z.infer<typeof RunOutputSchema>;

export const CloudCandidateSchema = z.object({
  /** "aws:i-..." / "do:123" */
  externalId: z.string(),
  name: z.string(),
  publicAddress: z.string().nullable(),
  privateAddress: z.string().nullable(),
  publicDns: z.string().nullable(),
  region: z.string(),
  tags: z.array(z.string()),
  osHint: z.string().nullable(),
  /** Suggested login user (e.g. "root" on DigitalOcean). */
  user: z.string().nullable(),
  /** Already imported (will be updated rather than duplicated). */
  exists: z.boolean(),
});
export type CloudCandidate = z.infer<typeof CloudCandidateSchema>;
