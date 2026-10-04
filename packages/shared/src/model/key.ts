import { z } from 'zod';
import { IdSchema, SealedSchema } from './common';

export const KeyTypeSchema = z.enum(['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa']);
export type KeyTypeName = z.infer<typeof KeyTypeSchema>;

const label = z.string().trim().min(1).max(200);

/** Persisted key (main process only). The private key is stored unencrypted-OpenSSH, sealed with the vault key. */
export const KeyFieldsSchema = z.object({
  label,
  type: KeyTypeSchema,
  bits: z.number().int(),
  /** OpenSSH public key line: "type base64 comment". */
  publicKey: z.string().max(16_384),
  fingerprint: z.string().max(128),
  comment: z.string().max(1024),
  privateKey: SealedSchema,
  origin: z.enum(['generated', 'openssh', 'pem', 'pkcs8', 'ppk2', 'ppk3']),
  createdAt: z.number(),
  /** OpenSSH certificate for this key pair ("…-cert.pub" line), presented when authenticating. */
  certificate: z.string().max(16_384).nullable().default(null),
});
export type KeyFields = z.infer<typeof KeyFieldsSchema>;

/** What the UI shows about a key's certificate. */
export const CertificateSummarySchema = z.object({
  certType: z.string(),
  kind: z.enum(['user', 'host']),
  serial: z.string(),
  keyId: z.string(),
  /** Empty: valid for any user name. */
  principals: z.array(z.string()),
  validAfter: z.number(),
  /** Null: never expires. */
  validBefore: z.number().nullable(),
  extensions: z.array(z.string()),
  criticalOptions: z.array(z.string()),
  caFingerprint: z.string(),
});
export type CertificateSummary = z.infer<typeof CertificateSummarySchema>;

/** Renderer view: no private material. */
export const KeySchema = KeyFieldsSchema.omit({ privateKey: true, certificate: true }).extend({
  id: IdSchema,
  vaultId: IdSchema,
  updatedAt: z.number(),
  certificate: CertificateSummarySchema.nullable(),
});
export type Key = z.infer<typeof KeySchema>;

export const GenerateKeyInputSchema = z.discriminatedUnion('algorithm', [
  z.object({ label, comment: z.string().max(1024).default(''), algorithm: z.literal('ed25519') }),
  z.object({ label, comment: z.string().max(1024).default(''), algorithm: z.literal('ecdsa'), bits: z.union([z.literal(256), z.literal(384), z.literal(521)]) }),
  z.object({ label, comment: z.string().max(1024).default(''), algorithm: z.literal('rsa'), bits: z.union([z.literal(2048), z.literal(3072), z.literal(4096)]) }),
]);
export type GenerateKeyInput = z.input<typeof GenerateKeyInputSchema>;

/** Result of an import attempt; passphrase problems are expected outcomes, not errors. */
export const ImportKeyResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('imported'), key: KeySchema }),
  z.object({ status: z.literal('passphrase_required') }),
  z.object({ status: z.literal('bad_passphrase') }),
  z.object({ status: z.literal('duplicate'), existing: KeySchema }),
]);
export type ImportKeyResult = z.infer<typeof ImportKeyResultSchema>;
