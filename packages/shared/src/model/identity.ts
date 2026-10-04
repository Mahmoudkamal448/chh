import { z } from 'zod';
import { IdSchema, SealedSchema, SecretInputSchema } from './common';

const label = z.string().trim().min(1).max(200);

/** A reusable username + password and/or key, linked to hosts or groups. */
export const IdentityFieldsSchema = z.object({
  label,
  username: z.string().max(255),
  password: SealedSchema.nullable(),
  keyId: IdSchema.nullable(),
});
export type IdentityFields = z.infer<typeof IdentityFieldsSchema>;

export const IdentitySchema = IdentityFieldsSchema.omit({ password: true }).extend({
  id: IdSchema,
  hasPassword: z.boolean(),
  updatedAt: z.number(),
});
export type Identity = z.infer<typeof IdentitySchema>;

export const IdentityInputSchema = z.object({
  label,
  username: z.string().max(255).default(''),
  keyId: IdSchema.nullable().default(null),
  password: SecretInputSchema,
});
export type IdentityInput = z.input<typeof IdentityInputSchema>;

export const IdentityPatchSchema = z.object({
  label: label.optional(),
  username: z.string().max(255).optional(),
  keyId: IdSchema.nullable().optional(),
  password: SecretInputSchema,
});
export type IdentityPatch = z.input<typeof IdentityPatchSchema>;
