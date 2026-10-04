import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as P from '@chh/shared/sync';
import { HttpError, parse, type Auth } from './http';
import type { Hub } from './hub';
import type { AuditRecord, MemberRecord, Store, TeamRecord, VaultRecord } from './store/types';

const RANK: Record<P.TeamRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };
const atLeast = (role: P.TeamRole, min: P.TeamRole) => RANK[role] >= RANK[min];
const MAX_TEAMS_PER_USER = 200; // effectively unlimited; just bounds abuse
const MAX_MEMBERS = 10_000;

export type VaultAccess = { vault: VaultRecord; team: TeamRecord | null; member: MemberRecord | null };

/**
 * Team routes and the access rules shared with sync. The server never sees a team key or a team
 * name: it stores sealed copies of the key per member and enforces roles for writes and admin
 * actions. Reads are protected cryptographically (only confirmed members hold the key).
 */
export function teamService(store: Store, hub: Hub) {
  /** Writes audit entries for a team; actor email and device name are snapshotted. */
  async function audit(auth: Auth, teamId: string, entries: Array<{ action: string; itemId?: string | null; meta?: Record<string, unknown>; at?: number; clientReported?: boolean }>) {
    if (!entries.length) return;
    const user = await store.getUser(auth.userId);
    const device = (await store.listDevices(auth.userId)).find((d) => d.id === auth.deviceId);
    const now = Date.now();
    const rows: Array<Omit<AuditRecord, 'id'>> = entries.map((e) => ({
      teamId,
      actorUserId: auth.userId,
      actorEmail: user?.email ?? '',
      deviceId: auth.deviceId,
      deviceName: device?.name ?? null,
      action: e.action,
      itemId: e.itemId ?? null,
      at: e.at ?? now,
      meta: e.meta ?? {},
      clientReported: e.clientReported ?? false,
    }));
    await store.appendAudit(rows);
  }

  /** Personal vault: owner only. Team vault: confirmed members, writes need editor or above. */
  async function vaultAccess(auth: Auth, vaultId: string, need: 'read' | 'write'): Promise<VaultAccess> {
    const vault = await store.getVault(vaultId);
    if (!vault) throw new HttpError(404, 'not_found');
    if (vault.kind === 'personal') {
      if (vault.ownerUserId !== auth.userId) throw new HttpError(404, 'not_found');
      return { vault, team: null, member: null };
    }
    const member = await store.getMember(vault.teamId!, auth.userId);
    if (!member || member.status !== 'confirmed') throw new HttpError(404, 'not_found');
    if (need === 'write' && !atLeast(member.role, 'editor')) throw new HttpError(403, 'read_only');
    return { vault, team: await store.getTeam(vault.teamId!), member };
  }

  /** Users to notify when a vault changes. */
  async function vaultAudience(v: VaultRecord): Promise<string[]> {
    if (v.kind === 'personal') return [v.ownerUserId!];
    return (await store.listMembers(v.teamId!)).filter((m) => m.status === 'confirmed').map((m) => m.userId);
  }

  async function teamFor(auth: Auth, teamId: string, min: P.TeamRole | 'any' = 'any', confirmed = false) {
    const team = await store.getTeam(teamId);
    const member = team ? await store.getMember(teamId, auth.userId) : null;
    if (!team || !member) throw new HttpError(404, 'not_found');
    if (confirmed && member.status !== 'confirmed') throw new HttpError(403, 'not_confirmed');
    if (min !== 'any' && !atLeast(member.role, min)) throw new HttpError(403, 'forbidden');
    return { team, member };
  }

  const notifyTeam = async (teamId: string, extra: string[] = []) => {
    const ids = (await store.listMembers(teamId)).map((m) => m.userId);
    hub.notify(new Set([...ids, ...extra]), { type: 'teams' });
  };

  function register(r: FastifyInstance) {
    const auth = (req: FastifyRequest) => req.auth!;

    r.get('/v1/teams', async (req): Promise<P.TeamWire[]> => {
      const rows = await store.listTeams(auth(req).userId);
      return rows.map(({ team, member, vault, memberCount }) => ({
        id: team.id,
        vaultId: team.vaultId,
        nameEnc: team.nameEnc,
        role: member.role,
        status: member.status,
        keyGen: vault.keyGen,
        // A key sealed for an older generation is useless after a rotation.
        keyWrapped: member.status === 'confirmed' && member.keyGen === vault.keyGen ? member.keyWrapped : null,
        memberCount,
        needsRotation: vault.needsRotation,
      }));
    });

    r.post('/v1/teams', async (req, reply) => {
      const a = auth(req);
      const body = parse(P.CreateTeamRequest, req.body);
      if ((await store.listTeams(a.userId)).length >= MAX_TEAMS_PER_USER) throw new HttpError(429, 'too_many_teams');
      const now = Date.now();
      try {
        await store.createTeam(
          { id: body.teamId, vaultId: body.vaultId, nameEnc: body.nameEnc, createdBy: a.userId, createdAt: now },
          { id: body.vaultId, kind: 'team', ownerUserId: null, teamId: body.teamId, keyWrapped: '', seq: 0, keyGen: 1, needsRotation: false },
          { teamId: body.teamId, userId: a.userId, role: 'owner', status: 'confirmed', keyWrapped: body.keyWrapped, keyGen: 1, joinedAt: now },
        );
      } catch (e) {
        if ((e as { code?: string }).code === 'EXISTS') throw new HttpError(409, 'exists');
        throw e;
      }
      await audit(a, body.teamId, [{ action: 'team.created' }]);
      reply.code(201);
      return { id: body.teamId };
    });

    r.patch('/v1/teams/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const { nameEnc } = parse(P.RenameTeamRequest, req.body);
      await teamFor(auth(req), id, 'admin', true);
      await store.updateTeam(id, { nameEnc });
      await audit(auth(req), id, [{ action: 'team.renamed' }]);
      await notifyTeam(id);
      reply.code(204);
    });

    r.delete('/v1/teams/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      await teamFor(auth(req), id, 'owner');
      const members = (await store.listMembers(id)).map((m) => m.userId);
      await audit(auth(req), id, [{ action: 'team.deleted' }]);
      await store.deleteTeam(id);
      hub.notify(members, { type: 'teams' });
      reply.code(204);
    });

    r.get('/v1/teams/:id/members', async (req): Promise<P.MemberWire[]> => {
      const { id } = req.params as { id: string };
      await teamFor(auth(req), id);
      return (await store.listMembers(id)).map((m) => ({ userId: m.userId, email: m.email, role: m.role, status: m.status, publicKey: m.publicKey, joinedAt: m.joinedAt }));
    });

    r.post('/v1/teams/:id/members/:userId/confirm', async (req, reply) => {
      const { id, userId } = req.params as { id: string; userId: string };
      const body = parse(P.ConfirmMemberRequest, req.body);
      const { team } = await teamFor(auth(req), id, 'admin', true);
      const target = await store.getMember(id, userId);
      if (!target) throw new HttpError(404, 'not_found');
      const vault = (await store.getVault(team.vaultId))!;
      if (body.keyGen !== vault.keyGen) throw new HttpError(409, 'stale_key');
      await store.updateMember(id, userId, { status: 'confirmed', keyWrapped: body.keyWrapped, keyGen: body.keyGen });
      await audit(auth(req), id, [{ action: 'member.confirmed', meta: { userId, email: (await store.getUser(userId))?.email } }]);
      await notifyTeam(id);
      reply.code(204);
    });

    r.patch('/v1/teams/:id/members/:userId', async (req, reply) => {
      const { id, userId } = req.params as { id: string; userId: string };
      const { role } = parse(P.SetRoleRequest, req.body);
      const a = auth(req);
      const { member: me } = await teamFor(a, id, 'admin', true);
      const target = await store.getMember(id, userId);
      if (!target) throw new HttpError(404, 'not_found');
      if (target.role === 'owner') throw new HttpError(403, 'forbidden');
      if (role === 'owner') {
        // Ownership transfer: only the owner, only to a confirmed member; the old owner becomes an admin.
        if (me.role !== 'owner' || target.status !== 'confirmed') throw new HttpError(403, 'forbidden');
        await store.updateMember(id, userId, { role: 'owner' });
        await store.updateMember(id, a.userId, { role: 'admin' });
      } else {
        await store.updateMember(id, userId, { role });
      }
      await audit(a, id, [{ action: 'member.role_changed', meta: { userId, email: (await store.getUser(userId))?.email, from: target.role, to: role } }]);
      await notifyTeam(id);
      reply.code(204);
    });

    /**
     * Removes a member without rotating the key. Meant for members who were never confirmed (they
     * never had the key); for confirmed ones the app uses /rotate, and otherwise the vault is
     * flagged so admins are asked to rotate.
     */
    r.delete('/v1/teams/:id/members/:userId', async (req, reply) => {
      const a = auth(req);
      const { id, userId } = req.params as { id: string; userId: string };
      const { team } = await teamFor(a, id, 'admin', true);
      const target = await store.getMember(id, userId);
      if (!target) throw new HttpError(404, 'not_found');
      if (target.role === 'owner' || userId === a.userId) throw new HttpError(403, 'forbidden');
      await store.removeMember(id, userId);
      if (target.status === 'confirmed') await store.setNeedsRotation(team.vaultId, true);
      await audit(a, id, [{ action: 'member.removed', meta: { userId, email: (await store.getUser(userId))?.email, rotated: false } }]);
      await notifyTeam(id, [userId]);
      reply.code(204);
    });

    r.post('/v1/teams/:id/rotate', async (req) => {
      const a = auth(req);
      const { id } = req.params as { id: string };
      const body = parse(P.RotateRequest, req.body);
      const { team } = await teamFor(a, id, 'admin', true);
      const vault = (await store.getVault(team.vaultId))!;
      if (body.keyGen !== vault.keyGen + 1) throw new HttpError(409, 'stale_key');
      const members = await store.listMembers(id);
      const remove = new Set(body.remove);
      for (const uid of remove) {
        const m = members.find((x) => x.userId === uid);
        if (!m) throw new HttpError(404, 'not_found');
        if (m.role === 'owner' || uid === a.userId) throw new HttpError(403, 'forbidden');
      }
      // The new key must reach exactly the confirmed members who stay.
      const expected = members.filter((m) => m.status === 'confirmed' && !remove.has(m.userId)).map((m) => m.userId).sort();
      const given = body.members.map((m) => m.userId).sort();
      if (expected.join() !== given.join()) throw new HttpError(409, 'members_changed');
      // And every item must be re-encrypted, or members would be left with undecryptable data.
      const ids = (await store.itemIds(vault.id)).sort();
      const sent = body.items.map((i) => i.itemId).sort();
      if (ids.join() !== sent.join()) throw new HttpError(409, 'stale');
      const out = await store.rotateTeamVault(id, vault.id, { ...body, deviceId: a.deviceId });
      if (out.status === 'stale') throw new HttpError(409, 'stale');
      const removedEmails = new Map(members.filter((m) => remove.has(m.userId)).map((m) => [m.userId, m.email]));
      await audit(a, id, [
        ...[...remove].map((uid) => ({ action: 'member.removed', meta: { userId: uid, email: removedEmails.get(uid) } })),
        { action: 'vault.rotated', meta: { keyGen: body.keyGen, items: body.items.length } },
      ]);
      const stay = expected;
      hub.notify(stay, { type: 'changed', vaultId: vault.id, seq: out.seq });
      await notifyTeam(id, [...remove]);
      return { keyGen: body.keyGen, seq: out.seq };
    });

    r.post('/v1/teams/:id/leave', async (req, reply) => {
      const a = auth(req);
      const { id } = req.params as { id: string };
      const { team, member } = await teamFor(a, id);
      if (member.role === 'owner') throw new HttpError(409, 'owner_cannot_leave');
      await store.removeMember(id, a.userId);
      // The leaver still holds the current key: admins are told to rotate it.
      if (member.status === 'confirmed') await store.setNeedsRotation(team.vaultId, true);
      await audit(a, id, [{ action: 'member.left' }]);
      await notifyTeam(id, [a.userId]);
      reply.code(204);
    });

    // --- invites ---------------------------------------------------------------------------------

    r.get('/v1/teams/:id/invites', async (req): Promise<P.InviteWire[]> => {
      const { id } = req.params as { id: string };
      await teamFor(auth(req), id, 'admin');
      return Promise.all((await store.listInvitesForTeam(id)).map(inviteWire));
    });

    r.post('/v1/teams/:id/invites', async (req, reply) => {
      const a = auth(req);
      const { id } = req.params as { id: string };
      const body = parse(P.InviteRequest, req.body);
      await teamFor(a, id, 'admin', true);
      const members = await store.listMembers(id);
      if (members.some((m) => m.email === body.email)) throw new HttpError(409, 'already_member');
      if (members.length + (await store.listInvitesForTeam(id)).length >= MAX_MEMBERS) throw new HttpError(429, 'too_many_members');
      const invite = { id: randomUUID(), teamId: id, email: body.email, role: body.role, invitedBy: a.userId, createdAt: Date.now() };
      try {
        await store.createInvite(invite);
      } catch (e) {
        if ((e as { code?: string }).code === 'EXISTS') throw new HttpError(409, 'already_invited');
        throw e;
      }
      await audit(a, id, [{ action: 'member.invited', meta: { email: body.email, role: body.role } }]);
      // Tell the invitee's devices, if they already have an account.
      const invitee = await store.getUserByEmail(body.email);
      if (invitee) hub.notify(invitee.id, { type: 'teams' });
      reply.code(201);
      return { id: invite.id };
    });

    r.delete('/v1/teams/:id/invites/:inviteId', async (req, reply) => {
      const { id, inviteId } = req.params as { id: string; inviteId: string };
      await teamFor(auth(req), id, 'admin');
      const invite = await store.getInvite(inviteId);
      if (!invite || invite.teamId !== id) throw new HttpError(404, 'not_found');
      await store.deleteInvite(inviteId);
      await audit(auth(req), id, [{ action: 'invite.canceled', meta: { email: invite.email } }]);
      reply.code(204);
    });

    /** Invites addressed to the signed-in account's email. */
    r.get('/v1/invites', async (req): Promise<P.InviteWire[]> => {
      const u = await store.getUser(auth(req).userId);
      return Promise.all((await store.listInvitesForEmail(u!.email)).map(inviteWire));
    });

    const myInvite = async (req: FastifyRequest) => {
      const { inviteId } = req.params as { inviteId: string };
      const u = (await store.getUser(auth(req).userId))!;
      const invite = await store.getInvite(inviteId);
      if (!invite || invite.email !== u.email) throw new HttpError(404, 'not_found');
      return invite;
    };

    r.post('/v1/invites/:inviteId/accept', async (req, reply) => {
      const a = auth(req);
      const invite = await myInvite(req);
      if ((await store.listTeams(a.userId)).length >= MAX_TEAMS_PER_USER) throw new HttpError(429, 'too_many_teams');
      await store.addMember({ teamId: invite.teamId, userId: a.userId, role: invite.role, status: 'accepted', keyWrapped: null, keyGen: 0, joinedAt: Date.now() });
      await store.deleteInvite(invite.id);
      await audit(a, invite.teamId, [{ action: 'invite.accepted', meta: { role: invite.role } }]);
      await notifyTeam(invite.teamId);
      reply.code(204);
    });

    r.delete('/v1/invites/:inviteId', async (req, reply) => {
      const invite = await myInvite(req);
      await store.deleteInvite(invite.id);
      await audit(auth(req), invite.teamId, [{ action: 'invite.declined' }]);
      reply.code(204);
    });

    // --- audit log -------------------------------------------------------------------------------

    r.get('/v1/teams/:id/audit', async (req): Promise<{ entries: P.AuditEntry[]; hasMore: boolean }> => {
      const { id } = req.params as { id: string };
      const q = parse(P.AuditQuery, req.query);
      await teamFor(auth(req), id, 'admin', true);
      const rows = await store.listAudit(id, q.before, q.limit + 1);
      return {
        entries: rows.slice(0, q.limit).map(({ teamId: _t, deviceId: _d, ...e }) => e),
        hasMore: rows.length > q.limit,
      };
    });

    /** Events only the app can see (connecting to a shared host, exporting a shared secret). */
    r.post('/v1/teams/:id/audit', async (req, reply) => {
      const { id } = req.params as { id: string };
      const { events } = parse(P.ReportEventsRequest, req.body);
      await teamFor(auth(req), id, 'any', true);
      const now = Date.now();
      // Clients may queue events while offline; keep their time but never in the future.
      await audit(
        auth(req),
        id,
        events.map((e) => ({ action: e.action, itemId: e.itemId, at: Math.min(e.at, now), clientReported: true })),
      );
      reply.code(204);
    });
  }

  async function inviteWire(i: Awaited<ReturnType<Store['getInvite']>> & object): Promise<P.InviteWire> {
    const by = await store.getUser(i.invitedBy);
    return { id: i.id, teamId: i.teamId, email: i.email, role: i.role, invitedBy: by?.email ?? '', createdAt: i.createdAt };
  }

  return { register, vaultAccess, vaultAudience, audit };
}
