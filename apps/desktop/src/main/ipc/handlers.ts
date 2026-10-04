import { app, nativeTheme, shell } from 'electron';
import type { GroupsRepo } from '../db/groups-repo';
import type { HostsRepo } from '../db/hosts-repo';
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
  keystore: KeystoreKind;
}

export function createHandlers(d: HandlerDeps): Handlers {
  return {
    app: {
      info: () => ({
        version: app.getVersion(),
        platform: process.platform as 'darwin' | 'win32' | 'linux',
        arch: process.arch,
        testMode: TEST_MODE,
        keystore: d.keystore,
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
      remove: ({ ids }) => d.hosts.remove(ids),
      tags: () => d.hosts.tags(),
    },
    groups: {
      list: () => d.groups.list(),
      create: (input) => d.groups.create(input),
      update: ({ id, patch }) => d.groups.update(id, patch),
      remove: ({ id }) => d.groups.remove(id),
    },
    sessions: {
      openSsh: (input, e) => d.sessions.openSsh(e.sender, input),
      openLocal: (input, e) => d.sessions.openLocal(e.sender, input),
      close: ({ sessionId }) => d.sessions.close(sessionId),
      localShells: () => detectShells(),
      respondHostKey: ({ promptId, decision }) => d.sessions.respondHostKey(promptId, decision),
      respondAuth: ({ promptId, responses, save }) => d.sessions.respondAuth(promptId, responses, save),
    },
    dev: {
      seedHosts: ({ count }) => {
        if (!TEST_MODE) throw new AppError('forbidden', 'errors.internal');
        return { created: d.hosts.seed(count) };
      },
    },
  };
}
