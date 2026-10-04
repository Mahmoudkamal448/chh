import { z } from 'zod';
import { IdSchema } from './common';
import { HostSettingsOverridesSchema } from './settings';

const label = z.string().trim().min(1).max(200);

export const GroupFieldsSchema = z.object({
  label,
  parentId: IdSchema.nullable(),
  settings: HostSettingsOverridesSchema,
});
export type GroupFields = z.infer<typeof GroupFieldsSchema>;

export const GroupSchema = GroupFieldsSchema.extend({ id: IdSchema, updatedAt: z.number() });
export type Group = z.infer<typeof GroupSchema>;

export const GroupInputSchema = z.object({
  label,
  parentId: IdSchema.nullable().default(null),
  settings: HostSettingsOverridesSchema.default({}),
});
export type GroupInput = z.input<typeof GroupInputSchema>;

export const GroupPatchSchema = z.object({
  label: label.optional(),
  parentId: IdSchema.nullable().optional(),
  settings: HostSettingsOverridesSchema.optional(),
});
export type GroupPatch = z.input<typeof GroupPatchSchema>;
