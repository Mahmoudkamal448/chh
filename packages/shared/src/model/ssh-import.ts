import { z } from 'zod';
import { ForwardKindSchema } from './forward';

export const SshImportCandidateSchema = z.object({
  alias: z.string(),
  hostName: z.string(),
  port: z.number().nullable(),
  user: z.string().nullable(),
  identityFiles: z.array(z.string()),
  proxyJump: z.string().nullable(),
  forwardAgent: z.boolean().nullable(),
  forwards: z.array(
    z.object({ kind: ForwardKindSchema, bindHost: z.string(), bindPort: z.number(), destHost: z.string().nullable(), destPort: z.number().nullable() }),
  ),
  unsupported: z.array(z.string()),
  /** A host with the same label and address already exists. */
  exists: z.boolean(),
});
export type SshImportCandidate = z.infer<typeof SshImportCandidateSchema>;

export const SshImportPreviewSchema = z.object({
  token: z.string(),
  path: z.string(),
  candidates: z.array(SshImportCandidateSchema),
  warnings: z.array(z.string()),
});
export type SshImportPreview = z.infer<typeof SshImportPreviewSchema>;

export const SshImportResultSchema = z.object({
  hosts: z.number(),
  keys: z.number(),
  forwards: z.number(),
  /** Identity files that couldn't be imported (missing, encrypted, unsupported) with reasons. */
  skippedKeys: z.array(z.object({ path: z.string(), reason: z.string() })),
});
export type SshImportResult = z.infer<typeof SshImportResultSchema>;
