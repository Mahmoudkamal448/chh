import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron';
import {
  SESSION_PORT_CHANNEL,
  resolveSettings,
  type AppSettings,
  type AuthPrompt,
  type EventName,
  type EventPayload,
  type ForwardStatus,
  type HostKeyDecision,
  type LocalShell,
} from '@chh/shared';
import type { GroupsRepo } from './db/groups-repo';
import type { HostsRepo } from './db/hosts-repo';
import type { IdentitiesRepo } from './db/identities-repo';
import type { KeysRepo } from './db/keys-repo';
import type { KnownHostsRepo } from './db/known-hosts-repo';
import type { HostToMain, MainToHost, MoshClientSpec, RpcError, RpcMethod, SshConnectConfig } from '../session-host/protocol';
import type { ForwardsRepo } from './db/forwards-repo';
import { AppError, emit } from './ipc/handle';
import { errInfo, log } from './log';

interface SessionInfo {
  id: string;
  wc: WebContents;
  kind: 'ssh' | 'local' | 'sftp' | 'forward' | 'run';
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
  private rpcSeq = 0;
  private readonly rpcPending = new Map<number, { resolve(v: unknown): void; reject(e: AppError): void }>();
  private readonly transferOwners = new Map<string, WebContents>();
  private lastTransferWc: WebContents | null = null;
  private readonly forwardState = new Map<string, ForwardStatus>();

  constructor(
    private readonly deps: {
      hostScript: string;
      hosts: HostsRepo;
      groups: GroupsRepo;
      knownHosts: KnownHostsRepo;
      keys: KeysRepo;
      identities: IdentitiesRepo;
      forwards: ForwardsRepo;
      appSettings: () => AppSettings;
      /** Path of the system OpenSSH client, or null if not installed. */
      openSsh: () => string | null;
      moshClient: () => MoshClientSpec | null;
      /** Sends an event to every window (forward status is app-wide). */
      broadcast: <E extends EventName>(event: E, payload: EventPayload<E>) => void;
      shells: () => LocalShell[];
      defaultShellId: () => string | null;
    },
  ) {}

