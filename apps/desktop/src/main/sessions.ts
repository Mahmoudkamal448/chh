import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron';
import {
  SESSION_PORT_CHANNEL,
  resolveSettings,
  type AuthPrompt,
  type HostKeyDecision,
  type LocalShell,
} from '@cy-ssh/shared';
import type { GroupsRepo } from './db/groups-repo';
import type { HostsRepo } from './db/hosts-repo';
import type { KnownHostsRepo } from './db/known-hosts-repo';
import type { HostToMain, MainToHost, SshConnectConfig } from '../session-host/protocol';
import { AppError, emit } from './ipc/handle';
import { errInfo, log } from './log';

interface SessionInfo {
  id: string;
  wc: WebContents;
  kind: 'ssh' | 'local';
  hostId: string | null;
  label: string;
  /** User ticked "remember password" on a prompt in this session. */
  savePassword: boolean;
}

type PendingPrompt =
  | { kind: 'hostkey'; sessionId: string; hostPattern: string; keyType: string; fingerprint: string; publicKey: string }
  | { kind: 'auth'; sessionId: string }
  | { kind: 'main-auth'; sessionId: string; resolve: (r: string[] | null) => void };

/**
 * Owns the session-host utility process and brokers everything that needs main-process state:
 * secrets, known-hosts decisions and user prompts. Terminal bytes bypass main entirely.
 */
export class SessionManager {
  private child: UtilityProcess | null = null;
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly prompts = new Map<string, PendingPrompt>();
  private readonly hooked = new WeakSet<WebContents>();

  constructor(
    private readonly deps: {
      hostScript: string;
      hosts: HostsRepo;
      groups: GroupsRepo;
      knownHosts: KnownHostsRepo;
      shells: () => LocalShell[];
      defaultShellId: () => string | null;
    },
  ) {}

  private host(): UtilityProcess {
    if (this.child) return this.child;
    const child = utilityProcess.fork(this.deps.hostScript, [], {
      serviceName: 'cy-ssh session host',
      stdio: 'ignore',
    });
    child.on('message', (msg: HostToMain) => this.onHostMessage(msg));
    child.on('exit', (code) => {
      log.warn({ code }, 'session host exited');
      if (this.child === child) this.child = null;
      for (const s of [...this.sessions.values()]) {
        emit(s.wc, 'session.status', { sessionId: s.id, status: 'error', message: 'session.error.hostCrashed' });
        this.cleanup(s.id);
      }
    });
    this.child = child;
    return child;
  }

  private send(msg: MainToHost, ports?: Electron.MessagePortMain[]): void {
    this.host().postMessage(msg, ports);
  }

  private register(wc: WebContents, info: Omit<SessionInfo, 'id' | 'wc' | 'savePassword'>): {
    id: string;
    hostPort: Electron.MessagePortMain;
  } {
    const id = randomUUID();
    this.sessions.set(id, { ...info, id, wc, savePassword: false });
    const { port1, port2 } = new MessageChannelMain();
    // The renderer side of the port goes straight to the window; data never touches main again.
    wc.postMessage(SESSION_PORT_CHANNEL, { sessionId: id }, [port1]);
    if (!this.hooked.has(wc)) {
      this.hooked.add(wc);
      wc.once('destroyed', () => {
        for (const s of [...this.sessions.values()]) if (s.wc === wc) this.close(s.id);
      });
    }
    return { id, hostPort: port2 };
  }

  openLocal(wc: WebContents, opts: { shellId?: string; cols: number; rows: number }): { sessionId: string; title: string } {
    const shells = this.deps.shells();
    const wanted = opts.shellId ?? this.deps.defaultShellId();
    const shell = shells.find((s) => s.id === wanted) ?? shells[0];
    if (!shell) throw new AppError('no_shell', 'errors.noShell');
    const { id, hostPort } = this.register(wc, { kind: 'local', hostId: null, label: shell.label });
    this.send(
      { type: 'open-local', sessionId: id, cols: opts.cols, rows: opts.rows, shell: { path: shell.path, args: shell.args }, cwd: homedir() },
      [hostPort],
    );
    log.info({ sessionId: id, shell: shell.id }, 'local session opened');
    return { sessionId: id, title: shell.label };
  }

  async openSsh(wc: WebContents, opts: { hostId: string; cols: number; rows: number }): Promise<{ sessionId: string }> {
    const fields = this.deps.hosts.getFields(opts.hostId);
    const settings = resolveSettings(fields.groupId, fields.settings, this.deps.groups.map());
    const { id, hostPort } = this.register(wc, { kind: 'ssh', hostId: opts.hostId, label: fields.label });

    // Run the rest asynchronously so the renderer gets the session id (and can show prompts) right away.
    void (async () => {
      let username = settings.username;
      if (!username) {
        const answer = await this.promptFromMain(id, {
          kind: 'username',
          title: fields.label,
          instructions: '',
          prompts: [{ prompt: 'Username', echo: true }],
          canSave: false,
          retry: false,
        });
        if (!answer?.[0]) {
          this.close(id);
          return;
        }
        username = answer[0];
      }
      if (!this.sessions.has(id)) return;
      const config: SshConnectConfig = {
        host: fields.address,
        port: settings.port,
        username,
        password: this.deps.hosts.getPassword(opts.hostId),
        useAgent: settings.useAgent,
        tryDefaultKeys: settings.tryDefaultKeys,
        keepAliveSec: settings.keepAliveSec,
        connectTimeoutSec: settings.connectTimeoutSec,
      };
      this.send({ type: 'open-ssh', sessionId: id, label: fields.label, cols: opts.cols, rows: opts.rows, config }, [hostPort]);
      log.info({ sessionId: id, hostId: opts.hostId }, 'ssh session opening');
    })().catch((err) => {
      log.error({ err: errInfo(err) }, 'openSsh failed');
      const s = this.sessions.get(id);
      if (s) emit(s.wc, 'session.status', { sessionId: id, status: 'error', message: 'session.error.internal' });
      this.close(id);
    });

    return { sessionId: id };
  }

