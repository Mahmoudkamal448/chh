import { z } from 'zod';
import { IdSchema } from './common';

export const TeamRoleSchema = z.enum(['owner', 'admin', 'editor', 'viewer']);
export type TeamRole = z.infer<typeof TeamRoleSchema>;
export const InviteRoleSchema = z.enum(['admin', 'editor', 'viewer']);

/** A team this account belongs to, as the renderer sees it. */
export const TeamSummarySchema = z.object({
  id: IdSchema,
  vaultId: IdSchema,
  /** Null until an admin has confirmed this member (the name is encrypted with the team key). */
  name: z.string().nullable(),
  role: TeamRoleSchema,
  status: z.enum(['accepted', 'confirmed']),
  memberCount: z.number(),
  /** Someone left or was removed without a key rotation. */
  needsRotation: z.boolean(),
  keyGen: z.number(),
});
export type TeamSummary = z.infer<typeof TeamSummarySchema>;

/** An invite addressed to this account. */
export const MyInviteSchema = z.object({ id: IdSchema, teamId: IdSchema, invitedBy: z.string(), role: InviteRoleSchema, createdAt: z.number() });
export type MyInvite = z.infer<typeof MyInviteSchema>;

export const TeamMemberSchema = z.object({
  userId: IdSchema,
  email: z.string(),
  role: TeamRoleSchema,
  status: z.enum(['accepted', 'confirmed']),
  /** Fingerprint of the member's public key; compare it with them before confirming. */
  fingerprint: z.string(),
  isMe: z.boolean(),
  joinedAt: z.number(),
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

export const PendingInviteSchema = z.object({ id: IdSchema, email: z.string(), role: InviteRoleSchema, createdAt: z.number() });
export type PendingInvite = z.infer<typeof PendingInviteSchema>;

export const AuditEntryViewSchema = z.object({
  id: z.number(),
  at: z.number(),
  actorEmail: z.string(),
  deviceName: z.string().nullable(),
  action: z.string(),
  itemId: z.string().nullable(),
  /** Label of the item if this device has it. */
  itemLabel: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()),
  clientReported: z.boolean(),
});
export type AuditEntryView = z.infer<typeof AuditEntryViewSchema>;

/** A vault items can live in (for "Move to…" pickers and badges). */
export const VaultSummarySchema = z.object({
  id: IdSchema,
  kind: z.enum(['personal', 'team']),
  name: z.string(),
  teamId: IdSchema.nullable(),
  role: TeamRoleSchema.nullable(),
  writable: z.boolean(),
});
export type VaultSummary = z.infer<typeof VaultSummarySchema>;

export const MovableKindSchema = z.enum(['host', 'identity', 'key', 'snippet']);
export type MovableKind = z.infer<typeof MovableKindSchema>;