  private host(): UtilityProcess {
    if (this.child) return this.child;
    const child = utilityProcess.fork(this.deps.hostScript, [], {
      serviceName: 'chh session host',
      stdio: 'ignore',
    });
    child.on('message', (msg: HostToMain) => this.onHostMessage(msg));
    child.on('exit', (code) => {
      log.warn({ code }, 'session host exited');
      if (this.child === child) this.child = null;
      for (const [id, p] of [...this.rpcPending]) {
        this.rpcPending.delete(id);
        p.reject(new AppError('host_crashed', 'session.error.hostCrashed'));
      }
      for (const st of [...this.forwardState.values()]) {
        const failed: ForwardStatus = { ...st, state: 'error', connections: 0, message: 'session.error.hostCrashed' };
        this.forwardState.set(st.id, failed);
        this.deps.broadcast('forward.update', failed);
      }
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
    const id = this.registerNoPort(wc, info);
    const { port1, port2 } = new MessageChannelMain();
    // The renderer side of the port goes straight to the window; data never touches main again.
    wc.postMessage(SESSION_PORT_CHANNEL, { sessionId: id }, [port1]);
    return { id, hostPort: port2 };
  }

  /** Sessions without a terminal stream (SFTP). */
  private registerNoPort(wc: WebContents, info: Omit<SessionInfo, 'id' | 'wc' | 'savePassword'>): string {
    const id = randomUUID();
    this.sessions.set(id, { ...info, id, wc, savePassword: false });
    if (!this.hooked.has(wc)) {
      this.hooked.add(wc);
      wc.once('destroyed', () => {
        for (const s of [...this.sessions.values()]) if (s.wc === wc) this.close(s.id);
      });
    }
    return id;
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

  /**
   * Full connection config for a host: its own hop config plus its jump chain and proxy.
   * Returns null if the user cancelled a prompt.
   */
  private async resolveConfig(sessionId: string, hostId: string): Promise<SshConnectConfig | null> {
    const target = await this.hopConfig(sessionId, hostId);
    if (!target) return null;
    const fields = this.deps.hosts.getFields(hostId);
    const settings = resolveSettings(fields.groupId, fields.settings, this.deps.groups.map());
    const jumps: SshConnectConfig[] = [];
    const seen = new Set([hostId]);
    for (const jumpId of settings.jumpHosts) {
      if (seen.has(jumpId)) throw new AppError('jump_loop', 'session.error.jumpLoop');
      seen.add(jumpId);
      let jump: SshConnectConfig | null;
      try {
        jump = await this.hopConfig(sessionId, jumpId);
      } catch {
        throw new AppError('jump_missing', 'session.error.jumpMissing');
      }
      if (!jump) return null;
      jumps.push(jump);
    }
    return { ...target, jumps, proxy: settings.proxy.type === 'none' ? null : settings.proxy };
  }

  /**
   * One hop: inherited settings, identity (username/password/key), explicit key, and a username
   * prompt if none is configured. Jumps and proxy are filled in by resolveConfig.
   */
  private async hopConfig(sessionId: string, hostId: string): Promise<SshConnectConfig | null> {
    const fields = this.deps.hosts.getFields(hostId);
    const settings = resolveSettings(fields.groupId, fields.settings, this.deps.groups.map());
    const identity = settings.identityId ? this.deps.identities.getSecrets(settings.identityId) : null;

    let username = settings.username || identity?.username || '';
    if (!username) {
      const answer = await this.promptFromMain(sessionId, {
        kind: 'username',
        title: fields.label,
        instructions: '',
        prompts: [{ prompt: 'Username', echo: true }],
        canSave: false,
        retry: false,
      });
      if (!answer?.[0]) return null;
      username = answer[0];
    }
    if (!this.sessions.has(sessionId)) return null;

    const keyId = settings.keyId ?? identity?.keyId ?? null;
    let privateKey: string | null = null;
    if (keyId) {
      try {
        privateKey = this.deps.keys.getPrivate(keyId);
      } catch {
        log.warn({ hostId }, 'configured key no longer exists');
      }
    }
    return {
      host: fields.address,
      port: settings.port,
      username,
      password: this.deps.hosts.getPassword(hostId) ?? identity?.password ?? null,
      privateKey,
      useAgent: settings.useAgent,
      tryDefaultKeys: settings.tryDefaultKeys,
      keepAliveSec: settings.keepAliveSec,
      connectTimeoutSec: settings.connectTimeoutSec,
      label: fields.label,
      agent: this.deps.appSettings().sshAgent,
      agentForward: settings.agentForwarding,
      env: settings.env,
      envMethod: settings.envMethod,
      jumps: [],
      proxy: null,
    };
  }

  /** Opens a terminal to a host using its protocol: SSH, Telnet or Mosh. */
  async openHost(wc: WebContents, opts: { hostId: string; cols: number; rows: number }): Promise<{ sessionId: string }> {
    const fields = this.deps.hosts.getFields(opts.hostId);
    const settings = resolveSettings(fields.groupId, fields.settings, this.deps.groups.map());
    const { id, hostPort } = this.register(wc, { kind: 'ssh', hostId: opts.hostId, label: fields.label });
    const fail = (message: string) => {
      const s = this.sessions.get(id);
      if (s) emit(s.wc, 'session.status', { sessionId: id, status: 'error', message });
      this.close(id);
    };

    if (fields.protocol === 'serial') {
      this.send({ type: 'open-serial', sessionId: id, path: fields.address, settings: settings.serial }, [hostPort]);
      log.info({ sessionId: id, hostId: opts.hostId }, 'serial session opening');
      return { sessionId: id };
    }

    if (fields.protocol === 'ssh' && settings.sshEngine === 'openssh') {
      const ssh = this.deps.openSsh();
      if (!ssh) {
        void Promise.resolve().then(() => fail('session.error.opensshMissing'));
        return { sessionId: id };
      }
      const args = this.opensshArgs(opts.hostId);
      this.send({ type: 'open-local', sessionId: id, cols: opts.cols, rows: opts.rows, shell: { path: ssh, args }, cwd: homedir() }, [hostPort]);
      log.info({ sessionId: id, hostId: opts.hostId }, 'openssh session opening');
      return { sessionId: id };
    }

    if (fields.protocol === 'telnet') {
      // Telnet ignores inherited (SSH-oriented) ports: the host's own port, or 23.
      const port = fields.settings.port ?? 23;
      this.send(
        { type: 'open-telnet', sessionId: id, cols: opts.cols, rows: opts.rows, host: fields.address, port, connectTimeoutSec: settings.connectTimeoutSec },
        [hostPort],
      );
      log.info({ sessionId: id, hostId: opts.hostId }, 'telnet session opening');
      return { sessionId: id };
    }

    // SSH and Mosh: resolve credentials asynchronously so the renderer gets the session id (and can
    // show prompts) right away.
    void (async () => {
      let client = null;
      if (fields.protocol === 'mosh') {
        client = this.deps.moshClient();
        if (!client) return fail('session.error.moshMissing');
      }
      const config = await this.resolveConfig(id, opts.hostId);
      if (!config) {
        this.close(id);
        return;
      }
      if (client) {
        this.send(
          { type: 'open-mosh', sessionId: id, cols: opts.cols, rows: opts.rows, config, moshServer: settings.moshServer || 'mosh-server', client },
          [hostPort],
        );
      } else {
        this.send({ type: 'open-ssh', sessionId: id, label: fields.label, cols: opts.cols, rows: opts.rows, config }, [hostPort]);
      }
      log.info({ sessionId: id, hostId: opts.hostId, protocol: fields.protocol }, 'session opening');
    })().catch((err) => {
      log.error({ err: errInfo(err) }, 'openHost failed');
      fail('session.error.internal');
    });

    return { sessionId: id };
  }

  /** Starts a port-forwarding rule; resolves once it's listening (prompts may appear first). */
  async startForward(wc: WebContents, forwardId: string): Promise<void> {
    const f = this.deps.forwards.get(forwardId);
    const sessionId = this.registerNoPort(wc, { kind: 'forward', hostId: f.hostId, label: f.label });
    try {
      const config = await this.resolveConfig(sessionId, f.hostId);
      if (!config) throw new AppError('cancelled', 'forwards.error.cancelled');
      const rule = { kind: f.kind, bindHost: f.bindHost, bindPort: f.bindPort, destHost: f.destHost, destPort: f.destPort };
      await this.rpc('forward.start', { forwardId, sessionId, rule, config });
      log.info({ forwardId, kind: f.kind, bindPort: f.bindPort }, 'forward started');
    } finally {
      this.cleanup(sessionId);
    }
  }

  async stopForward(forwardId: string): Promise<void> {
    if (!this.child) return;
    await this.rpc('forward.stop', { forwardId });
  }

  forwardStatuses(): ForwardStatus[] {
    return [...this.forwardState.values()];
  }

  /**
   * Arguments for the system OpenSSH client. It handles its own authentication (agent, keys, FIDO2
   * security keys, passwords in the terminal) and its own known_hosts.
   */
  opensshArgs(hostId: string): string[] {
    const groups = this.deps.groups.map();
    const fields = this.deps.hosts.getFields(hostId);
    const s = resolveSettings(fields.groupId, fields.settings, groups);
    const identity = s.identityId ? this.deps.identities.getSecrets(s.identityId) : null;
    const userAt = (user: string, host: string) => (user ? `${user}@${host}` : host);
    const args = ['-p', String(s.port)];
    const user = s.username || identity?.username || '';
    if (user) args.push('-l', user);
    if (s.jumpHosts.length) {
      const chain = s.jumpHosts.map((jid) => {
        const jf = this.deps.hosts.getFields(jid);
        const js = resolveSettings(jf.groupId, jf.settings, groups);
        const ju = js.username || (js.identityId ? this.deps.identities.getSecrets(js.identityId)?.username : '') || '';
        return `${userAt(ju, jf.address)}:${js.port}`;
      });
      args.push('-J', chain.join(','));
    }
    if (s.agentForwarding) args.push('-A');
    if (s.identityFile) args.push('-i', s.identityFile);
    if (s.keepAliveSec) args.push('-o', `ServerAliveInterval=${s.keepAliveSec}`);
    args.push('-o', `ConnectTimeout=${s.connectTimeoutSec}`);
    for (const [k, v] of Object.entries(s.env)) args.push('-o', `SetEnv=${k}="${v.replace(/"/g, '')}"`);
    args.push('--', fields.address);
    return args;
  }

  // --- multi-host runs -------------------------------------------------------------------------

  private readonly runs = new Map<string, { wc: WebContents; queue: string[]; active: number; script: string; cancelled: boolean }>();
  private static readonly RUN_CONCURRENCY = 6;

  /** Starts running `script` on hosts (SSH/Mosh only), at most 6 at a time. */
  startRun(wc: WebContents, hostIds: string[], script: string): { runId: string; hosts: Array<{ hostId: string; label: string; skipped?: string }> } {
    const runId = randomUUID();
    const hosts: Array<{ hostId: string; label: string; skipped?: string }> = [];
    const queue: string[] = [];
    for (const hostId of [...new Set(hostIds)]) {
      const f = this.deps.hosts.getFields(hostId);
      if (f.protocol === 'telnet' || f.protocol === 'serial') hosts.push({ hostId, label: f.label, skipped: 'run.skipped.protocol' });
      else {
        hosts.push({ hostId, label: f.label });
        queue.push(hostId);
      }
    }
    this.runs.set(runId, { wc, queue, active: 0, script, cancelled: false });
    for (const hostId of queue) emit(wc, 'run.status', { runId, hostId, status: 'queued' });
    setImmediate(() => this.pumpRun(runId));
    return { runId, hosts };
  }

  private pumpRun(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    while (!run.cancelled && run.active < SessionManager.RUN_CONCURRENCY && run.queue.length) {
      const hostId = run.queue.shift()!;
      run.active++;
      const sessionId = this.registerNoPort(run.wc, { kind: 'run', hostId, label: this.deps.hosts.getFields(hostId).label });
      void (async () => {
        let config: SshConnectConfig | null = null;
        try {
          config = await this.resolveConfig(sessionId, hostId);
        } catch (e) {
          this.cleanup(sessionId);
          return this.finishRunHost(runId, hostId, 'error', e instanceof AppError ? e.messageKey : 'session.error.internal');
        }
        if (!config || run.cancelled) {
          this.cleanup(sessionId);
          return this.finishRunHost(runId, hostId, 'cancelled');
        }
        await this.rpc('exec.start', { runId, hostId, sessionId, config, script: run.script }).catch(() => this.finishRunHost(runId, hostId, 'error', 'session.error.internal'));
      })();
    }
    if (!run.active && !run.queue.length) this.runs.delete(runId);
  }

  private finishRunHost(runId: string, hostId: string, status: 'error' | 'cancelled', error?: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    emit(run.wc, 'run.status', { runId, hostId, status, error });
    run.active--;
    this.pumpRun(runId);
  }

  cancelRun(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.cancelled = true;
    for (const hostId of run.queue.splice(0)) emit(run.wc, 'run.status', { runId, hostId, status: 'cancelled' });
    if (this.child) void this.rpc('exec.cancel', { runId }).catch(() => undefined);
  }

  /** Opens an SFTP session; resolves once connected and authenticated. */
  async openSftp(wc: WebContents, hostId: string): Promise<{ sessionId: string }> {
    const fields = this.deps.hosts.getFields(hostId);
    const id = this.registerNoPort(wc, { kind: 'sftp', hostId, label: fields.label });
    try {
      const config = await this.resolveConfig(id, hostId);
      if (!config) throw new AppError('cancelled', 'files.error.cancelled');
      await this.rpc('sftp.open', { sessionId: id, config });
      if (!this.sessions.has(id)) throw new AppError('cancelled', 'files.error.cancelled');
      log.info({ sessionId: id, hostId }, 'sftp session opened');
      return { sessionId: id };
    } catch (err) {
      this.close(id);
      throw err instanceof AppError ? err : new AppError('internal', 'errors.internal');
    }
  }

  /** Request/response call into the session host (file operations, transfers). */
  rpc(method: RpcMethod, params: Record<string, unknown>, wc?: WebContents): Promise<unknown> {
    if (method === 'transfer.start' && wc) this.lastTransferWc = wc;
    const id = ++this.rpcSeq;
    return new Promise((resolve, reject) => {
      this.rpcPending.set(id, { resolve, reject });
      this.send({ type: 'rpc', id, method, params });
    }).then((v) => {
      if (method === 'transfer.start' && wc) for (const tid of (v as { transferIds: string[] }).transferIds) this.transferOwners.set(tid, wc);
      return v;
    });
  }

  /** Endpoints must be "local" or an open SFTP session of this window. */
  assertEndpoint(wc: WebContents, endpoint: string): void {
    if (endpoint === 'local') return;
    const s = this.sessions.get(endpoint);
    if (!s || s.kind !== 'sftp' || s.wc !== wc) throw new AppError('not_found', 'files.error.sessionClosed');
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
      case 'closed': {
        const s = this.sessions.get(msg.sessionId);
        if (s?.kind === 'sftp') emit(s.wc, 'session.status', { sessionId: s.id, status: 'closed' });
        this.cleanup(msg.sessionId);
        return;
      }
      case 'rpc-result': {
        const p = this.rpcPending.get(msg.id);
        if (!p) return;
        this.rpcPending.delete(msg.id);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(rpcToAppError(msg.error));
        return;
      }
      case 'os-detected': {
        const s = this.sessions.get(msg.sessionId);
        if (s?.hostId) {
          try {
            if (this.deps.hosts.getFields(s.hostId).osHint !== msg.os) {
              this.deps.hosts.setOsHint(s.hostId, msg.os);
              emit(s.wc, 'data.changed', { kinds: ['hosts'] });
            }
          } catch {
            // host deleted meanwhile
          }
        }
        return;
      }
      case 'run-status': {
        const run = this.runs.get(msg.status.runId);
        if (!run) return;
        emit(run.wc, 'run.status', msg.status);
        if (['done', 'error', 'cancelled'].includes(msg.status.status)) {
          run.active--;
          this.pumpRun(msg.status.runId);
        }
        return;
      }
      case 'run-output': {
        const run = this.runs.get(msg.output.runId);
        if (run) emit(run.wc, 'run.output', msg.output);
        return;
      }
      case 'forward': {
        if (msg.status.state === 'stopped') this.forwardState.delete(msg.status.id);
        else this.forwardState.set(msg.status.id, msg.status);
        this.deps.broadcast('forward.update', msg.status);
        return;
      }
      case 'transfer': {
        const t = msg.transfer;
        const wc = this.transferOwners.get(t.id) ?? this.lastTransferWc;
        emit(wc, 'transfer.update', t);
        if (t.state === 'done' || t.state === 'error' || t.state === 'cancelled') this.transferOwners.delete(t.id);
        return;
      }
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
          canSave: s.kind !== 'local' && s.hostId !== null && isPassword && msg.kind !== 'passphrase',
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

function rpcToAppError(e: RpcError): AppError {
  return new AppError(e.key.split('.').pop() ?? 'error', e.key, e.detail ? { detail: e.detail.slice(0, 300) } : undefined);
}

export function sessionHostScript(mainDir: string): string {
  return join(mainDir, 'session-host.js');
}
