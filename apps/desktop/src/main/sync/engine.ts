import { hostname } from 'node:os';
import type { SyncProtocol, SyncStatus } from '@cy-ssh/shared';
import { compareVv, mergeReplicas, type Replica } from '@cy-ssh/sync-core';
import {
  DEFAULT_KDF,
  MIN_KDF,
  createAccountSecrets,
  decryptItem,
  deriveMasterKey,
  deriveSubkey,
  encryptItem,
  memzero,
  newKdfParams,
  newRecoveryKey,
  parseRecoveryKey,
  rewrapAccountKey,
  splitMasterKey,
  unwrapAccountKey,
  unwrapAccountKeyWithRecovery,
  unwrapVaultKey,
  wrapAccount,
  wrapVaultKey,
  type KdfParams,
} from '@cy-ssh/vault-crypto';
import type { Db } from '../db/database';
import type { ItemStore, ItemType } from '../db/item-store';
import { errInfo, log } from '../log';
import type { LocalVault } from '../vault/local-vault';
import { SyncHttpError, normalizeServerUrl, request } from './http';

type Tokens = SyncProtocol.Tokens;
type AccountWire = SyncProtocol.AccountWire;

interface StoredSecrets {
  accessToken: string;
  refreshToken: string;
  accessExpires: number;
  accountKey: string;
}

interface Account {
  serverUrl: string;
  email: string;
  userId: string;
  deviceId: string;
  kdf: KdfParams;
  totp: boolean;
  lastSync: number | null;
  secrets: StoredSecrets;
}

export type LoginResult = { status: 'ok' } | { status: 'totp_required' };

const PUSH_BATCH = 200;
const PERIODIC_MS = 5 * 60_000;
const SECRETS_CONTEXT = 'sync-account';

/**
 * Offline-first sync of the personal vault with a cy-ssh server. Local writes never wait for the
 * network; the engine pulls, merges (version vectors + per-field HLC last-writer-wins) and pushes in
 * the background. The server only ever sees ciphertext.
 */
export class SyncEngine {
  private account: Account | null = null;
  private state: SyncStatus['state'] = 'off';
  private error: string | undefined;
  private running = false;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private periodic: ReturnType<typeof setInterval> | null = null;
  private ws: WebSocket | null = null;
  private wsRetry = 0;
  private stopped = true;

  constructor(
    private readonly deps: {
      db: Db;
      store: ItemStore;
      vault: LocalVault;
      onStatus(s: SyncStatus): void;
      onRemoteChange(types: Set<ItemType>): void;
      /** Override the password KDF cost (tests). */
      kdfCost?: { ops: number; mem: number };
      deviceName?: string;
    },
  ) {
    this.account = this.loadAccount();
    deps.store.onLocalChange(() => this.schedule(1500));
  }

  // --- public API ------------------------------------------------------------------------------

  status(): SyncStatus {
    const a = this.account;
    const pending = (this.deps.db.prepare('SELECT count(*) AS n FROM items WHERE vault_id = ? AND dirty = 1').get(this.deps.vault.id) as { n: number }).n;
    return {
      signedIn: !!a,
      serverUrl: a?.serverUrl ?? null,
      email: a?.email ?? null,
      state: a ? this.state : 'off',
      lastSyncAt: a?.lastSync ?? null,
      error: this.error,
      totpEnabled: a?.totp ?? false,
      pending: a ? pending : 0,
    };
  }

