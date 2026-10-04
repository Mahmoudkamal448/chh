import type { Change } from '@chh/shared/sync';
import type {
  AuditRecord,
  DeviceRecord,
  InviteRecord,
  MemberRecord,
  PushOutcome,
  RotateInput,
  Store,
  TeamRecord,
  TokenRecord,
  UserRecord,
  VaultRecord,
} from './types';

interface ItemRow extends Change {
  vaultId: string;
}

/** In-memory store for tests and local development. Not durable. */
export class MemoryStore implements Store {
  users = new Map<string, UserRecord>();
  devices = new Map<string, DeviceRecord>();
  tokens = new Map<string, TokenRecord>();
  vaults = new Map<string, VaultRecord>();
  items = new Map<string, ItemRow>();
  teams = new Map<string, TeamRecord>();
  /** key: `${teamId}/${userId}` */
  members = new Map<string, MemberRecord>();
  invites = new Map<string, InviteRecord>();
  audit: AuditRecord[] = [];

  async migrate() {}
  async close() {}

  async createUser(u: UserRecord, d: DeviceRecord, v: VaultRecord) {
    if ([...this.users.values()].some((x) => x.email === u.email)) throw Object.assign(new Error('exists'), { code: 'EXISTS' });
    if (this.vaults.has(v.id)) throw Object.assign(new Error('vault exists'), { code: 'EXISTS' });
    this.users.set(u.id, structuredClone(u));
    this.devices.set(d.id, { ...d });
    this.vaults.set(v.id, { ...v });
  }
  async getUserByEmail(email: string) {
    const u = [...this.users.values()].find((x) => x.email === email);
    return u ? structuredClone(u) : null;
  }
  async getUser(id: string) {
    const u = this.users.get(id);
    return u ? structuredClone(u) : null;
  }
  async updateUser(id: string, patch: Partial<UserRecord>) {
    const u = this.users.get(id);
    if (u) this.users.set(id, { ...u, ...structuredClone(patch) });
  }
  async deleteUser(id: string) {
    this.users.delete(id);
    for (const [k, m] of this.members) if (m.userId === id) this.members.delete(k);
    for (const [k, d] of this.devices) if (d.userId === id) this.devices.delete(k);
    for (const [k, t] of this.tokens) if (t.userId === id) this.tokens.delete(k);
    for (const [k, v] of this.vaults) {
      if (v.ownerUserId !== id) continue;
      this.vaults.delete(k);
      for (const [ik, it] of this.items) if (it.vaultId === k) this.items.delete(ik);
    }
  }

  async createDevice(d: DeviceRecord) {
    this.devices.set(d.id, { ...d });
  }
  async listDevices(userId: string) {
    return [...this.devices.values()].filter((d) => d.userId === userId).map((d) => ({ ...d }));
  }
  async touchDevice(id: string, at: number) {
    const d = this.devices.get(id);
    if (d) d.lastSeenAt = at;
  }
  async deleteDevice(userId: string, id: string) {
    const d = this.devices.get(id);
    if (!d || d.userId !== userId) return false;
    this.devices.delete(id);
    await this.revokeDeviceTokens(id);
    return true;
  }

  async saveToken(t: TokenRecord) {
    this.tokens.set(t.hash, { ...t });
  }
  async getToken(hash: string) {
    const t = this.tokens.get(hash);
    return t ? { ...t } : null;
  }
  async revokeToken(hash: string) {
    const t = this.tokens.get(hash);
    if (t) t.revoked = true;
  }
  async revokeDeviceTokens(deviceId: string) {
    for (const t of this.tokens.values()) if (t.deviceId === deviceId) t.revoked = true;
  }
  async revokeUserTokens(userId: string, keepDeviceId?: string) {
    for (const t of this.tokens.values()) if (t.userId === userId && t.deviceId !== keepDeviceId) t.revoked = true;
  }

  async listVaults(userId: string) {
    return [...this.vaults.values()].filter((v) => v.ownerUserId === userId).map((v) => ({ ...v }));
  }
  async getVault(id: string) {
    const v = this.vaults.get(id);
    return v ? { ...v } : null;
  }

  async itemIds(vaultId: string) {
    return [...this.items.values()].filter((i) => i.vaultId === vaultId).map((i) => i.itemId);
  }
  async pull(vaultId: string, since: number, limit: number) {
    return [...this.items.values()]
      .filter((i) => i.vaultId === vaultId && i.seq > since)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map(({ vaultId: _v, ...c }) => ({ ...c }));
  }
  async push(vaultId: string, c: { itemId: string; baseRev: number; nonce: string; ciphertext: string }): Promise<PushOutcome> {
    const key = `${vaultId}/${c.itemId}`;
    const cur = this.items.get(key);
    const vault = this.vaults.get(vaultId)!;
    if ((cur?.rev ?? 0) !== c.baseRev) {
      const { vaultId: _v, ...current } = cur!;
      return { status: 'conflict', current };
    }
    vault.seq += 1;
    const row: ItemRow = { vaultId, itemId: c.itemId, rev: (cur?.rev ?? 0) + 1, seq: vault.seq, nonce: c.nonce, ciphertext: c.ciphertext };
    this.items.set(key, row);
    return { status: 'ok', rev: row.rev, seq: row.seq };
  }

