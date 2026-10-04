import { z } from 'zod';
import { IdSchema } from './common';

const port = z.number().int().min(1).max(65535);
const hostName = z.string().trim().min(1).max(255);

export const ForwardKindSchema = z.enum(['local', 'remote', 'dynamic']);
export type ForwardKind = z.infer<typeof ForwardKindSchema>;

/** A port-forwarding rule tunnelled through one host's SSH connection. */
export const ForwardFieldsSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    hostId: IdSchema,
    kind: ForwardKindSchema,
    /** Local listen address (local/dynamic) or remote listen address (remote). */
    bindHost: hostName,
    bindPort: port,
    /** Target (local: as seen from the server; remote: as seen from this computer). Null for dynamic. */
    destHost: hostName.nullable(),
    destPort: port.nullable(),
    autoStart: z.boolean(),
  })
  .refine((f) => f.kind === 'dynamic' || (f.destHost !== null && f.destPort !== null), { message: 'destination required', path: ['destHost'] });
export type ForwardFields = z.infer<typeof ForwardFieldsSchema>;

export const ForwardSchema = z.object({
  id: IdSchema,
  label: z.string(),
  hostId: IdSchema,
  kind: ForwardKindSchema,
  bindHost: z.string(),
  bindPort: z.number(),
  destHost: z.string().nullable(),
  destPort: z.number().nullable(),
  autoStart: z.boolean(),
  updatedAt: z.number(),
});
export type Forward = z.infer<typeof ForwardSchema>;

export const ForwardInputSchema = z.object({
  label: z.string().trim().min(1).max(200),
  hostId: IdSchema,
  kind: ForwardKindSchema,
  bindHost: hostName.default('127.0.0.1'),
  bindPort: port,
  destHost: hostName.nullable().default(null),
  destPort: port.nullable().default(null),
  autoStart: z.boolean().default(false),
});
export type ForwardInput = z.input<typeof ForwardInputSchema>;

/** Patch without defaults (so omitted fields stay unchanged). */
export const ForwardPatchSchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  hostId: IdSchema.optional(),
  kind: ForwardKindSchema.optional(),
  bindHost: hostName.optional(),
  bindPort: port.optional(),
  destHost: hostName.nullable().optional(),
  destPort: port.nullable().optional(),
  autoStart: z.boolean().optional(),
});
export type ForwardPatch = z.input<typeof ForwardPatchSchema>;

export const ForwardStatusSchema = z.object({
  id: IdSchema,
  state: z.enum(['stopped', 'starting', 'running', 'error']),
  /** i18n key (+ "::detail") when in error. */
  message: z.string().optional(),
  connections: z.number(),
  bytesIn: z.number(),
  bytesOut: z.number(),
});
export type ForwardStatus = z.infer<typeof ForwardStatusSchema>;
