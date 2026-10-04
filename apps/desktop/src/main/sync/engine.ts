import { hostname } from 'node:os';
import type { SyncProtocol, SyncStatus } from '@chh/shared';
import { DELETED_FIELD, compareVv, mergeReplicas, type Replica } from '@chh/sync-core';
import {
  DEFAULT_KDF,
  MIN_KDF,
  createAccountSecrets,
  decryptItem,
  decryptTeamName,
  deriveMasterKey,
  deriveSubkey,
  encryptItem,
  memzero,
  newKdfParams,
  newRecoveryKey,
  openTeamKey,
  parseRecoveryKey,
  rewrapAccountKey,
  splitMasterKey,
  unwrapAccountKey,
  unwrapAccountKeyWithRecovery,
  unwrapPrivateKey,
  unwrapVaultKey,
  wrapAccount,
  wrapVaultKey,
  type KdfParams,
} from '@chh/vault-crypto';
import type { Db } from '../db/database';
import { MOVED_FIELD, type ItemStore, type ItemType } from '../db/item-store';
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
  /** X25519 key pair for team keys (the private key wrapped by the account key). */
  publicKey?: string;
  privateKeyWrapped?: string;
}

/** One vault to synchronize. Team vaults carry the key generation we hold. */
interface SyncTarget {
  id: string;
  keyGen?: number;
  writable: boolean;
}

const ALL_TYPES: ItemType[] = ['host', 'group', 'key', 'identity', 'known_host', 'forward', 'snippet'];
/** Server errors on a team vault that mean our view of the team is out of date. */
const TEAM_STALE = new Set(['stale_key', 'not_found', 'read_only']);

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
 * Offline-first sync of the personal vault with a chh server. Local writes never wait for the
 * network; the engine pulls, merges (version vectors + per-field HLC last-writer-wins) and pushes in
 * the background. The server only ever sees ciphertext.
 */
export class SyncEngine {
  private account: Account | null = null;
  private state: SyncStatus['state'] = 'off';
  private error: string | undefined;
  /** The sync run in progress; callers asking for a sync meanwhile wait for it (and its extra round). */
  private inflight: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private periodic: ReturnType<typeof setInterval> | null = null;
  private ws: WebSocket | null = null;
  private wsRetry = 0;
  private stopped = true;
  private teamList: SyncProtocol.TeamWire[] = [];

