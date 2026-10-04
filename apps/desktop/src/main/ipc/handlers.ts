import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, nativeTheme, shell, type WebContents } from 'electron';
import { KeyFormatError, isEncrypted } from '@chh/key-formats';
import { resolveSettings } from '@chh/shared';
import type { ForwardsRepo } from '../db/forwards-repo';
import type { HistoryRepo } from '../db/history-repo';
import type { SnippetsRepo } from '../db/snippets-repo';
import { defaultSshConfigPath, type SshConfigIO } from '../ssh-config-io';
import { CryptoError } from '@chh/vault-crypto';
import type { LockManager } from '../lock';
import type { SyncEngine } from '../sync/engine';
import type { AiProvider } from '../ai';
import { awsProfiles, listAws, listDigitalOcean } from '../cloud/providers';
import type { CloudImporter } from '../cloud/import';
import { SerialPort } from 'serialport';
import { SyncHttpError } from '../sync/http';
import type { GroupsRepo } from '../db/groups-repo';
import type { HostsRepo } from '../db/hosts-repo';
import type { IdentitiesRepo } from '../db/identities-repo';
import type { KeysRepo } from '../db/keys-repo';
import type { KnownHostsRepo } from '../db/known-hosts-repo';
import type { SettingsRepo } from '../db/settings-repo';
import type { KeystoreKind } from '../secrets/local-key';
import type { SessionManager } from '../sessions';
import { TEST_MODE } from '../env';
import { detectShells } from '../shells';
import { AppError, emit, type Handlers } from './handle';

export interface HandlerDeps {
  hosts: HostsRepo;
  groups: GroupsRepo;
  settings: SettingsRepo;
  sessions: SessionManager;
  keys: KeysRepo;
  identities: IdentitiesRepo;
  knownHosts: KnownHostsRepo;
  forwards: ForwardsRepo;
  snippets: SnippetsRepo;
  history: HistoryRepo;
  sshConfig: SshConfigIO;
  sync: SyncEngine;
  ai: AiProvider;
  cloud: CloudImporter;
}

/** Cloud provider errors → user-facing keys (credentials, permissions, network). */
function cloudError(e: unknown): never {
  if (e instanceof AppError) throw e;
  const err = e as Error & { name?: string; status?: number; $metadata?: { httpStatusCode?: number } };
  const status = err.status ?? err.$metadata?.httpStatusCode;
  if (status === 401 || /credential|InvalidClientTokenId|AuthFailure|UnrecognizedClient|Could not load credentials/i.test(`${err.name} ${err.message}`)) {
    throw new AppError('cloud_auth', 'cloud.error.auth');
  }
  if (status === 403 || /UnauthorizedOperation|AccessDenied/i.test(`${err.name}`)) throw new AppError('cloud_forbidden', 'cloud.error.forbidden');
  throw new AppError('cloud_failed', 'cloud.error.failed', { detail: err.message?.slice(0, 300) ?? '' });
}

/** Maps sync-engine errors (server codes, network) to user-facing IPC errors. */
async function syncCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SyncHttpError) throw new AppError(`sync_${e.code}`, `sync.error.${e.code}`, e.message && e.message !== e.code ? { detail: e.message.slice(0, 300) } : undefined);
    if (e instanceof CryptoError) throw new AppError('sync_crypto', 'sync.error.crypto');
    throw e;
  }
}

const MAX_KEY_FILE = 64 * 1024;
const MAX_KNOWN_HOSTS_FILE = 16 * 1024 * 1024;
const STAGE_TTL_MS = 10 * 60 * 1000;

/** Key files picked in a dialog are kept here (main process only) until imported. */
const staged = new Map<string, { text: string; fileName: string; expires: number }>();

function keyError(err: unknown): never {
  if (err instanceof KeyFormatError) throw new AppError(`key_${err.code}`, `keys.error.${err.code}`);
  throw err;
}

function windowOf(wc: WebContents) {
  return BrowserWindow.fromWebContents(wc) ?? undefined;
}

async function readLimited(path: string, max: number): Promise<string> {
  const s = await stat(path);
  if (s.size > max) throw new AppError('too_large', 'errors.fileTooLarge');
  return readFile(path, 'utf8');
}

