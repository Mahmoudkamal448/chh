import { z } from 'zod';
import { IdSchema } from './common';

/** A saved command or script. `{{name}}` placeholders are asked for before running. */
export const SnippetFieldsSchema = z.object({
  label: z.string().trim().min(1).max(200),
  script: z.string().min(1).max(65_536),
  description: z.string().max(2000),
  tags: z.array(z.string().trim().min(1).max(50)).max(50),
});
export type SnippetFields = z.infer<typeof SnippetFieldsSchema>;

export const SnippetSchema = SnippetFieldsSchema.extend({ id: IdSchema, vaultId: IdSchema, updatedAt: z.number() });
export type Snippet = z.infer<typeof SnippetSchema>;

export const SnippetInputSchema = z.object({
  label: z.string().trim().min(1).max(200),
  script: z.string().min(1).max(65_536),
  description: z.string().max(2000).default(''),
  tags: z.array(z.string().trim().min(1).max(50)).max(50).default([]),
  vaultId: IdSchema.optional(),
});
export type SnippetInput = z.input<typeof SnippetInputSchema>;

export const SnippetPatchSchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  script: z.string().min(1).max(65_536).optional(),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
});
export type SnippetPatch = z.input<typeof SnippetPatchSchema>;

/** Unique placeholder names in order of appearance: "{{ name }}" -> "name". */
export function snippetVariables(script: string): string[] {
  const out: string[] = [];
  for (const m of script.matchAll(/\{\{\s*([A-Za-z_][\w-]{0,63})\s*\}\}/g)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

export function fillSnippet(script: string, values: Record<string, string>): string {
  return script.replace(/\{\{\s*([A-Za-z_][\w-]{0,63})\s*\}\}/g, (all, name: string) => values[name] ?? all);
}
