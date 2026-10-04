import { Client, type AuthenticationType, type ClientChannel, type ConnectConfig } from 'ssh2';
import type { SshConnectConfig } from '../protocol';
import { fingerprintSha256, keyTypeOf } from '../host-key';
import { loadDefaultKeys, systemAgentPath } from '../ssh-keys';
import type { Transport, TransportEvents } from './types';

export interface HostKeyInfo {
  hostPattern: string;
  keyType: string;
  fingerprint: string;
  publicKey: string;
}

export interface AuthRequest {
  kind: 'password' | 'keyboard-interactive';
  title: string;
  instructions: string;
  prompts: Array<{ prompt: string; echo: boolean }>;
  retry: boolean;
}

export interface SshCallbacks extends TransportEvents {
  verifyHostKey(info: HostKeyInfo): Promise<boolean>;
  /** Resolves with the user's answers, or null if they cancelled. */
  requestAuth(req: AuthRequest): Promise<string[] | null>;
  /** Reports which password (if any) was used for the successful prompted login. */
  authSucceeded(promptedPassword: string | null): void;
}

const MAX_PASSWORD_ATTEMPTS = 3;

/** Maps ssh2/socket errors to i18n keys understood by the renderer ("key::detail"). */
export function describeSshError(err: Error & { level?: string; code?: string }): string {
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
  | { type: 'agent'; agent: string }
  | { type: 'publickey'; key: Buffer }
  | { type: 'saved-password' }
  | { type: 'keyboard-interactive' }
  | { type: 'prompt-password' };

export function openSsh(
  opts: { cols: number; rows: number; config: SshConnectConfig },
  cb: SshCallbacks,
): Transport {
  const { config } = opts;
  const client = new Client();
  let channel: ClientChannel | null = null;
  let closed = false;
  let exited = false;
  let cols = opts.cols;
  let rows = opts.rows;
  let promptedPassword: string | null = null;
  let passwordAttempts = 0;
  let savedPasswordFailed = false;

  const finish = (code: number | null) => {
    if (exited) return;
    exited = true;
    cb.exit(code);
  };

  const run = async () => {
    cb.status('connecting');
    const steps: Step[] = [];
    const agent = config.useAgent ? systemAgentPath() : null;
    if (agent) steps.push({ type: 'agent', agent });
    if (config.tryDefaultKeys) for (const key of await loadDefaultKeys()) steps.push({ type: 'publickey', key });
    if (config.password) steps.push({ type: 'saved-password' });
    steps.push({ type: 'keyboard-interactive' });
    steps.push({ type: 'prompt-password' });
    if (closed) return;

    const methodAllowed = (left: AuthenticationType[] | null, m: AuthenticationType) => !left || left.includes(m);

    const authHandler = (
      methodsLeft: AuthenticationType[] | null,
      _partial: boolean | null,
      next: (auth: unknown) => void,
    ): void => {
      void (async () => {
        cb.status('authenticating');
        while (steps.length) {
          const step = steps[0]!;
          const username = config.username;
          switch (step.type) {
            case 'agent':
              steps.shift();
              if (methodAllowed(methodsLeft, 'publickey')) return next({ type: 'agent', username, agent: step.agent });
              continue;
            case 'publickey':
              steps.shift();
              if (methodAllowed(methodsLeft, 'publickey')) return next({ type: 'publickey', username, key: step.key });
              continue;
            case 'saved-password':
              steps.shift();
              if (methodAllowed(methodsLeft, 'password')) {
                savedPasswordFailed = true; // cleared on success
                return next({ type: 'password', username, password: config.password });
              }
              continue;
            case 'keyboard-interactive':
              steps.shift();
              if (methodAllowed(methodsLeft, 'keyboard-interactive')) {
                return next({ type: 'keyboard-interactive', username, prompt: keyboardInteractive });
              }
              continue;
            case 'prompt-password': {
              if (!methodAllowed(methodsLeft, 'password') || passwordAttempts >= MAX_PASSWORD_ATTEMPTS) {
                steps.shift();
                continue;
              }
              const retry = passwordAttempts > 0 || savedPasswordFailed;
              passwordAttempts += 1;
              const answer = await cb.requestAuth({
                kind: 'password',
                title: `${username}@${config.host}`,
                instructions: '',
                prompts: [{ prompt: 'Password', echo: false }],
                retry,
              });
              if (closed || !answer) return next(false);
              promptedPassword = answer[0] ?? '';
              return next({ type: 'password', username, password: promptedPassword });
            }
          }
        }
        next(false);
      })();
    };

    let kbdiUsedSaved = false;
    const keyboardInteractive = (
      name: string,
      instructions: string,
      _lang: string,
      prompts: Array<{ prompt: string; echo?: boolean }>,
      finishKbdi: (responses: string[]) => void,
    ) => {
      if (prompts.length === 0) return finishKbdi([]);
      // PAM servers often ask for the password via keyboard-interactive: answer with the saved one once.
      if (
        config.password &&
        !kbdiUsedSaved &&
        prompts.length === 1 &&
        !prompts[0]!.echo &&
        /password/i.test(prompts[0]!.prompt)
      ) {
        kbdiUsedSaved = true;
        return finishKbdi([config.password]);
      }
      void cb
        .requestAuth({
          kind: 'keyboard-interactive',
          title: name || `${config.username}@${config.host}`,
          instructions,
          prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo })),
          retry: false,
        })
        .then((answers) => {
          if (closed || !answers) {
            client.end();
            return;
          }
          if (prompts.length === 1 && !prompts[0]!.echo) promptedPassword = answers[0] ?? null;
          finishKbdi(answers);
        });
    };

    const connectConfig: ConnectConfig = {
      host: config.host,
      port: config.port,
      username: config.username,
      readyTimeout: config.connectTimeoutSec * 1000,
      keepaliveInterval: config.keepAliveSec * 1000,
      keepaliveCountMax: 3,
      tryKeyboard: true,
      authHandler: authHandler as ConnectConfig['authHandler'],
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        const info: HostKeyInfo = {
          hostPattern: config.port === 22 ? config.host : `[${config.host}]:${config.port}`,
          keyType: keyTypeOf(key),
          fingerprint: fingerprintSha256(key),
          publicKey: key.toString('base64'),
        };
        cb.verifyHostKey(info).then(
          (ok) => verify(ok && !closed),
          () => verify(false),
        );
      },
    } as ConnectConfig;

    client.on('ready', () => {
      if (closed) return client.end();
      cb.authSucceeded(promptedPassword);
      promptedPassword = null;
      client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) {
          cb.status('error', describeSshError(err));
          client.end();
          return;
        }
        channel = stream;
        cb.status('ready');
        stream.on('data', (d: Buffer) => cb.data(new Uint8Array(d)));
        stream.stderr.on('data', (d: Buffer) => cb.data(new Uint8Array(d)));
        stream.on('exit', (code: number | null) => finish(typeof code === 'number' ? code : null));
        stream.on('close', () => {
          finish(null);
          client.end();
        });
      });
    });
    client.on('error', (err) => {
      if (closed) return;
      cb.status('error', describeSshError(err));
      finish(null);
    });
    client.on('close', () => finish(null));
    client.connect(connectConfig);
  };

  run().catch((err: Error) => {
    cb.status('error', describeSshError(err));
    finish(null);
  });

  return {
    write: (d) => channel?.write(d),
    resize: (c, r) => {
      cols = c;
      rows = r;
      channel?.setWindow(r, c, 0, 0);
    },
    pause: () => channel?.pause(),
    resume: () => channel?.resume(),
    close: () => {
      if (closed) return;
      closed = true;
      channel?.close();
      client.end();
    },
  };
}