export function createHandlers(getCtx: () => HandlerDeps | null, extras: { keystore: KeystoreKind; lock: LockManager }): Handlers {
  // Data handlers need the open database; while it's closed (master password not entered yet) they fail.
  const d = new Proxy({} as HandlerDeps, {
    get(_t, k: keyof HandlerDeps) {
      const ctx = getCtx();
      if (!ctx) throw new AppError('locked', 'errors.locked');
      return ctx[k];
    },
  });
  const lockError = (e: unknown, key: string): never => {
    throw new AppError('lock', key, { detail: (e as Error).message });
  };
  const rpc = (wc: WebContents, method: Parameters<SessionManager['rpc']>[0], params: Record<string, unknown>) => {
    if (typeof params.endpoint === 'string') d.sessions.assertEndpoint(wc, params.endpoint);
    return d.sessions.rpc(method, params, wc);
  };

  return {
    app: {
      info: () => ({
        version: app.getVersion(),
        platform: process.platform as 'darwin' | 'win32' | 'linux',
        arch: process.arch,
        testMode: TEST_MODE,
        keystore: extras.keystore,
      }),
      getSettings: () => d.settings.getApp(),
      setSettings: (patch, e) => {
        const next = d.settings.setApp(patch);
        nativeTheme.themeSource = next.uiTheme;
        emit(e.sender, 'data.changed', { kinds: ['settings'] });
        return next;
      },
      openExternal: async ({ url }) => {
        await shell.openExternal(url);
      },
    },
    hosts: {
      list: (q) => d.hosts.list(q),
      get: ({ id }) => d.hosts.get(id),
      create: (input) => d.hosts.create(input),
      update: ({ id, patch }) => d.hosts.update(id, patch),
      duplicate: ({ id }) => d.hosts.duplicate(id),
      remove: async ({ ids }) => {
        // Forward rules belong to their host: stop and delete them too.
        const fwd = d.forwards.idsForHosts(ids);
        for (const id of fwd) await d.sessions.stopForward(id);
        if (fwd.length) d.forwards.remove(fwd);
        d.hosts.remove(ids);
      },
      tags: () => d.hosts.tags(),
    },
    groups: {
      list: () => d.groups.list(),
      create: (input) => d.groups.create(input),
      update: ({ id, patch }) => d.groups.update(id, patch),
      remove: ({ id }) => d.groups.remove(id),
    },
    keys: {
      list: () => d.keys.list(),
      generate: (input) => d.keys.generate(input),
      importText: ({ text, label, passphrase }) => d.keys.importText(text, label, passphrase).catch(keyError),
      pickFile: async (_input, e) => {
        const res = await dialog.showOpenDialog(windowOf(e.sender)!, {
          title: 'Import private key',
          defaultPath: join(homedir(), '.ssh'),
          properties: ['openFile', 'showHiddenFiles'],
        });
        const path = res.filePaths[0];
        if (res.canceled || !path) return null;
        const text = await readLimited(path, MAX_KEY_FILE);
        let encrypted: boolean;
        try {
          encrypted = isEncrypted(text);
        } catch (err) {
          keyError(err);
        }
        const now = Date.now();
        for (const [k, v] of staged) if (v.expires < now) staged.delete(k);
        const token = randomUUID();
        const fileName = path.split(/[\\/]/).pop() ?? 'key';
        staged.set(token, { text, fileName, expires: now + STAGE_TTL_MS });
        return { token, fileName, encrypted };
      },
      importStaged: async ({ token, label, passphrase }) => {
        const s = staged.get(token);
        if (!s) throw new AppError('expired', 'keys.error.expired');
        const result = await d.keys.importText(s.text, label || s.fileName, passphrase).catch(keyError);
        if (result.status === 'imported' || result.status === 'duplicate') staged.delete(token);
        return result;
      },
      rename: ({ id, label }) => d.keys.rename(id, label),
      remove: ({ ids }) => d.keys.remove(ids),
      exportPrivate: async ({ id, passphrase }, e) => {
        const key = d.keys.get(id);
        const res = await dialog.showSaveDialog(windowOf(e.sender)!, {
          title: 'Export private key',
          defaultPath: join(homedir(), key.label.replace(/[^\w.-]+/g, '_') || 'id_key'),
          showsTagField: false,
        });
        if (res.canceled || !res.filePath) return { saved: false };
        await writeFile(res.filePath, await d.keys.exportPrivate(id, passphrase), { mode: 0o600 });
        await writeFile(`${res.filePath}.pub`, `${key.publicKey}\n`, { mode: 0o644 });
        return { saved: true };
      },
      usage: ({ id }) => d.keys.usage(id),
    },
    identities: {
      list: () => d.identities.list(),
      create: (input) => d.identities.create(input),
      update: ({ id, patch }) => d.identities.update(id, patch),
      remove: ({ ids }) => d.identities.remove(ids),
    },
    knownHosts: {
      list: ({ query }) => d.knownHosts.list(query),
      remove: ({ ids }) => d.knownHosts.remove(ids),
      importFile: async (_input, e) => {
        const res = await dialog.showOpenDialog(windowOf(e.sender)!, {
          title: 'Import known_hosts',
          defaultPath: join(homedir(), '.ssh', 'known_hosts'),
          properties: ['openFile', 'showHiddenFiles'],
        });
        const path = res.filePaths[0];
        if (res.canceled || !path) return null;
        return d.knownHosts.importText(await readLimited(path, MAX_KNOWN_HOSTS_FILE));
      },
    },
    sessions: {
      openHost: (input, e) => d.sessions.openHost(e.sender, input),
      openLocal: (input, e) => d.sessions.openLocal(e.sender, input),
      close: ({ sessionId }) => d.sessions.close(sessionId),
      localShells: () => detectShells(),
      respondHostKey: ({ promptId, decision }) => d.sessions.respondHostKey(promptId, decision),
      respondAuth: ({ promptId, responses, save }) => d.sessions.respondAuth(promptId, responses, save),
    },
    sftp: {
      open: ({ hostId }, e) => d.sessions.openSftp(e.sender, hostId),
      close: ({ sessionId }) => d.sessions.close(sessionId),
      home: async (p, e) => (await rpc(e.sender, 'fs.home', p)) as { path: string; separator: '/' | '\\' },
      list: async (p, e) => (await rpc(e.sender, 'fs.list', p)) as never,
      mkdir: async (p, e) => {
        await rpc(e.sender, 'fs.mkdir', p);
      },
      rename: async (p, e) => {
        await rpc(e.sender, 'fs.rename', p);
      },
      remove: async (p, e) => {
        await rpc(e.sender, 'fs.remove', p);
      },
      chmod: async (p, e) => {
        await rpc(e.sender, 'fs.chmod', p);
      },
      existing: async (p, e) => (await rpc(e.sender, 'fs.existing', p)) as string[],
      transfer: async (p, e) => {
        d.sessions.assertEndpoint(e.sender, p.src.endpoint);
        d.sessions.assertEndpoint(e.sender, p.dst.endpoint);
        return (await d.sessions.rpc('transfer.start', p, e.sender)) as { transferIds: string[] };
      },
      cancelTransfer: async (p) => {
        await d.sessions.rpc('transfer.cancel', p);
      },
    },
    forwards: {
      list: () => d.forwards.list(),
      create: (input) => d.forwards.create(input),
      update: async ({ id, patch }, e) => {
        const running = d.sessions.forwardStatuses().some((s) => s.id === id && (s.state === 'running' || s.state === 'starting'));
        const updated = d.forwards.update(id, patch);
        if (running) {
          // Apply the change by restarting the tunnel.
          await d.sessions.stopForward(id);
          await d.sessions.startForward(e.sender, id).catch(() => undefined);
        }
        return updated;
      },
      remove: async ({ ids }) => {
        for (const id of ids) await d.sessions.stopForward(id);
        d.forwards.remove(ids);
      },
      start: ({ id }, e) => d.sessions.startForward(e.sender, id),
      stop: ({ id }) => d.sessions.stopForward(id),
      statuses: () => d.sessions.forwardStatuses(),
    },
    snippets: {
      list: () => d.snippets.list(),
      create: (input) => d.snippets.create(input),
      update: ({ id, patch }) => d.snippets.update(id, patch),
      remove: ({ ids }) => d.snippets.remove(ids),
    },
    history: {
      add: ({ hostId, source, command }, e) => {
        if (!d.settings.getApp().historyEnabled) return;
        if (hostId) {
          try {
            const f = d.hosts.getFields(hostId);
            if (!resolveSettings(f.groupId, f.settings, d.groups.map()).recordHistory) return;
          } catch {
            return; // host deleted meanwhile
          }
        }
        if (d.history.add(hostId, source, command)) emit(e.sender, 'data.changed', { kinds: ['history'] });
      },
      search: ({ query, hostId, limit }) => d.history.search(query, hostId, limit),
      remove: ({ ids }) => d.history.remove(ids),
      clear: () => d.history.clear(),
    },
    sshConfig: {
      preview: async ({ pickFile }, e) => {
        let path = defaultSshConfigPath();
        if (pickFile) {
          const res = await dialog.showOpenDialog(windowOf(e.sender)!, {
            title: 'Import SSH config',
            defaultPath: path,
            properties: ['openFile', 'showHiddenFiles'],
          });
          if (res.canceled || !res.filePaths[0]) return null;
          path = res.filePaths[0];
        }
        return d.sshConfig.preview(path);
      },
      import: (input) => d.sshConfig.import(input),
      exportText: ({ hostIds }) => d.sshConfig.exportText(hostIds),
      exportFile: async ({ hostIds }, e) => {
        const res = await dialog.showSaveDialog(windowOf(e.sender)!, {
          title: 'Export SSH config',
          defaultPath: join(homedir(), '.ssh', 'config.chh'),
          showsTagField: false,
        });
        if (res.canceled || !res.filePath) return { saved: false };
        await writeFile(res.filePath, d.sshConfig.exportText(hostIds), { mode: 0o600 });
        return { saved: true };
      },
    },
    sync: {
      status: () => d.sync.status(),
      register: (input) => syncCall(() => d.sync.register(input)),
      login: (input) => syncCall(() => d.sync.login(input)),
      recover: (input) => syncCall(() => d.sync.recover(input)),
      logout: ({ keepData }) => syncCall(() => d.sync.logout(keepData)),
      syncNow: () => syncCall(() => d.sync.syncNow()),
      devices: () => syncCall(() => d.sync.devices()),
      removeDevice: ({ id }) => syncCall(() => d.sync.removeDevice(id)),
      changePassword: ({ current, next }) => syncCall(() => d.sync.changePassword(current, next)),
      totpSetup: () => syncCall(() => d.sync.totpSetup()),
      totpEnable: ({ code }) => syncCall(() => d.sync.totpEnable(code)),
      totpDisable: (input) => syncCall(() => d.sync.totpDisable(input)),
      deleteAccount: ({ password }) => syncCall(() => d.sync.deleteAccount(password)),
    },
    serial: {
      ports: async () =>
        (await SerialPort.list()).map((p) => ({
          path: p.path,
          manufacturer: p.manufacturer ?? null,
          serialNumber: p.serialNumber ?? null,
          vendorId: p.vendorId ?? null,
          productId: p.productId ?? null,
        })),
    },
    run: {
      start: ({ hostIds, script }, e) => d.sessions.startRun(e.sender, hostIds, script),
      cancel: ({ runId }) => d.sessions.cancelRun(runId),
    },
    suggest: {
      history: ({ prefix, hostId, limit }) => d.history.suggest(prefix, hostId, limit),
      ai: async ({ line, hostId, recent }) => {
        let os: string | null = null;
        if (hostId) {
          try {
            os = d.hosts.getFields(hostId).osHint;
          } catch {
            // host gone
          }
        }
        return { suggestions: await d.ai.suggest({ line, os, recent }) };
      },
      aiKeyStatus: () => ({ configured: d.ai.hasKey() }),
      setAiKey: ({ key }) => d.ai.setKey(key),
    },
    cloud: {
      awsProfiles: () => awsProfiles(),
      awsList: async (input) => d.cloud.stage(await listAws(input).catch(cloudError)),
      doList: async ({ apiToken }) => d.cloud.stage(await listDigitalOcean(apiToken).catch(cloudError)),
      import: (input) => d.cloud.import(input),
    },
    lock: {
      state: () => extras.lock.state(),
      lockNow: () => extras.lock.lockNow(),
      unlock: (input) => extras.lock.unlock(input),
      configure: (input) => extras.lock.configure(input).catch((e) => lockError(e, 'lock.error.passcodeRequired')),
      disable: ({ secret }) => extras.lock.disable(secret).catch((e) => lockError(e, 'lock.error.wrongSecret')),
      setMasterPassword: ({ password }) => extras.lock.setMasterPassword(password),
      removeMasterPassword: ({ password }) => extras.lock.removeMasterPassword(password).catch((e) => lockError(e, 'lock.error.wrongSecret')),
    },
    dev: {
      seedHosts: ({ count }) => {
        if (!TEST_MODE) throw new AppError('forbidden', 'errors.internal');
        return { created: d.hosts.seed(count) };
      },
    },
  };
}
