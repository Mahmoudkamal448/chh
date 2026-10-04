import { z } from 'zod';
import { IdSchema, SealedSchema, SecretInputSchema } from './common';
import { HostSettingsOverridesSchema } from './settings';

export const ProtocolSchema = z.enum(['ssh', 'telnet', 'mosh']);
export type Protocol = z.infer<typeof ProtocolSchema>;

const label = z.string().trim().min(1).max(200);
const address = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^\s@/]+$/, 'invalid address');
const tags = z.array(z.string().trim().min(1).max(50)).max(50);

/** Shape persisted in the item store (main process only). */
export const HostFieldsSchema = z.object({
  label,
  address,
  protocol: ProtocolSchema,
  groupId: IdSchema.nullable(),
  tags,
  favorite: z.boolean(),
  notes: z.string().max(10_000),
  osHint: z.string().max(32).nullable(),
  settings: HostSettingsOverridesSchema,
  password: SealedSchema.nullable(),
});
export type HostFields = z.infer<typeof HostFieldsSchema>;

/** What the renderer sees: never the secret, only whether one is stored. */
export const HostSchema = HostFieldsSchema.omit({ password: true }).extend({
  id: IdSchema,
  hasPassword: z.boolean(),
  updatedAt: z.number(),
});
export type Host = z.infer<typeof HostSchema>;

export const HostInputSchema = z.object({
  label,
  address,
  protocol: ProtocolSchema.default('ssh'),
  groupId: IdSchema.nullable().default(null),
  tags: tags.default([]),
  favorite: z.boolean().default(false),
  notes: z.string().max(10_000).default(''),
  settings: HostSettingsOverridesSchema.default({}),
  password: SecretInputSchema,
});
export type HostInput = z.input<typeof HostInputSchema>;

export const HostPatchSchema = z.object({
  label: label.optional(),
  address: address.optional(),
  protocol: ProtocolSchema.optional(),
  groupId: IdSchema.nullable().optional(),
  tags: tags.optional(),
  favorite: z.boolean().optional(),
  notes: z.string().max(10_000).optional(),
  settings: HostSettingsOverridesSchema.optional(),
  password: SecretInputSchema,
});
export type HostPatch = z.input<typeof HostPatchSchema>;

export const HostQuerySchema = z.object({
  query: z.string().max(200).optional(),
  groupId: IdSchema.nullable().optional(), // undefined = all groups, null = ungrouped
  includeSubgroups: z.boolean().default(true),
  tag: z.string().max(50).optional(),
  favoritesOnly: z.boolean().optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(50_000).default(50_000),
});
export type HostQuery = z.input<typeof HostQuerySchema>;
