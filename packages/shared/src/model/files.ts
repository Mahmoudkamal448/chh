import { z } from 'zod';

/** 'local' or the id of an SFTP session. */
export const EndpointSchema = z.string().min(1).max(64);
export type Endpoint = z.infer<typeof EndpointSchema>;

export const FileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['file', 'dir', 'symlink', 'other']),
  /** For symlinks: whether the target is a directory. */
  targetIsDir: z.boolean(),
  size: z.number(),
  /** ms since epoch */
  mtime: z.number(),
  /** POSIX permission bits (0o777 mask applied); null where meaningless (e.g. Windows). */
  mode: z.number().nullable(),
  owner: z.string().nullable(),
  group: z.string().nullable(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const ConflictPolicySchema = z.enum(['overwrite', 'skip', 'rename']);
export type ConflictPolicy = z.infer<typeof ConflictPolicySchema>;

export const TransferSchema = z.object({
  id: z.string(),
  name: z.string(),
  src: z.object({ endpoint: EndpointSchema, path: z.string() }),
  dst: z.object({ endpoint: EndpointSchema, path: z.string() }),
  state: z.enum(['queued', 'running', 'done', 'error', 'cancelled']),
  totalBytes: z.number(),
  doneBytes: z.number(),
  files: z.number(),
  doneFiles: z.number(),
  /** bytes/second over the last interval */
  rate: z.number(),
  error: z.string().optional(),
});
export type Transfer = z.infer<typeof TransferSchema>;