  // --- teams -----------------------------------------------------------------------------------

  async createTeam(team: TeamRecord, vault: VaultRecord, owner: MemberRecord) {
    if (this.teams.has(team.id) || this.vaults.has(vault.id)) throw Object.assign(new Error('exists'), { code: 'EXISTS' });
    this.teams.set(team.id, { ...team });
    this.vaults.set(vault.id, { ...vault });
    this.members.set(`${team.id}/${owner.userId}`, { ...owner });
  }
  async getTeam(id: string) {
    const t = this.teams.get(id);
    return t ? { ...t } : null;
  }
  async updateTeam(id: string, patch: { nameEnc: string }) {
    const t = this.teams.get(id);
    if (t) t.nameEnc = patch.nameEnc;
  }
  async deleteTeam(id: string) {
    const t = this.teams.get(id);
    if (!t) return;
    this.teams.delete(id);
    this.vaults.delete(t.vaultId);
    for (const [k, it] of this.items) if (it.vaultId === t.vaultId) this.items.delete(k);
    for (const [k, m] of this.members) if (m.teamId === id) this.members.delete(k);
    for (const [k, i] of this.invites) if (i.teamId === id) this.invites.delete(k);
  }
  async listTeams(userId: string) {
    const out = [];
    for (const m of this.members.values()) {
      if (m.userId !== userId) continue;
      const team = this.teams.get(m.teamId)!;
      const memberCount = [...this.members.values()].filter((x) => x.teamId === m.teamId).length;
      out.push({ team: { ...team }, member: { ...m }, vault: { ...this.vaults.get(team.vaultId)! }, memberCount });
    }
    return out;
  }
  async ownedTeamCount(userId: string) {
    return [...this.members.values()].filter((m) => m.userId === userId && m.role === 'owner').length;
  }

  async listMembers(teamId: string) {
    return [...this.members.values()]
      .filter((m) => m.teamId === teamId)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((m) => {
        const u = this.users.get(m.userId)!;
        return { ...m, email: u.email, publicKey: u.publicKey };
      });
  }
  async getMember(teamId: string, userId: string) {
    const m = this.members.get(`${teamId}/${userId}`);
    return m ? { ...m } : null;
  }
  async addMember(m: MemberRecord) {
    this.members.set(`${m.teamId}/${m.userId}`, { ...m });
  }
  async updateMember(teamId: string, userId: string, patch: Partial<MemberRecord>) {
    const m = this.members.get(`${teamId}/${userId}`);
    if (m) Object.assign(m, patch);
  }
  async removeMember(teamId: string, userId: string) {
    this.members.delete(`${teamId}/${userId}`);
  }
  async setNeedsRotation(vaultId: string, value: boolean) {
    const v = this.vaults.get(vaultId);
    if (v) v.needsRotation = value;
  }

  async createInvite(i: InviteRecord) {
    if ([...this.invites.values()].some((x) => x.teamId === i.teamId && x.email === i.email)) throw Object.assign(new Error('exists'), { code: 'EXISTS' });
    this.invites.set(i.id, { ...i });
  }
  async getInvite(id: string) {
    const i = this.invites.get(id);
    return i ? { ...i } : null;
  }
  async listInvitesForEmail(email: string) {
    return [...this.invites.values()].filter((i) => i.email === email).map((i) => ({ ...i }));
  }
  async listInvitesForTeam(teamId: string) {
    return [...this.invites.values()].filter((i) => i.teamId === teamId).map((i) => ({ ...i }));
  }
  async deleteInvite(id: string) {
    this.invites.delete(id);
  }

  async rotateTeamVault(teamId: string, vaultId: string, r: RotateInput) {
    const vault = this.vaults.get(vaultId)!;
    if (vault.seq !== r.baseSeq) return { status: 'stale' as const };
    for (const it of r.items) {
      const key = `${vaultId}/${it.itemId}`;
      const cur = this.items.get(key)!;
      vault.seq += 1;
      this.items.set(key, { vaultId, itemId: it.itemId, rev: cur.rev + 1, seq: vault.seq, nonce: it.nonce, ciphertext: it.ciphertext });
    }
    for (const id of r.remove) this.members.delete(`${teamId}/${id}`);
    for (const m of r.members) Object.assign(this.members.get(`${teamId}/${m.userId}`)!, { keyWrapped: m.keyWrapped, keyGen: r.keyGen });
    vault.keyGen = r.keyGen;
    vault.needsRotation = false;
    this.teams.get(teamId)!.nameEnc = r.nameEnc;
    return { status: 'ok' as const, seq: vault.seq };
  }

  async appendAudit(entries: Array<Omit<AuditRecord, 'id'>>) {
    for (const e of entries) this.audit.push({ ...structuredClone(e), id: this.audit.length + 1 });
  }
  async listAudit(teamId: string, before: number | undefined, limit: number) {
    return this.audit
      .filter((a) => a.teamId === teamId && (before === undefined || a.id < before))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map((a) => structuredClone(a));
  }
}
