import { z } from 'zod';
import { IdSchema } from './common';

export const KnownHostFieldsSchema = z.object({
  /**
   * "host" for port 22, "[host]:port" otherwise (OpenSSH convention). Imported entries may also be
   * hashed ("|1|salt|hash") or wildcard patterns ("*.example.com", "!bad.example.com").
   */
  hostPattern: z.string().min(1).max(1024),
  keyType: z.string().max(64),
  /** OpenSSH-style "SHA256:base64" fingerprint. */
  fingerprint: z.string().max(128),
  /** base64 of the raw public key blob. */
  publicKey: z.string().max(16_384),
  addedAt: z.number(),
  /** Where it came from: trusted in-app, or imported from a known_hosts file. */
  source: z.enum(['trusted', 'imported']).optional(),
});
export type KnownHostFields = z.infer<typeof KnownHostFieldsSchema>;

export const KnownHostSchema = KnownHostFieldsSchema.omit({ publicKey: true }).extend({ id: IdSchema });
export type KnownHost = z.infer<typeof KnownHostSchema>;
