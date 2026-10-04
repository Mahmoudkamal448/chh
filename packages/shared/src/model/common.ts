import { z } from 'zod';

export const IdSchema = z.string().min(1).max(64);
export type Id = z.infer<typeof IdSchema>;

/**
 * A secret sealed with the vault key (XChaCha20-Poly1305). Only the main process can open it;
 * it never crosses into the renderer.
 */
export const SealedSchema = z.object({
  v: z.literal(1),
  n: z.string(), // base64 nonce
  c: z.string(), // base64 ciphertext + tag
});
export type Sealed = z.infer<typeof SealedSchema>;

/** Tri-state update for secret fields: undefined = unchanged, null = clear, string = set. */
export const SecretInputSchema = z.string().max(4096).nullable().optional();