  constructor(
    private readonly deps: {
      db: Db;
      store: ItemStore;
      vault: LocalVault;
      onStatus(s: SyncStatus): void;
      onRemoteChange(types: Set<ItemType>): void;
      /** Team membership, roles or keys changed. */
      onTeamsChanged?(): void;
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
    const pending = (this.deps.db.prepare('SELECT count(*) AS n FROM items WHERE dirty = 1').get() as { n: number }).n;
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

  private runSync(): Promise<void> {
    if (!this.account) return Promise.resolve();
    if (this.inflight) {
      // Picked up by another round of the current run.
      this.again = true;
      return this.inflight;
    }
    this.inflight = this.run().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async run(): Promise<void> {
    this.setState('syncing');
    try {
      let rounds = 0;
      do {
        this.again = false;
        await this.syncOnce();
      } while (this.again && this.account && ++rounds < 5);
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
    }
  }

  private async syncOnce(): Promise<void> {
    const touched = new Set<ItemType>();
    await this.refreshTeams(touched);
    for (const target of this.targets()) {
      try {
        await this.syncVault(target, touched);
      } catch (e) {
        // A team vault we lost access to, or whose key was rotated: refresh the team list and retry.
        if (target.keyGen === undefined || !(e instanceof SyncHttpError) || !TEAM_STALE.has(e.code)) throw e;
        log.info({ vaultId: target.id, code: e.code }, 'team vault out of date; refreshing teams');
        this.again = true;
      }
    }
    await this.flushAudit();
    if (touched.size) this.deps.onRemoteChange(touched);
  }

  /** The personal vault and every team vault we hold a key for. */
  private targets(): SyncTarget[] {
    const v = this.deps.vault;
    return [{ id: v.id, writable: true }, ...v.teamVaults().map((t) => ({ id: t.id, keyGen: t.keyGen, writable: t.role !== 'viewer' }))];
  }

  private async syncVault(target: SyncTarget, touched: Set<ItemType>): Promise<void> {
    const vault = this.deps.vault;
    const store = this.deps.store;
    // Pull everything new first, so pushes are based on the latest revisions.
    for (;;) {
      const since = this.cursor(target.id);
      const page = await this.authed<SyncProtocol.PullResponseWire>('POST', '/v1/sync/pull', { vaultId: target.id, since, limit: 500 });
      if (target.keyGen !== undefined && page.keyGen !== undefined && page.keyGen !== target.keyGen) {
        // The team key was rotated: get the new key first (next round).
        throw new SyncHttpError(409, 'stale_key');
      }
      this.deps.db.transaction(() => {
        for (const c of page.changes) this.applyRemote(c, target.id, touched);
        this.setCursor(page.nextSince, target.id);
      })();
      if (!page.hasMore) break;
    }
    if (!target.writable) return;
    const key = vault.keyFor(target.id);
    // Tombstones for items moved out of this vault.
    const moves = store.pendingMoves(target.id);
    if (moves.length) {
      const changes = moves.slice(0, PUSH_BATCH).map((m) => ({
        itemId: m.itemId,
        baseRev: m.baseRev,
        ...encryptItem({ type: m.type, fields: { [DELETED_FIELD]: true, [MOVED_FIELD]: true }, clocks: {}, vv: m.vv }, key, target.id, m.itemId),
      }));
      const { results } = await this.authed<{ results: SyncProtocol.PushResult[] }>('POST', '/v1/sync/push', { vaultId: target.id, keyGen: target.keyGen, changes });
      for (const r of results) store.resolveMove(target.id, r.itemId, r.status === 'ok' ? undefined : r.current.rev);
      if (results.some((r) => r.status !== 'ok')) this.again = true;
    }
    // Push local changes; conflicts are merged and pushed again in the next round.
    for (let round = 0; round < 6; round++) {
      const rows = store.dirtyRows(target.id, PUSH_BATCH);
      if (!rows.length) break;
      const changes = rows.map((r) => ({
        itemId: r.id,
        baseRev: r.serverRev ?? 0,
        ...encryptItem({ type: r.type, fields: r.fields, clocks: r.clocks, vv: r.vv }, key, target.id, r.id),
      }));
      const { results } = await this.authed<{ results: SyncProtocol.PushResult[] }>('POST', '/v1/sync/push', { vaultId: target.id, keyGen: target.keyGen, changes });
      let conflicts = 0;
      this.deps.db.transaction(() => {
        for (const res of results) {
          const row = rows.find((r) => r.id === res.itemId)!;
          if (res.status === 'ok') store.markPushed(res.itemId, res.rev, row.updatedAt);
          else {
            conflicts++;
            this.applyRemote(res.current, target.id, touched);
          }
        }
      })();
      if (rows.length < PUSH_BATCH && !conflicts) break;
    }
  }

  /** Merges one server change of `vaultId` into the local store. */
  private applyRemote(change: SyncProtocol.Change, vaultId: string, touched: Set<ItemType>): void {
    let payload: { type: ItemType; fields: Record<string, unknown>; clocks: Record<string, string>; vv: Record<string, number> };
    try {
      payload = decryptItem(change, this.deps.vault.keyFor(vaultId), vaultId, change.itemId);
    } catch {
      log.warn({ itemId: change.itemId }, 'skipping undecryptable item from server');
      return;
    }
    const store = this.deps.store;
    store.observeClocks(payload.clocks);
    const remote: Replica = { fields: payload.fields, clocks: payload.clocks, vv: payload.vv };
    const local = store.getSyncRow(change.itemId);
    const write = (replica: Replica, dirty: boolean) =>
      store.writeSynced({ id: change.itemId, vaultId, type: payload.type, replica, serverRev: change.rev, dirty });
    const moved = payload.fields[MOVED_FIELD] === true;

    if (local && local.vaultId !== vaultId) {
      // The item lives in another vault on this device. A tombstone here is the copy it was moved
      // out of; a live copy is its new home if ours is gone or older.
      if (moved || payload.fields[DELETED_FIELD] === true) return;
      if (local.deleted || compareVv(local.vv, remote.vv) === 'before') {
        write(remote, false);
        touched.add(payload.type);
      }
      return;
    }
    if (moved) {
      // Moving an item back into a vault it once left: keep ours and overwrite the tombstone.
      if (local && !local.deleted && local.dirty && local.serverRev === null) return store.setServerRev(change.itemId, change.rev);
      // Otherwise another device moved it away; it will arrive in its new vault if we can see that.
      write({ fields: { [DELETED_FIELD]: true }, clocks: local?.clocks ?? {}, vv: remote.vv }, false);
      if (local && !local.deleted) touched.add(payload.type);
      return;
    }

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

  // --- teams -----------------------------------------------------------------------------------

  /** Team list as last fetched from the server (includes teams awaiting confirmation). */
  teams(): SyncProtocol.TeamWire[] {
    return this.teamList;
  }

  /**
   * Fetches the team list and brings local team vaults in line: adds new ones, re-keys rotated
   * ones and removes vaults we no longer belong to (with their local items).
   */
  async refreshTeams(touched: Set<ItemType> = new Set()): Promise<void> {
    const list = await this.authed<SyncProtocol.TeamWire[]>('GET', '/v1/teams');
    const vault = this.deps.vault;
    const changed = JSON.stringify(list) !== JSON.stringify(this.teamList);
    this.teamList = list;
    const keep = new Set<string>();
    let vaultsChanged = false;
    const confirmed = list.filter((t) => t.keyWrapped);
    if (confirmed.length) {
      const { publicKey, privateKey } = await this.keyPair();
      try {
        for (const t of confirmed) {
          let key: Buffer;
          try {
            key = openTeamKey(t.keyWrapped!, publicKey, privateKey);
          } catch {
            log.warn({ teamId: t.id }, 'cannot open the team key sealed for this account');
            continue;
          }
          let name = '';
          try {
            name = decryptTeamName(t.nameEnc, key, t.id);
          } catch {
            log.warn({ teamId: t.id }, 'cannot decrypt the team name');
          }
          keep.add(t.vaultId);
          const r = vault.upsertTeamVault({ id: t.vaultId, teamId: t.id, name, role: t.role, keyGen: t.keyGen }, key);
          memzero(key);
          if (r !== 'same') vaultsChanged = true;
        }
      } finally {
        memzero(privateKey);
      }
    }
    for (const tv of vault.teamVaults()) {
      if (keep.has(tv.id)) continue;
      log.info({ teamId: tv.teamId }, 'no longer a confirmed member of a team; removing its local data');
      vault.removeTeamVault(tv.id);
      vaultsChanged = true;
      for (const t of ALL_TYPES) touched.add(t);
    }
    if (changed || vaultsChanged) this.deps.onTeamsChanged?.();
  }

  /** This account's X25519 key pair (the private key must be wiped by the caller). */
  async keyPair(): Promise<{ publicKey: Buffer; privateKey: Buffer }> {
    const a = this.requireAccount();
    if (!a.secrets.publicKey || !a.secrets.privateKeyWrapped) {
      const acct = await this.authed<AccountWire>('GET', '/v1/account');
      a.secrets = { ...a.secrets, publicKey: acct.blobs.publicKey, privateKeyWrapped: acct.blobs.privateKeyWrapped };
      this.persist();
    }
    const accountKey = Buffer.from(a.secrets.accountKey, 'base64');
    try {
      return { publicKey: Buffer.from(a.secrets.publicKey!, 'base64'), privateKey: unwrapPrivateKey(a.secrets.privateKeyWrapped!, accountKey) };
    } finally {
      memzero(accountKey);
    }
  }

  get userId(): string | null {
    return this.account?.userId ?? null;
  }

  /** Records a team audit event only this app can observe; uploaded with the next sync. */
  reportAudit(vaultId: string, action: SyncProtocol.ClientAuditAction, itemId: string | null): void {
    if (!this.account || !this.deps.vault.teamVault(vaultId)) return;
    this.deps.db.prepare('INSERT INTO audit_outbox (vault_id, action, item_id, at) VALUES (?, ?, ?, ?)').run(vaultId, action, itemId, Date.now());
    this.schedule(2000);
  }

  private async flushAudit(): Promise<void> {
    const rows = this.deps.db.prepare('SELECT id, vault_id, action, item_id, at FROM audit_outbox ORDER BY id LIMIT 1000').all() as Array<{
      id: number;
      vault_id: string;
      action: SyncProtocol.ClientAuditAction;
      item_id: string | null;
      at: number;
    }>;
    const byVault = new Map<string, typeof rows>();
    for (const r of rows) byVault.set(r.vault_id, [...(byVault.get(r.vault_id) ?? []), r]);
    const done = this.deps.db.prepare('DELETE FROM audit_outbox WHERE id = ?');
    for (const [vaultId, events] of byVault) {
      const team = this.deps.vault.teamVault(vaultId);
      try {
        for (let i = 0; team && i < events.length; i += 200) {
          const batch = events.slice(i, i + 200);
          await this.authed('POST', `/v1/teams/${encodeURIComponent(team.teamId)}/audit`, {
            events: batch.map((e) => ({ action: e.action, itemId: e.item_id, at: e.at })),
          });
        }
      } catch (e) {
        // Keep the events for later unless the server refused them for good.
        if (!(e instanceof SyncHttpError) || e.status === 0 || e.status >= 500) throw e;
        log.warn({ err: errInfo(e) }, 'team audit events rejected');
      }
      this.deps.db.transaction(() => events.forEach((e) => done.run(e.id)))();
    }
  }

  // --- auth plumbing ---------------------------------------------------------------------------

  /** Authenticated request to the sync server (refreshes the access token as needed). */
  async authed<T>(method: string, path: string, body?: unknown): Promise<T> {
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
      } else if (msg.type === 'changed' && this.deps.vault.has(msg.vaultId) && msg.seq > this.cursor(msg.vaultId)) this.schedule(150);
      else if (msg.type === 'changed' || msg.type === 'teams') this.schedule(150);
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
        publicKey: account.blobs.publicKey,
        privateKeyWrapped: account.blobs.privateKeyWrapped,
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
    this.teamList = [];
    this.deps.db.prepare('DELETE FROM sync_account').run();
    // Team data belongs to the team: it never stays behind on a signed-out device.
    const hadTeams = this.deps.vault.teamVaults().length > 0;
    for (const t of this.deps.vault.teamVaults()) this.deps.vault.removeTeamVault(t.id);
    this.deps.db.prepare('DELETE FROM vault_moves').run();
    this.deps.db.prepare('DELETE FROM audit_outbox').run();
    if (keepData) this.deps.store.resetSyncState();
    else this.deps.db.prepare('DELETE FROM items').run();
    this.setCursor(0);
    this.error = error;
    this.state = 'off';
    this.emit();
    if (!keepData || hadTeams) this.deps.onRemoteChange(new Set(ALL_TYPES));
    this.deps.onTeamsChanged?.();
  }

  private cursor(vaultId = this.deps.vault.id): number {
    const r = this.deps.db.prepare('SELECT sync_cursor FROM vaults WHERE id = ?').get(vaultId) as { sync_cursor: number } | undefined;
    return r?.sync_cursor ?? 0;
  }

  private setCursor(n: number, vaultId = this.deps.vault.id): void {
    this.deps.db.prepare('UPDATE vaults SET sync_cursor = ? WHERE id = ?').run(n, vaultId);
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

