import { randomUUID } from 'node:crypto';
import type { AuditEntryView, MovableKind, MyInvite, PendingInvite, SyncProtocol, TeamMember, TeamRole, TeamSummary, VaultSummary } from '@chh/shared';
import {
  decryptItem,
  encryptItem,
  encryptTeamName,
  memzero,
  publicKeyFingerprint,
  randomKey,
  sealTeamKey,
} from '@chh/vault-crypto';
import { AppError } from '../ipc/handle';
import type { ItemStore, ItemType } from '../db/item-store';
import { errInfo, log } from '../log';
import { resealFields, type LocalVault } from '../vault/local-vault';
import type { SyncEngine } from './engine';
import { SyncHttpError } from './http';


/**
 * Team operations on top of the sync engine. Everything secret happens here, in the main
 * process: team keys are generated, sealed to member public keys and rotated locally; the server
 * only stores ciphertext and enforces roles.
 */
export class TeamService {
  constructor(
    private readonly deps: {
      sync: SyncEngine;
      vault: LocalVault;
      store: ItemStore;
      onRemoteChange(types: Set<ItemType>): void;
      onTeamsChanged(): void;
    },
  ) {}

  private get sync() {
    return this.deps.sync;
  }

  private requireSignedIn(): void {
    if (!this.sync.status().signedIn) throw new AppError('not_signed_in', 'teams.error.notSignedIn');
  }

  async list(): Promise<{ teams: TeamSummary[]; invites: MyInvite[]; myFingerprint: string | null }> {
    if (!this.sync.status().signedIn) return { teams: [], invites: [], myFingerprint: null };
    await this.refresh();
    const invites = await this.api<SyncProtocol.InviteWire[]>('GET', '/v1/invites');
    const { publicKey, privateKey } = await this.sync.keyPair();
    memzero(privateKey);
    return {
      teams: this.sync.teams().map((t) => this.summary(t)),
      invites: invites.map((i) => ({ id: i.id, teamId: i.teamId, invitedBy: i.invitedBy, role: i.role, createdAt: i.createdAt })),
      myFingerprint: publicKeyFingerprint(publicKey.toString('base64')),
    };
  }

  async create(name: string): Promise<TeamSummary> {
    this.requireSignedIn();
    const teamId = randomUUID();
    const vaultId = randomUUID();
    const key = randomKey();
    try {
      const { publicKey, privateKey } = await this.sync.keyPair();
      memzero(privateKey);
      await this.api('POST', '/v1/teams', {
        teamId,
        vaultId,
        nameEnc: encryptTeamName(name, key, teamId),
        keyWrapped: sealTeamKey(key, publicKey.toString('base64')),
      });
      this.deps.vault.upsertTeamVault({ id: vaultId, teamId, name, role: 'owner', keyGen: 1 }, key);
    } finally {
      memzero(key);
    }
    await this.refresh();
    const t = this.sync.teams().find((x) => x.id === teamId);
    if (!t) throw new AppError('internal', 'errors.internal');
    return this.summary(t);
  }

  async rename(teamId: string, name: string): Promise<void> {
    const tv = this.teamVault(teamId);
    await this.api('PATCH', `/v1/teams/${enc(teamId)}`, { nameEnc: encryptTeamName(name, this.deps.vault.keyFor(tv.id), teamId) });
    await this.refresh();
  }