  /** Starts background sync if signed in (call once at startup). */
  start(): void {
    if (!this.account) return;
    this.stopped = false;
    this.state = 'idle';
    this.connectWs();
    this.periodic ??= setInterval(() => this.schedule(0), PERIODIC_MS);
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.periodic) clearInterval(this.periodic);
    this.periodic = null;
    this.ws?.close();
    this.ws = null;
  }

  async register(input: { serverUrl: string; email: string; password: string }): Promise<{ recoveryKey: string }> {
    const { url } = normalizeServerUrl(input.serverUrl);
    const email = input.email.trim().toLowerCase();
    const kdf = newKdfParams(this.deps.kdfCost ?? DEFAULT_KDF);
    const master = await deriveMasterKey(input.password, kdf);
    const { authKey, kek } = splitMasterKey(master);
    const secrets = createAccountSecrets();
    const recovery = newRecoveryKey();
    const recoveryAuthKey = deriveSubkey(recovery.key, 3, 'cy-rcvau');
    const vault = this.deps.vault;
    try {
      const res = await request<{ tokens: Tokens; account: AccountWire }>(url, 'POST', '/v1/auth/register', {
        email,
        authKey: authKey.toString('base64'),
        recoveryAuthKey: recoveryAuthKey.toString('base64'),
        kdf,
        blobs: wrapAccount(secrets, kek, recovery.key, email),
        vault: { id: vault.id, keyWrapped: wrapVaultKey(vault.key, secrets.accountKey, vault.id) },
        device: this.deviceInfo(),
      });
      this.deps.store.resetSyncState();
      this.setCursor(0);
      this.saveAccount(url, res.tokens, res.account, secrets.accountKey);
      this.start();
      return { recoveryKey: recovery.text };
    } finally {
      [master, authKey, kek, recoveryAuthKey, recovery.key, secrets.privateKey].forEach(memzero);
    }
  }

  async login(input: { serverUrl: string; email: string; password: string; totp?: string; recoveryCode?: string }): Promise<LoginResult> {
    const { url } = normalizeServerUrl(input.serverUrl);
    const email = input.email.trim().toLowerCase();
    const { kdf } = await request<{ kdf: KdfParams }>(url, 'POST', '/v1/auth/prelogin', { email });
    this.assertKdf(kdf);
    const master = await deriveMasterKey(input.password, kdf);
    const { authKey, kek } = splitMasterKey(master);
    try {
      const res = await request<{ tokens: Tokens; account: AccountWire }>(url, 'POST', '/v1/auth/login', {
        email,
        authKey: authKey.toString('base64'),
        totp: input.totp || undefined,
        recoveryCode: input.recoveryCode || undefined,
        device: this.deviceInfo(),
      });
      const accountKey = unwrapAccountKey(res.account.blobs.accountKeyWrapped, kek, email);
      await this.joinAccount(url, res.tokens, res.account, accountKey);
      return { status: 'ok' };
    } catch (e) {
      if (e instanceof SyncHttpError && e.code === 'totp_required') return { status: 'totp_required' };
      throw e;
    } finally {
      [master, authKey, kek].forEach(memzero);
    }
  }

  /** Forgotten password: unlock the account with the recovery key and set a new password. */
  async recover(input: { serverUrl: string; email: string; recoveryKey: string; newPassword: string; totp?: string; recoveryCode?: string }): Promise<LoginResult> {
    const { url } = normalizeServerUrl(input.serverUrl);
    const email = input.email.trim().toLowerCase();
    const recoveryKey = parseRecoveryKey(input.recoveryKey);
    const recoveryAuthKey = deriveSubkey(recoveryKey, 3, 'cy-rcvau');
    try {
      let start: { recoveryToken: string; recoveryWrapped: string; kdf: KdfParams };
      try {
        start = await request(url, 'POST', '/v1/auth/recover/start', {
          email,
          recoveryAuthKey: recoveryAuthKey.toString('base64'),
          totp: input.totp || undefined,
          recoveryCode: input.recoveryCode || undefined,
        });
      } catch (e) {
        if (e instanceof SyncHttpError && e.code === 'totp_required') return { status: 'totp_required' };
        throw e;
      }
      const accountKey = unwrapAccountKeyWithRecovery(start.recoveryWrapped, recoveryKey, email);
      const kdf = newKdfParams(this.deps.kdfCost ?? DEFAULT_KDF);
      const master = await deriveMasterKey(input.newPassword, kdf);
      const { authKey, kek } = splitMasterKey(master);
      const res = await request<{ tokens: Tokens; account: AccountWire }>(url, 'POST', '/v1/auth/recover/finish', {
        recoveryToken: start.recoveryToken,
        newAuthKey: authKey.toString('base64'),
        newKdf: kdf,
        accountKeyWrapped: rewrapAccountKey(accountKey, kek, email),
        device: this.deviceInfo(),
      });
      [master, authKey, kek].forEach(memzero);
      await this.joinAccount(url, res.tokens, res.account, accountKey);
      return { status: 'ok' };
    } finally {
      memzero(recoveryKey);
      memzero(recoveryAuthKey);
    }
  }

  /** Signs out. With keepData=false all synced items are removed from this device. */
  async logout(keepData: boolean): Promise<void> {
    const a = this.account;
    if (a) {
      try {
        await this.authed('POST', '/v1/auth/logout');
      } catch (e) {
        log.warn({ err: errInfo(e) }, 'server logout failed (continuing locally)');
      }
    }
    this.signOutLocally(keepData);
  }

  async syncNow(): Promise<void> {
    await this.runSync();
    if (this.state === 'error' && this.error) throw new SyncHttpError(0, this.error);
  }

  devices(): Promise<SyncProtocol.DeviceWire[]> {
    return this.authed('GET', '/v1/devices');
  }

  async removeDevice(id: string): Promise<void> {
    await this.authed('DELETE', `/v1/devices/${encodeURIComponent(id)}`);
  }

  async changePassword(current: string, next: string): Promise<void> {
    const a = this.requireAccount();
    const oldKeys = splitMasterKey(await deriveMasterKey(current, a.kdf));
    const kdf = newKdfParams(this.deps.kdfCost ?? DEFAULT_KDF);
    const newKeys = splitMasterKey(await deriveMasterKey(next, kdf));
    const accountKey = Buffer.from(a.secrets.accountKey, 'base64');
    try {
      await this.authed('POST', '/v1/account/password', {
        currentAuthKey: oldKeys.authKey.toString('base64'),
        newAuthKey: newKeys.authKey.toString('base64'),
        newKdf: kdf,
        accountKeyWrapped: rewrapAccountKey(accountKey, newKeys.kek, a.email),
      });
      a.kdf = kdf;
      this.persist();
    } finally {
      [oldKeys.authKey, oldKeys.kek, newKeys.authKey, newKeys.kek, accountKey].forEach(memzero);
    }
  }

  totpSetup(): Promise<{ secret: string; uri: string }> {
    return this.authed('POST', '/v1/account/totp/setup', {});
  }

  async totpEnable(code: string): Promise<{ recoveryCodes: string[] }> {
    const res = await this.authed<{ recoveryCodes: string[] }>('POST', '/v1/account/totp/enable', { code });
    this.requireAccount().totp = true;
    this.persist();
    return res;
  }

  async totpDisable(input: { code?: string; recoveryCode?: string }): Promise<void> {
    await this.authed('POST', '/v1/account/totp/disable', input);
    this.requireAccount().totp = false;
    this.persist();
  }

  async deleteAccount(password: string): Promise<void> {
    const a = this.requireAccount();
    const { authKey, kek } = splitMasterKey(await deriveMasterKey(password, a.kdf));
    try {
      await this.authed('DELETE', '/v1/account', { authKey: authKey.toString('base64') });
    } finally {
      memzero(authKey);
      memzero(kek);
    }
    this.signOutLocally(true);
  }

  // --- background sync -------------------------------------------------------------------------

  schedule(delayMs: number): void {
    if (!this.account || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.runSync(), delayMs);
  }

  private async runSync(): Promise<void> {
    if (!this.account) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.setState('syncing');
    try {
      do {
        this.again = false;
        await this.syncOnce();
      } while (this.again && this.account);
      if (this.account) {
        this.account.lastSync = Date.now();
        this.persist();
        this.error = undefined;
        this.setState('idle');
      }
    } catch (e) {
      const err = e as SyncHttpError;
      if (err.status === 401) return; // handled by signOutRemotely
      log.warn({ err: errInfo(e) }, 'sync failed');
      this.error = err.code === 'network' ? 'sync.error.network' : `sync.error.${err.code ?? 'generic'}`;
      this.setState(err.code === 'network' ? 'offline' : 'error');
      // Retry later with the periodic timer; a network change will usually trigger WS reconnect first.
    } finally {
      this.running = false;
    }
  }

  private async syncOnce(): Promise<void> {
    const vault = this.deps.vault;
    const touched = new Set<ItemType>();
    // Pull everything new first, so pushes are based on the latest revisions.
    for (;;) {
      const since = this.cursor();
      const page = await this.authed<{ changes: SyncProtocol.Change[]; nextSince: number; hasMore: boolean }>('POST', '/v1/sync/pull', {
        vaultId: vault.id,
        since,
        limit: 500,
      });
      this.deps.db.transaction(() => {
        for (const c of page.changes) this.applyRemote(c, touched);
        this.setCursor(page.nextSince);
      })();
      if (!page.hasMore) break;
    }
    // Push local changes; conflicts are merged and pushed again in the next round.
    for (let round = 0; round < 6; round++) {
      const rows = this.deps.store.dirtyRows(vault.id, PUSH_BATCH);
      if (!rows.length) break;
      const changes = rows.map((r) => ({
        itemId: r.id,
        baseRev: r.serverRev ?? 0,
        ...encryptItem({ type: r.type, fields: r.fields, clocks: r.clocks, vv: r.vv }, vault.key, vault.id, r.id),
      }));
      const { results } = await this.authed<{ results: SyncProtocol.PushResult[] }>('POST', '/v1/sync/push', { vaultId: vault.id, changes });
      let conflicts = 0;
      this.deps.db.transaction(() => {
        for (const res of results) {
          const row = rows.find((r) => r.id === res.itemId)!;
          if (res.status === 'ok') this.deps.store.markPushed(res.itemId, res.rev, row.updatedAt);
          else {
            conflicts++;
            this.applyRemote(res.current, touched);
          }
        }
      })();
      if (rows.length < PUSH_BATCH && !conflicts) break;
    }
    if (touched.size) this.deps.onRemoteChange(touched);
  }

  /** Merges one server change into the local store. */
  private applyRemote(change: SyncProtocol.Change, touched: Set<ItemType>): void {
    const vault = this.deps.vault;
    let payload: { type: ItemType; fields: Record<string, unknown>; clocks: Record<string, string>; vv: Record<string, number> };
    try {
      payload = decryptItem(change, vault.key, vault.id, change.itemId);
    } catch {
      log.warn({ itemId: change.itemId }, 'skipping undecryptable item from server');
      return;
    }
    const store = this.deps.store;
    store.observeClocks(payload.clocks);
    const remote: Replica = { fields: payload.fields, clocks: payload.clocks, vv: payload.vv };
    const local = store.getSyncRow(change.itemId);
    const write = (replica: Replica, dirty: boolean) =>
      store.writeSynced({ id: change.itemId, vaultId: vault.id, type: payload.type, replica, serverRev: change.rev, dirty });

    if (!local) {
      write(remote, false);
    } else {
      const order = compareVv(local.vv, remote.vv);
      if (order === 'before' || order === 'equal') write(remote, false);
      else if (order === 'after') {
        // We already have a newer version: our pending edit, or the server served stale/rolled-back
        // data. Never go backwards; keep ours and upload it again.
        if (!local.dirty) log.warn({ itemId: change.itemId }, 'server sent an older version of an item; keeping the newer local one');
        write({ fields: local.fields, clocks: local.clocks, vv: local.vv }, true);
      } else {
        const merged = mergeReplicas({ fields: local.fields, clocks: local.clocks, vv: local.vv }, remote);
        write({ ...merged, vv: store.bumpVv(merged.vv) }, true);
      }
    }
    touched.add(payload.type);
  }

  // --- auth plumbing ---------------------------------------------------------------------------

  private async authed<T>(method: string, path: string, body?: unknown): Promise<T> {
    const a = this.requireAccount();
    if (Date.now() > a.secrets.accessExpires - 60_000) await this.refresh();
    try {
      return await request<T>(a.serverUrl, method, path, body, a.secrets.accessToken);
    } catch (e) {
      if (!(e instanceof SyncHttpError) || e.status !== 401) throw e;
      await this.refresh();
      return request<T>(a.serverUrl, method, path, body, this.requireAccount().secrets.accessToken);
    }
  }

  private async refresh(): Promise<void> {
    const a = this.requireAccount();
    try {
      const t = await request<Tokens>(a.serverUrl, 'POST', '/v1/auth/refresh', { refreshToken: a.secrets.refreshToken });
      a.secrets = { ...a.secrets, accessToken: t.accessToken, refreshToken: t.refreshToken, accessExpires: Date.now() + t.expiresIn * 1000 };
      this.persist();
    } catch (e) {
      if (e instanceof SyncHttpError && e.status === 401) {
        // This device was removed, or the password was changed elsewhere.
        this.signOutLocally(true, 'sync.error.signedOutRemotely');
      }
      throw e;
    }
  }

  private connectWs(): void {
    const a = this.account;
    if (!a || this.stopped || typeof WebSocket === 'undefined') return;
    const url = a.serverUrl.replace(/^http/, 'ws') + '/v1/sync/ws';
    const ws = new WebSocket(url);
    this.ws = ws;
    let ping: ReturnType<typeof setInterval> | null = null;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: this.account?.secrets.accessToken }));
      ping = setInterval(() => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'ping' })), 30_000);
    };
    ws.onmessage = (ev) => {
      let msg: SyncProtocol.WsServerMessage;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'ready') {
        this.wsRetry = 0;
        this.schedule(0);
      } else if (msg.type === 'changed' && msg.vaultId === this.deps.vault.id && msg.seq > this.cursor()) this.schedule(150);
    };
    ws.onclose = (ev) => {
      if (ping) clearInterval(ping);
      if (this.ws !== ws || this.stopped || !this.account) return;
      // Auth failures: refresh the token via a normal sync round before reconnecting.
      if (ev.code === 4001) this.schedule(0);
      const delay = Math.min(60_000, 1000 * 2 ** this.wsRetry++) + Math.random() * 1000;
      setTimeout(() => this.ws === ws && this.connectWs(), delay);
    };
    ws.onerror = () => undefined;
  }

  // --- persistence -----------------------------------------------------------------------------

  private async joinAccount(serverUrl: string, tokens: Tokens, account: AccountWire, accountKey: Buffer): Promise<void> {
    const personal = account.vaults.find((v) => v.kind === 'personal');
    if (!personal) throw new SyncHttpError(0, 'no_vault');
    const vaultKey = unwrapVaultKey(personal.keyWrapped, accountKey, personal.id);
    // Move local data into the account's vault (re-sealing secrets), then upload/merge everything.
    this.deps.vault.adopt(personal.id, vaultKey);
    this.deps.store.setVaultId(personal.id);
    memzero(vaultKey);
    this.deps.store.resetSyncState();
    this.setCursor(0);
    this.saveAccount(serverUrl, tokens, account, accountKey);
    this.start();
  }

  private saveAccount(serverUrl: string, tokens: Tokens, account: AccountWire, accountKey: Buffer): void {
    this.account = {
      serverUrl,
      email: account.email,
      userId: account.userId,
      deviceId: tokens.deviceId,
      kdf: account.kdf,
      totp: account.totpEnabled,
      lastSync: null,
      secrets: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessExpires: Date.now() + tokens.expiresIn * 1000,
        accountKey: accountKey.toString('base64'),
      },
    };
    this.error = undefined;
    this.persist();
    this.setState('idle');
  }

  private persist(): void {
    const a = this.account;
    if (!a) return;
    const sealed = JSON.stringify(this.deps.vault.sealLocal(JSON.stringify(a.secrets), SECRETS_CONTEXT));
    this.deps.db
      .prepare(
        `INSERT INTO sync_account (id, server_url, email, user_id, device_id, kdf, secrets, totp, last_sync) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET server_url = excluded.server_url, email = excluded.email, user_id = excluded.user_id,
           device_id = excluded.device_id, kdf = excluded.kdf, secrets = excluded.secrets, totp = excluded.totp, last_sync = excluded.last_sync`,
      )
      .run(a.serverUrl, a.email, a.userId, a.deviceId, JSON.stringify(a.kdf), sealed, a.totp ? 1 : 0, a.lastSync);
  }

  private loadAccount(): Account | null {
    const r = this.deps.db.prepare('SELECT * FROM sync_account WHERE id = 1').get() as
      | { server_url: string; email: string; user_id: string; device_id: string; kdf: string; secrets: string; totp: number; last_sync: number | null }
      | undefined;
    if (!r) return null;
    try {
      return {
        serverUrl: r.server_url,
        email: r.email,
        userId: r.user_id,
        deviceId: r.device_id,
        kdf: JSON.parse(r.kdf),
        totp: r.totp === 1,
        lastSync: r.last_sync,
        secrets: JSON.parse(this.deps.vault.openLocal(JSON.parse(r.secrets), SECRETS_CONTEXT)),
      };
    } catch (e) {
      log.error({ err: errInfo(e) }, 'stored sync account is unreadable; signing out');
      this.deps.db.prepare('DELETE FROM sync_account').run();
      return null;
    }
  }

  private signOutLocally(keepData: boolean, error?: string): void {
    this.stop();
    this.account = null;
    this.deps.db.prepare('DELETE FROM sync_account').run();
    if (keepData) this.deps.store.resetSyncState();
    else this.deps.db.prepare('DELETE FROM items').run();
    this.setCursor(0);
    this.error = error;
    this.state = 'off';
    this.emit();
    if (!keepData) this.deps.onRemoteChange(new Set(['host', 'group', 'key', 'identity', 'known_host', 'forward', 'snippet']));
  }

  private cursor(): number {
    const r = this.deps.db.prepare('SELECT sync_cursor FROM vaults WHERE id = ?').get(this.deps.vault.id) as { sync_cursor: number } | undefined;
    return r?.sync_cursor ?? 0;
  }

  private setCursor(n: number): void {
    this.deps.db.prepare('UPDATE vaults SET sync_cursor = ? WHERE id = ?').run(n, this.deps.vault.id);
  }

  private requireAccount(): Account {
    if (!this.account) throw new SyncHttpError(0, 'not_signed_in');
    return this.account;
  }

  private assertKdf(kdf: KdfParams): void {
    const min = this.deps.kdfCost ? { ops: Math.min(MIN_KDF.ops, this.deps.kdfCost.ops), mem: Math.min(MIN_KDF.mem, this.deps.kdfCost.mem) } : MIN_KDF;
    // A malicious or compromised server could hand out a weak KDF to make cracking easier.
    if (kdf.alg !== 'argon2id13' || kdf.ops < min.ops || kdf.mem < min.mem) throw new SyncHttpError(0, 'weak_kdf');
  }

  private deviceInfo() {
    return { name: (this.deps.deviceName ?? hostname()).slice(0, 100) || 'device', platform: process.platform };
  }

  private setState(s: SyncStatus['state']): void {
    this.state = s;
    this.emit();
  }

  private emit(): void {
    this.deps.onStatus(this.status());
  }
}

