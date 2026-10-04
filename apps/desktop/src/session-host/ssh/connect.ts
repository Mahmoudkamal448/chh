import type { Duplex } from 'node:stream';
import { Client, type AuthenticationType, type ConnectConfig } from 'ssh2';
import type { SshConnectConfig } from '../protocol';
import { fingerprintSha256, keyTypeOf } from '../host-key';
import { keyAcceptsPassphrase, loadDefaultKeys, systemAgentPath } from './keys';
import { ProxyError, connectViaProxy } from './proxy';

export interface HostKeyInfo {
  hostPattern: string;
  keyType: string;
  fingerprint: string;
  publicKey: string;
}

export interface AuthRequest {
  kind: 'password' | 'keyboard-interactive' | 'passphrase' | 'proxy';
  title: string;
  instructions: string;
  prompts: Array<{ prompt: string; echo: boolean }>;
  retry: boolean;
}

export interface ConnectCallbacks {
  status(s: 'connecting' | 'authenticating'): void;
  verifyHostKey(info: HostKeyInfo): Promise<boolean>;
  /** Resolves with the user's answers, or null if they cancelled. */
  requestAuth(req: AuthRequest): Promise<string[] | null>;
  /** Reports which prompted password (if any) succeeded, so it can be remembered. */
  authSucceeded(promptedPassword: string | null): void;
  /** Whether the caller has given up (tab closed) — stops prompting. */
  isCancelled(): boolean;
}

const MAX_ATTEMPTS = 3;

/** Maps ssh2/socket errors to i18n keys understood by the renderer ("key::detail"). */
export function describeSshError(err: Error & { level?: string; code?: string; hop?: string }): string {
  if (err instanceof ProxyError) return err.code === 'proxyAuth' ? 'session.error.proxyAuth' : `session.error.${err.code}::${err.message}`;
  // A jump host failed: say which one (the details of why are in the log).
  if (err.hop) return `session.error.jump::${err.hop}`;
  if (err.level === 'client-authentication') return 'session.error.auth';
  if (err.level === 'client-timeout') return 'session.error.timeout';
  switch (err.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'session.error.dns';
    case 'ECONNREFUSED':
      return 'session.error.refused';
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'session.error.unreachable';
    case 'ECONNRESET':
      return 'session.error.reset';
  }
  return `session.error.generic::${err.message}`;
}

type Step =
  | { type: 'key'; key: string | Buffer; passphrase?: string }
  | { type: 'default-key'; name: string; data: Buffer; encrypted: boolean }
  | { type: 'agent'; agent: string }
  | { type: 'saved-password' }
  | { type: 'keyboard-interactive' }
  | { type: 'prompt-password' };

/**
 * Opens an authenticated SSH connection. Auth order:
 * explicit key → system agent → ~/.ssh default keys (prompting for passphrases) → saved password →
 * keyboard-interactive → password prompt (up to 3 attempts).
 */
/** The configured agent: "" = system default, "pageant", or an explicit socket/pipe. */
export function resolveAgent(setting: string): string | null {
  return setting ? setting : systemAgentPath();
}

/** Opens a channel from `client` to host:port (used to reach the next hop). */
function forwardOut(client: Client, host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => client.forwardOut('127.0.0.1', 0, host, port, (err, ch) => (err ? reject(err) : resolve(ch))));
}

/**
 * Connects through an optional proxy and any jump hosts to the target, authenticating at every hop.
 * Returns the target's client; closing it closes the whole chain.
 */