  close(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    if (this.child) this.send({ type: 'close', sessionId });
    this.cleanup(sessionId);
  }

  respondHostKey(promptId: string, decision: HostKeyDecision): void {
    const p = this.prompts.get(promptId);
    if (!p || p.kind !== 'hostkey') return;
    this.prompts.delete(promptId);
    if (decision === 'accept-save') {
      this.deps.knownHosts.save({ hostPattern: p.hostPattern, keyType: p.keyType, fingerprint: p.fingerprint, publicKey: p.publicKey });
      log.info({ hostPattern: p.hostPattern, keyType: p.keyType }, 'host key saved');
    }
    if (decision === 'reject') log.warn({ hostPattern: p.hostPattern }, 'host key rejected by user');
    this.send({ type: 'hostkey-result', promptId, decision });
  }

  respondAuth(promptId: string, responses: string[] | null, save: boolean): void {
    const p = this.prompts.get(promptId);
    if (!p || p.kind === 'hostkey') return;
    this.prompts.delete(promptId);
    const s = this.sessions.get(p.sessionId);
    if (s && save && responses) s.savePassword = true;
    if (p.kind === 'main-auth') p.resolve(responses);
    else this.send({ type: 'auth-result', promptId, responses });
  }

  shutdown(): void {
    if (this.child) {
      this.child.postMessage({ type: 'shutdown' } satisfies MainToHost);
      this.child = null;
    }
  }

  private promptFromMain(sessionId: string, p: Omit<AuthPrompt, 'promptId' | 'sessionId' | 'hostLabel'>): Promise<string[] | null> {
    const s = this.sessions.get(sessionId);
    if (!s) return Promise.resolve(null);
    const promptId = randomUUID();
    return new Promise((resolve) => {
      this.prompts.set(promptId, { kind: 'main-auth', sessionId, resolve });
      emit(s.wc, 'auth.prompt', { ...p, promptId, sessionId, hostLabel: s.label });
    });
  }

  private onHostMessage(msg: HostToMain): void {
    switch (msg.type) {
      case 'ready':
        log.info({}, 'session host ready');
        return;
      case 'status': {
        if (msg.status === 'error') log.warn({ sessionId: msg.sessionId, message: msg.message?.split('::')[0] }, 'session error');
        return;
      }
      case 'closed':
        this.cleanup(msg.sessionId);
        return;
      case 'hostkey-check': {
        const s = this.sessions.get(msg.sessionId);
        if (!s) return this.send({ type: 'hostkey-result', promptId: msg.promptId, decision: 'reject' });
        const verdict = this.deps.knownHosts.check(msg.hostPattern, msg.keyType, msg.publicKey);
        if (verdict.kind === 'match') return this.send({ type: 'hostkey-result', promptId: msg.promptId, decision: 'accept-once' });
        this.prompts.set(msg.promptId, {
          kind: 'hostkey',
          sessionId: msg.sessionId,
          hostPattern: msg.hostPattern,
          keyType: msg.keyType,
          fingerprint: msg.fingerprint,
          publicKey: msg.publicKey,
        });
        if (verdict.kind === 'changed') log.warn({ hostPattern: msg.hostPattern }, 'HOST KEY CHANGED');
        const prev = verdict.kind === 'unknown' ? null : verdict.previous;
        emit(s.wc, 'hostkey.prompt', {
          promptId: msg.promptId,
          sessionId: msg.sessionId,
          hostLabel: s.label,
          hostPattern: msg.hostPattern,
          keyType: msg.keyType,
          fingerprint: msg.fingerprint,
          previousFingerprint: verdict.kind === 'changed' ? prev!.fingerprint : null,
          previousKeyType: prev?.keyType ?? null,
        });
        return;
      }
      case 'auth-prompt': {
        const s = this.sessions.get(msg.sessionId);
        if (!s) return this.send({ type: 'auth-result', promptId: msg.promptId, responses: null });
        this.prompts.set(msg.promptId, { kind: 'auth', sessionId: msg.sessionId });
        const isPassword = msg.prompts.length === 1 && !msg.prompts[0]!.echo;
        emit(s.wc, 'auth.prompt', {
          promptId: msg.promptId,
          sessionId: msg.sessionId,
          hostLabel: s.label,
          kind: msg.kind,
          title: msg.title,
          instructions: msg.instructions,
          prompts: msg.prompts,
          canSave: s.kind === 'ssh' && s.hostId !== null && isPassword,
          retry: msg.retry,
        });
        return;
      }
      case 'auth-succeeded': {
        const s = this.sessions.get(msg.sessionId);
        if (s?.savePassword && s.hostId && msg.password) {
          try {
            this.deps.hosts.setPassword(s.hostId, msg.password);
            emit(s.wc, 'data.changed', { kinds: ['hosts'] });
          } catch (err) {
            log.error({ err: errInfo(err) }, 'failed to save password');
          }
        }
        if (s) s.savePassword = false;
        return;
      }
    }
  }

  private cleanup(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    for (const [promptId, p] of [...this.prompts]) {
      if (p.sessionId !== sessionId) continue;
      this.prompts.delete(promptId);
      if (p.kind === 'main-auth') p.resolve(null);
      if (s) emit(s.wc, 'prompt.dismiss', { promptId });
    }
  }
}

export function sessionHostScript(mainDir: string): string {
  return join(mainDir, 'session-host.js');
}