  async members(teamId: string): Promise<{ members: TeamMember[]; invites: PendingInvite[] }> {
    this.requireSignedIn();
    const me = this.sync.userId;
    const members = await this.api<SyncProtocol.MemberWire[]>('GET', `/v1/teams/${enc(teamId)}/members`);
    const mine = members.find((m) => m.userId === me);
    const invites =
      mine && (mine.role === 'owner' || mine.role === 'admin') ? await this.api<SyncProtocol.InviteWire[]>('GET', `/v1/teams/${enc(teamId)}/invites`) : [];
    return {
      members: members.map((m) => ({
        userId: m.userId,
        email: m.email,
        role: m.role,
        status: m.status,
        fingerprint: publicKeyFingerprint(m.publicKey),
        isMe: m.userId === me,
        joinedAt: m.joinedAt,
      })),
      invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, createdAt: i.createdAt })),
    };
  }

  async invite(teamId: string, email: string, role: 'admin' | 'editor' | 'viewer'): Promise<void> {
    await this.api('POST', `/v1/teams/${enc(teamId)}/invites`, { email, role });
  }

  async cancelInvite(teamId: string, inviteId: string): Promise<void> {
    await this.api('DELETE', `/v1/teams/${enc(teamId)}/invites/${enc(inviteId)}`);
  }

  async acceptInvite(inviteId: string): Promise<void> {
    await this.api('POST', `/v1/invites/${enc(inviteId)}/accept`);
    await this.refresh();
  }

  async declineInvite(inviteId: string): Promise<void> {
    await this.api('DELETE', `/v1/invites/${enc(inviteId)}`);
  }

  /**
   * Shares the team key with a member. The fingerprint the admin compared must match the public
   * key the server hands out now, so a key swapped in between is refused.
   */
  async confirm(teamId: string, userId: string, fingerprint: string): Promise<void> {
    const tv = this.teamVault(teamId);
    const members = await this.api<SyncProtocol.MemberWire[]>('GET', `/v1/teams/${enc(teamId)}/members`);
    const m = members.find((x) => x.userId === userId);
    if (!m) throw new AppError('not_found', 'errors.notFound');
    if (publicKeyFingerprint(m.publicKey) !== fingerprint.trim().toLowerCase()) throw new AppError('fingerprint_mismatch', 'teams.error.fingerprintMismatch');
    await this.api('POST', `/v1/teams/${enc(teamId)}/members/${enc(userId)}/confirm`, {
      keyWrapped: sealTeamKey(this.deps.vault.keyFor(tv.id), m.publicKey),
      keyGen: tv.keyGen,
    });
  }

  async setRole(teamId: string, userId: string, role: TeamRole): Promise<void> {
    await this.api('PATCH', `/v1/teams/${enc(teamId)}/members/${enc(userId)}`, { role });
    await this.refresh();
  }

  /** Confirmed members held the key, so removing one rotates it; others are simply dropped. */
  async remove(teamId: string, userId: string): Promise<void> {
    const members = await this.api<SyncProtocol.MemberWire[]>('GET', `/v1/teams/${enc(teamId)}/members`);
    const m = members.find((x) => x.userId === userId);
    if (!m) return;
    if (m.status === 'confirmed') await this.rotateKey(teamId, [userId]);
    else await this.api('DELETE', `/v1/teams/${enc(teamId)}/members/${enc(userId)}`);
    await this.refresh();
  }

  /**
   * Rotates the team key: re-encrypts every item on the server with a new key (re-sealing the
   * secrets inside them) and seals the new key for each remaining confirmed member, atomically.
   * Retried if the vault changes while we work.
   */
  async rotateKey(teamId: string, remove: string[] = []): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.rotateOnce(teamId, remove);
        break;
      } catch (e) {
        const retry = e instanceof SyncHttpError && (e.code === 'stale' || e.code === 'stale_key' || e.code === 'members_changed');
        if (!retry || attempt >= 3) throw e;
        log.info({ teamId, code: (e as SyncHttpError).code }, 'team changed during key rotation; retrying');
      }
    }
    await this.sync.syncNow();
  }

  private async rotateOnce(teamId: string, remove: string[]): Promise<void> {
    // Upload pending local changes first so nothing is left encrypted with the old key.
    await this.sync.syncNow();
    const tv = this.teamVault(teamId);
    const oldKey = Buffer.from(this.deps.vault.keyFor(tv.id));
    const newKey = randomKey();
    try {
      // Re-encrypt from the server's copy: that's exactly the set of items the server will check.
      const items: Array<{ itemId: string; nonce: string; ciphertext: string }> = [];
      let since = 0;
      for (;;) {
        const page = await this.api<SyncProtocol.PullResponseWire>('POST', '/v1/sync/pull', { vaultId: tv.id, since, limit: 1000 });
        if (page.keyGen !== undefined && page.keyGen !== tv.keyGen) throw new SyncHttpError(409, 'stale_key');
        for (const c of page.changes) {
          const payload = decryptItem<{ fields: Record<string, unknown> }>(c, oldKey, tv.id, c.itemId);
          payload.fields = resealFields(payload.fields, c.itemId, tv.id, oldKey, tv.id, newKey);
          items.push({ itemId: c.itemId, ...encryptItem(payload, newKey, tv.id, c.itemId) });
        }
        since = page.nextSince;
        if (!page.hasMore) break;
      }
      const members = await this.api<SyncProtocol.MemberWire[]>('GET', `/v1/teams/${enc(teamId)}/members`);
      const stay = members.filter((m) => m.status === 'confirmed' && !remove.includes(m.userId));
      await this.api('POST', `/v1/teams/${enc(teamId)}/rotate`, {
        baseSeq: since,
        keyGen: tv.keyGen + 1,
        nameEnc: encryptTeamName(tv.name, newKey, teamId),
        members: stay.map((m) => ({ userId: m.userId, keyWrapped: sealTeamKey(newKey, m.publicKey) })),
        items,
        remove,
      });
      // Switch locally right away (re-seals local copies; the next pull refreshes revisions).
      this.deps.vault.upsertTeamVault({ ...tv, keyGen: tv.keyGen + 1 }, newKey);
    } finally {
      memzero(oldKey);
      memzero(newKey);
    }
  }

  async leave(teamId: string): Promise<void> {
    await this.api('POST', `/v1/teams/${enc(teamId)}/leave`);
    this.dropLocal(teamId);
    await this.refresh();
  }

  async delete(teamId: string): Promise<void> {
    await this.api('DELETE', `/v1/teams/${enc(teamId)}`);
    this.dropLocal(teamId);
    await this.refresh();
  }

  async audit(teamId: string, before?: number): Promise<{ entries: AuditEntryView[]; hasMore: boolean }> {
    const q = new URLSearchParams({ limit: '100', ...(before ? { before: String(before) } : {}) });
    const res = await this.api<{ entries: SyncProtocol.AuditEntry[]; hasMore: boolean }>('GET', `/v1/teams/${enc(teamId)}/audit?${q}`);
    const labels = new Map<string, string | null>();
    const labelOf = (id: string | null) => {
      if (!id) return null;
      if (!labels.has(id)) {
        const row = this.deps.store.getSyncRow(id);
        const label = row && !row.deleted ? row.fields.label : null;
        labels.set(id, typeof label === 'string' ? label : null);
      }
      return labels.get(id)!;
    };
    return {
      entries: res.entries.map((e) => ({ ...e, itemLabel: labelOf(e.itemId) })),
      hasMore: res.hasMore,
    };
  }

  vaults(): VaultSummary[] {
    const v = this.deps.vault;
    return [
      { id: v.id, kind: 'personal', name: '', teamId: null, role: null, writable: true },
      ...v.teamVaults().map((t) => ({ id: t.id, kind: 'team' as const, name: t.name, teamId: t.teamId, role: t.role, writable: t.role !== 'viewer' })),
    ];
  }

  /** Moves items between vaults (re-sealing their secrets), then syncs. */
  move(kind: MovableKind, ids: string[], vaultId: string): { moved: number } {
    const vault = this.deps.vault;
    if (!vault.has(vaultId)) throw new AppError('not_found', 'errors.notFound');
    let moved = 0;
    this.deps.store.transaction(() => {
      for (const id of ids) {
        const row = this.deps.store.getSyncRow(id);
        if (!row || row.type !== kind) continue;
        if (this.deps.store.moveToVault(id, vaultId, (fields, from) => vault.resealFields(fields, id, from, vaultId))) moved++;
      }
    });
    if (moved) this.sync.schedule(500);
    return { moved };
  }

  private summary(t: SyncProtocol.TeamWire): TeamSummary {
    const local = this.deps.vault.teamVault(t.vaultId);
    return {
      id: t.id,
      vaultId: t.vaultId,
      name: local?.name || null,
      role: t.role,
      status: t.status,
      memberCount: t.memberCount,
      needsRotation: t.needsRotation,
      keyGen: t.keyGen,
    };
  }

  private teamVault(teamId: string) {
    this.requireSignedIn();
    const tv = this.deps.vault.teamVaultByTeam(teamId);
    if (!tv) throw new AppError('not_confirmed', 'teams.error.notConfirmed');
    return tv;
  }

  private dropLocal(teamId: string): void {
    const tv = this.deps.vault.teamVaultByTeam(teamId);
    if (!tv) return;
    this.deps.vault.removeTeamVault(tv.id);
    this.deps.onRemoteChange(new Set(['host', 'group', 'key', 'identity', 'known_host', 'forward', 'snippet']));
  }

  private async refresh(): Promise<void> {
    const touched = new Set<ItemType>();
    await this.sync.refreshTeams(touched);
    if (touched.size) this.deps.onRemoteChange(touched);
    this.sync.schedule(0);
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      return await this.sync.authed<T>(method, path, body);
    } catch (e) {
      if (e instanceof SyncHttpError) {
        log.warn({ path: path.replace(/\/[0-9a-f-]{36}/g, '/:id'), status: e.status, code: e.code }, 'team request failed');
        throw e;
      }
      log.error({ err: errInfo(e) }, 'team request failed');
      throw e;
    }
  }
}

const enc = encodeURIComponent;