export async function connectChain(config: SshConnectConfig, cb: ConnectCallbacks): Promise<Client> {
  const hops = [...config.jumps, config];
  const clients: Client[] = [];
  let sock: Duplex | undefined;
  try {
    if (config.proxy && config.proxy.type !== 'none') {
      let password: string | null = null;
      if (config.proxy.username && config.proxy.type !== 'socks4') {
        const answer = await cb.requestAuth({
          kind: 'proxy',
          title: `${config.proxy.username}@${config.proxy.host}:${config.proxy.port}`,
          instructions: '',
          prompts: [{ prompt: 'Proxy password', echo: false }],
          retry: false,
        });
        if (!answer || cb.isCancelled()) throw Object.assign(new Error('cancelled'), { level: 'client-authentication' });
        password = answer[0] ?? '';
      }
      sock = await connectViaProxy(config.proxy, password, hops[0]!.host, hops[0]!.port, hops[0]!.connectTimeoutSec * 1000);
    }
    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i]!;
      try {
        clients.push(await connectSsh(hop, cb, sock));
        if (i < hops.length - 1) sock = await forwardOut(clients[i]!, hops[i + 1]!.host, hops[i + 1]!.port);
      } catch (e) {
        // Failures at a jump host (logging in, or it not reaching the next hop) name that jump host.
        if (i < hops.length - 1) Object.assign(e as object, { hop: hop.label });
        throw e;
      }
    }
  } catch (e) {
    for (const c of clients.reverse()) c.end();
    throw e;
  }
  const target = clients[clients.length - 1]!;
  // Errors after login (e.g. a jump host resetting the connection) must never be unhandled: that
  // would take down the whole session host. Callers add their own handlers for the target.
  for (const c of clients) c.on('error', () => c.end());
  target.once('close', () => clients.slice(0, -1).reverse().forEach((c) => c.end()));
  return target;
}

