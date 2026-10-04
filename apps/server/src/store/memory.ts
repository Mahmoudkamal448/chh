import type { Change } from '@cy-ssh/shared/sync';
import type { DeviceRecord, PushOutcome, Store, TokenRecord, UserRecord, VaultRecord } from './types';

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
}
