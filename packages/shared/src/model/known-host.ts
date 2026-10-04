import { z } from 'zod';

export const KnownHostFieldsSchema = z.object({
  /** "address:port" exactly as connected to. */
  hostPattern: z.string().min(1).max(300),
  keyType: z.string().max(64),
  /** OpenSSH-style "SHA256:base64" fingerprint. */
  fingerprint: z.string().max(128),
  /** base64 of the raw public key blob. */
  publicKey: z.string().max(8192),
  addedAt: z.number(),
});
export type KnownHostFields = z.infer<typeof KnownHostFieldsSchema>;