export async function connectSsh(config: SshConnectConfig, cb: ConnectCallbacks, sock?: Duplex): Promise<Client> {
  cb.status('connecting');
  const steps: Step[] = [];
  if (config.privateKey) steps.push({ type: 'key', key: config.privateKey });
  const agent = config.useAgent ? resolveAgent(config.agent) : null;
  if (agent) steps.push({ type: 'agent', agent });
  if (config.tryDefaultKeys) for (const k of await loadDefaultKeys()) steps.push({ type: 'default-key', ...k });
  if (config.password) steps.push({ type: 'saved-password' });
  steps.push({ type: 'keyboard-interactive' });
  steps.push({ type: 'prompt-password' });

  const client = new Client();
  let promptedPassword: string | null = null;
  let passwordAttempts = 0;
  let savedPasswordTried = false;
  let kbdiUsedSaved = false;
  const username = config.username;
  const allowed = (left: AuthenticationType[] | null, m: AuthenticationType) => !left || left.includes(m);

  const askPassphrase = async (name: string, data: Buffer): Promise<string | null> => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (cb.isCancelled()) return null;
      const answer = await cb.requestAuth({
        kind: 'passphrase',
        title: `~/.ssh/${name}`,
        instructions: '',
        prompts: [{ prompt: 'Passphrase', echo: false }],
        retry: attempt > 0,
      });
      if (!answer) return null;
      if (keyAcceptsPassphrase(data, answer[0] ?? '')) return answer[0] ?? '';
    }
    return null;
  };

  const authHandler = (methodsLeft: AuthenticationType[] | null, _partial: boolean | null, next: (auth: unknown) => void): void => {
    void (async () => {
      cb.status('authenticating');
      while (steps.length) {
        if (cb.isCancelled()) return next(false);
        const step = steps[0]!;
        switch (step.type) {
          case 'key':
            steps.shift();
            if (allowed(methodsLeft, 'publickey')) return next({ type: 'publickey', username, key: step.key, passphrase: step.passphrase });
            continue;
          case 'agent':
            steps.shift();
            if (allowed(methodsLeft, 'publickey')) return next({ type: 'agent', username, agent: step.agent });
            continue;
          case 'default-key': {
            steps.shift();
            if (!allowed(methodsLeft, 'publickey')) continue;
            if (!step.encrypted) return next({ type: 'publickey', username, key: step.data });
            const passphrase = await askPassphrase(step.name, step.data);
            if (passphrase === null) continue; // skipped by the user
            return next({ type: 'publickey', username, key: step.data, passphrase });
          }
          case 'saved-password':
            steps.shift();
            if (allowed(methodsLeft, 'password')) {
              savedPasswordTried = true;
              return next({ type: 'password', username, password: config.password });
            }
            continue;
          case 'keyboard-interactive':
            steps.shift();
            if (allowed(methodsLeft, 'keyboard-interactive')) return next({ type: 'keyboard-interactive', username, prompt: keyboardInteractive });
            continue;
          case 'prompt-password': {
            if (!allowed(methodsLeft, 'password') || passwordAttempts >= MAX_ATTEMPTS) {
              steps.shift();
              continue;
            }
            const retry = passwordAttempts > 0 || savedPasswordTried;
            passwordAttempts += 1;
            const answer = await cb.requestAuth({
              kind: 'password',
              title: `${username}@${config.host}`,
              instructions: '',
              prompts: [{ prompt: 'Password', echo: false }],
              retry,
            });
            if (cb.isCancelled() || !answer) return next(false);
            promptedPassword = answer[0] ?? '';
            return next({ type: 'password', username, password: promptedPassword });
          }
        }
      }
      next(false);
    })();
  };

  const keyboardInteractive = (
    name: string,
    instructions: string,
    _lang: string,
    prompts: Array<{ prompt: string; echo?: boolean }>,
    finish: (responses: string[]) => void,
  ) => {
    if (prompts.length === 0) return finish([]);
    // PAM servers often ask for the password via keyboard-interactive: answer with the saved one once.
    if (config.password && !kbdiUsedSaved && prompts.length === 1 && !prompts[0]!.echo && /password/i.test(prompts[0]!.prompt)) {
      kbdiUsedSaved = true;
      return finish([config.password]);
    }
    void cb
      .requestAuth({
        kind: 'keyboard-interactive',
        title: name || `${username}@${config.host}`,
        instructions,
        prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo })),
        retry: false,
      })
      .then((answers) => {
        if (cb.isCancelled() || !answers) {
          client.end();
          return;
        }
        if (prompts.length === 1 && !prompts[0]!.echo) promptedPassword = answers[0] ?? null;
        finish(answers);
      });
  };

  const connectConfig = {
    host: config.host,
    port: config.port,
    username,
    readyTimeout: config.connectTimeoutSec * 1000,
    keepaliveInterval: config.keepAliveSec * 1000,
    keepaliveCountMax: 3,
    tryKeyboard: true,
    ...(sock ? { sock } : {}),
    // Agent forwarding needs the agent path too (ssh2 serves forwarded requests from it).
    ...(config.agentForward && agent ? { agent, agentForward: true } : {}),
    authHandler,
    hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
      const info: HostKeyInfo = {
        hostPattern: config.port === 22 ? config.host : `[${config.host}]:${config.port}`,
        keyType: keyTypeOf(key),
        fingerprint: fingerprintSha256(key),
        publicKey: key.toString('base64'),
      };
      cb.verifyHostKey(info).then(
        (ok) => verify(ok && !cb.isCancelled()),
        () => verify(false),
      );
    },
  } as unknown as ConnectConfig;

  return new Promise<Client>((resolve, reject) => {
    const onError = (err: Error) => {
      // An unreachable agent (Windows without the OpenSSH agent service, a stale SSH_AUTH_SOCK) is
      // reported as an error, but ssh2 carries on with the next method: it must not end the login.
      if ((err as Error & { level?: string }).level === 'agent') {
        client.once('error', onError);
        return;
      }
      client.removeListener('ready', onReady);
      reject(err);
    };
    const onReady = () => {
      client.removeListener('error', onError);
      cb.authSucceeded(promptedPassword);
      promptedPassword = null;
      resolve(client);
    };
    client.once('ready', onReady);
    client.once('error', onError);
    client.connect(connectConfig);
  });
}
