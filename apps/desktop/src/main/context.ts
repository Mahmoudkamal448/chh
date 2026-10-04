import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { BrowserWindow, nativeTheme } from 'electron';
import { BRAND } from '@cy-ssh/shared';
import { openDatabase, type Db } from './db/database';
import { ForwardsRepo } from './db/forwards-repo';
import { GroupsRepo } from './db/groups-repo';
import { HistoryRepo } from './db/history-repo';
import { HostsRepo } from './db/hosts-repo';
import { IdentitiesRepo } from './db/identities-repo';
import { ItemStore, type ItemType } from './db/item-store';
import { KeysRepo } from './db/keys-repo';
import { KnownHostsRepo } from './db/known-hosts-repo';
import { SettingsRepo } from './db/settings-repo';
import { SnippetsRepo } from './db/snippets-repo';
import { emit } from './ipc/handle';
import { SessionManager, sessionHostScript } from './sessions';
import { detectMoshClient, detectShells, type MoshClient } from './shells';
import { SshConfigIO } from './ssh-config-io';
import { SyncEngine } from './sync/engine';
import { LocalVault } from './vault/local-vault';
import type { EventName, EventPayload } from '@cy-ssh/shared';

export function broadcast<E extends EventName>(event: E, payload: EventPayload<E>): void {
  for (const w of BrowserWindow.getAllWindows()) emit(w.webContents, event, payload);
}

const KIND_FOR: Record<ItemType, 'hosts' | 'groups' | 'keys' | 'identities' | 'knownHosts' | 'forwards' | 'snippets'> = {
  host: 'hosts',
  group: 'groups',
  key: 'keys',
  identity: 'identities',
  known_host: 'knownHosts',
  forward: 'forwards',
  snippet: 'snippets',
};

/** Everything that needs the open, decrypted database. */
export type AppContext = ReturnType<typeof openContext>;

export function openContext(userData: string, key: Buffer, mainDir: string) {
  const db: Db = openDatabase(join(userData, `${BRAND.slug}.db`), key);
  const vault = LocalVault.openOrCreate(db, key);
  const settings = new SettingsRepo(db);
  let deviceId = settings.getRaw('device_id');
  if (!deviceId) {
    deviceId = randomUUID();
    settings.setRaw('device_id', deviceId);
  }
  nativeTheme.themeSource = settings.getApp().uiTheme;

  const store = new ItemStore(db, deviceId, vault.id);
  const groups = new GroupsRepo(store);
  const hosts = new HostsRepo(store, vault, groups);
  const knownHosts = new KnownHostsRepo(store);
  const keys = new KeysRepo(store, vault);
  const identities = new IdentitiesRepo(store, vault);
  const forwards = new ForwardsRepo(store);
  const snippets = new SnippetsRepo(store);
  const history = new HistoryRepo(db);
  const sshConfig = new SshConfigIO({ hosts, groups, keys, identities, forwards });
  // mosh-client detection can be slow on Windows (WSL), so cache it briefly.
  let mosh: { at: number; client: MoshClient | null } | null = null;
  const sessions = new SessionManager({
    keys,
    identities,
    forwards,
    moshClient: () => {
      if (!mosh || Date.now() - mosh.at > 60_000) mosh = { at: Date.now(), client: detectMoshClient() };
      return mosh.client;
    },
    broadcast,
    hostScript: sessionHostScript(mainDir),
    hosts,
    groups,
    knownHosts,
    shells: detectShells,
    defaultShellId: () => settings.getApp().defaultShell,
  });
  const sync = new SyncEngine({
    db,
    store,
    vault,
    onStatus: (s) => broadcast('sync.state', s),
    onRemoteChange: (types) => broadcast('data.changed', { kinds: [...new Set([...types].map((t) => KIND_FOR[t]))] }),
  });

  return {
    db,
    vault,
    settings,
    store,
    groups,
    hosts,
    knownHosts,
    keys,
    identities,
    forwards,
    snippets,
    history,
    sshConfig,
    sessions,
    sync,
    close() {
      sync.stop();
      sessions.shutdown();
      vault.dispose();
      db.close();
    },
  };
}
