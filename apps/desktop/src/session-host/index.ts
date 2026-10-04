/**
 * Session host — runs in an Electron utilityProcess and owns every live connection
 * (SSH shells, local PTYs, SFTP) plus file transfers. Terminal bytes flow directly to the
 * renderer over a MessagePort per session; the main process only sees control messages.
 */
import { randomUUID } from 'node:crypto';
import type { MessagePortMain } from 'electron';
import type { HostKeyDecision, PortToHost, PortToRenderer } from '@chh/shared';
import { FsError, toFsError, type FsProvider } from './files/provider';
import { ForwardManager, type ForwardRule } from './forwards/manager';
import { LocalFs } from './files/local-fs';
import { SftpFs } from './files/sftp-fs';
import { TransferManager } from './files/transfers';
import { FlowControl, chunkSize } from './flow';
import type { HostToMain, MainToHost, RpcError, RpcMethod, SshConnectConfig } from './protocol';
import { connectChain, describeSshError, type AuthRequest, type HostKeyInfo } from './ssh/connect';
import { openLocalPty } from './transports/local-pty';
import { ExecRunner } from './exec/runner';
import { openMosh } from './transports/mosh';
import { openSerial } from './transports/serial';
import { openTelnet } from './transports/telnet';
import { openSsh } from './transports/ssh';
import type { Transport, TransportEvents } from './transports/types';

interface TerminalSession {
  id: string;
  port: MessagePortMain;
  transport: Transport | null;
  flow: FlowControl | null;
  closed: boolean;
}

const parentPort = process.parentPort;
const terminals = new Map<string, TerminalSession>();
/** SFTP endpoints by session id. "local" is always available. */
const filesystems = new Map<string, FsProvider>([['local', new LocalFs()]]);
/** SFTP sessions still connecting (so close() can cancel them). */
const connecting = new Set<string>();
const pendingHostKey = new Map<string, (d: HostKeyDecision) => void>();
const pendingAuth = new Map<string, (r: string[] | null) => void>();
const promptsBySession = new Map<string, Set<string>>();

function toMain(msg: HostToMain): void {
  parentPort.postMessage(msg);
}

const transfers = new TransferManager(
  (endpoint) => {
    const fs = filesystems.get(endpoint);
    if (!fs) throw new FsError('generic', 'session closed');
    return fs;
  },
  (transfer) => toMain({ type: 'transfer', transfer }),
);

const forwards = new ForwardManager((status) => toMain({ type: 'forward', status }));
const runner = new ExecRunner(
  (status) => toMain({ type: 'run-status', status }),
  (output) => toMain({ type: 'run-output', output }),
);

function toRenderer(s: TerminalSession, msg: PortToRenderer): void {
  if (!s.closed) s.port.postMessage(msg);
}

function trackPrompt(sessionId: string, promptId: string): void {
  let set = promptsBySession.get(sessionId);
  if (!set) promptsBySession.set(sessionId, (set = new Set()));
  set.add(promptId);
}

function failPrompts(sessionId: string): void {
  for (const pid of promptsBySession.get(sessionId) ?? []) {
    pendingHostKey.get(pid)?.('reject');
    pendingAuth.get(pid)?.(null);
    pendingHostKey.delete(pid);
    pendingAuth.delete(pid);
  }
  promptsBySession.delete(sessionId);
}

/** Prompt plumbing shared by shells and SFTP: questions go to main, which asks the user. */
function promptCallbacks(sessionId: string) {
  return {
    verifyHostKey: (info: HostKeyInfo) =>
      new Promise<boolean>((resolve) => {
        const promptId = randomUUID();
        trackPrompt(sessionId, promptId);
        pendingHostKey.set(promptId, (d) => resolve(d !== 'reject'));
        toMain({ type: 'hostkey-check', sessionId, promptId, ...info });
      }),
    requestAuth: (req: AuthRequest) =>
      new Promise<string[] | null>((resolve) => {
        const promptId = randomUUID();
        trackPrompt(sessionId, promptId);
        pendingAuth.set(promptId, resolve);
        toMain({ type: 'auth-prompt', sessionId, promptId, ...req });
      }),
    authSucceeded: (password: string | null) => toMain({ type: 'auth-succeeded', sessionId, password }),
  };
}

function closeTerminal(s: TerminalSession, notifyMain = true): void {
  if (s.closed) return;
  toRenderer(s, { t: 'status', s: 'closed' });
  s.closed = true;
  s.transport?.close();
  s.port.close();
  terminals.delete(s.id);
  failPrompts(s.id);
  if (notifyMain) toMain({ type: 'closed', sessionId: s.id });
}

function closeSftp(id: string, notifyMain = true): void {
  connecting.delete(id);
  failPrompts(id);
  const fs = filesystems.get(id);
  if (fs && id !== 'local') {
    transfers.cancelEndpoint(id);
    filesystems.delete(id);
    fs.close();
  }
  if (notifyMain) toMain({ type: 'closed', sessionId: id });
}

function baseEvents(s: TerminalSession): TransportEvents {
  return {
    data: (chunk) => {
      if (s.closed) return;
      s.flow?.sent(chunkSize(chunk));
      toRenderer(s, { t: 'out', d: chunk });
    },
    status: (status, message) => {
      toRenderer(s, { t: 'status', s: status, msg: message });
      toMain({ type: 'status', sessionId: s.id, status, message });
    },
    exit: (code) => {
      toRenderer(s, { t: 'exit', code });
      closeTerminal(s);
    },
  };
}

function newTerminal(id: string, port: MessagePortMain): TerminalSession {
  const s: TerminalSession = { id, port, transport: null, flow: null, closed: false };
  terminals.set(id, s);
  port.on('message', (e) => {
    const msg = e.data as PortToHost;
    if (s.closed || !msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'in':
        if (typeof msg.d === 'string') s.transport?.write(msg.d);
        break;
      case 'resize':
        if (Number.isInteger(msg.cols) && Number.isInteger(msg.rows) && msg.cols > 0 && msg.rows > 0) {
          s.transport?.resize(Math.min(msg.cols, 2000), Math.min(msg.rows, 1000));
        }
        break;
      case 'ack':
        if (typeof msg.n === 'number') s.flow?.acked(msg.n);
        break;
    }
  });
  port.on('close', () => closeTerminal(s));
  port.start();
  return s;
}

function attachTransport(s: TerminalSession, t: Transport): void {
  s.transport = t;
  s.flow = new FlowControl(
    () => t.pause(),
    () => t.resume(),
  );
}

// ---------------------------------------------------------------------------------------------
// RPC (file browser + transfers)

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new FsError('generic', `bad ${name}`);
  return v;
};

function fsFor(endpoint: unknown): FsProvider {
  const fs = filesystems.get(str(endpoint, 'endpoint'));
  if (!fs) throw new FsError('generic', 'session closed');
  return fs;
}

async function chmodRecursive(fs: FsProvider, path: string, mode: number): Promise<void> {
  await fs.chmod(path, mode);
  const s = await fs.stat(path);
  if (s?.type !== 'dir') return;
  for (const e of (await fs.list(path)).entries) {
    if (e.type === 'dir') await chmodRecursive(fs, e.path, mode);
    else if (e.type === 'file') await fs.chmod(e.path, mode);
  }
}

async function handleRpc(method: RpcMethod, p: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'sftp.open': {
      const sessionId = str(p.sessionId, 'sessionId');
      connecting.add(sessionId);
      const client = await connectChain(p.config as SshConnectConfig, {
        ...promptCallbacks(sessionId),
        status: () => undefined,
        isCancelled: () => !connecting.has(sessionId),
      });
      if (!connecting.has(sessionId)) {
        client.end();
        throw new FsError('generic', 'cancelled');
      }
      connecting.delete(sessionId);
      const fs = await SftpFs.open(client);
      filesystems.set(sessionId, fs);
      client.on('close', () => {
        if (filesystems.get(sessionId) === fs) closeSftp(sessionId);
      });
      return {};
    }
    case 'fs.home': {
      const fs = fsFor(p.endpoint);
      return { path: await fs.home(), separator: fs.sep };
    }
    case 'fs.list':
      return fsFor(p.endpoint).list(str(p.path, 'path'));
    case 'fs.mkdir':
      return fsFor(p.endpoint).mkdir(str(p.path, 'path'));
    case 'fs.rename':
      return fsFor(p.endpoint).rename(str(p.from, 'from'), str(p.to, 'to'));
    case 'fs.remove': {
      const fs = fsFor(p.endpoint);
      for (const path of p.paths as string[]) await fs.remove(str(path, 'path'));
      return undefined;
    }
    case 'fs.chmod': {
      const fs = fsFor(p.endpoint);
      for (const path of p.paths as string[]) {
        if (p.recursive) await chmodRecursive(fs, str(path, 'path'), p.mode as number);
        else await fs.chmod(str(path, 'path'), p.mode as number);
      }
      return undefined;
    }
    case 'fs.existing': {
      const fs = fsFor(p.endpoint);
      const dir = str(p.dir, 'dir');
      const out: string[] = [];
      for (const name of p.names as string[]) if (await fs.stat(fs.join(dir, name))) out.push(name);
      return out;
    }
    case 'transfer.start':
      return { transferIds: transfers.start(p as never) };
    case 'transfer.cancel':
      transfers.cancel(str(p.id, 'id'));
      return undefined;
    case 'forward.start': {
      const sessionId = str(p.sessionId, 'sessionId');
      const forwardId = str(p.forwardId, 'forwardId');
      try {
        await forwards.start(forwardId, p.rule as ForwardRule, p.config as SshConnectConfig, promptCallbacks(sessionId));
      } catch {
        // The manager already mapped the failure to an i18n message on the rule's status.
        const msg = forwards.statuses().find((x) => x.id === forwardId)?.message ?? 'forwards.error.generic::';
        const [key, detail] = msg.split('::');
        throw new RpcFailure(key!, detail);
      } finally {
        failPrompts(sessionId);
      }
      return undefined;
    }
    case 'exec.start': {
      const sessionId = str(p.sessionId, 'sessionId');
      // Runs in the background; progress is reported through run-status / run-output messages.
      void runner
        .run(str(p.runId, 'runId'), str(p.hostId, 'hostId'), p.config as SshConnectConfig, str(p.script, 'script'), promptCallbacks(sessionId))
        .finally(() => {
          failPrompts(sessionId);
          toMain({ type: 'closed', sessionId });
        });
      return undefined;
    }
    case 'exec.cancel':
      runner.cancel(str(p.runId, 'runId'));
      return undefined;
    case 'forward.stop':
      forwards.stop(str(p.forwardId, 'forwardId'));
      return undefined;
  }
}

/** An error that already carries its i18n key. */
class RpcFailure extends Error {
  constructor(
    readonly key: string,
    readonly detail?: string,
  ) {
    super(key);
  }
}

function rpcError(err: unknown): RpcError {
  if (err instanceof RpcFailure) return { key: err.key, detail: err.detail };
  if (err instanceof FsError) return { key: `files.error.${err.code}`, detail: err.message };
  const e = err as Error & { level?: string; code?: string };
  if (e?.level || typeof e?.code === 'string' && /^E[A-Z]+$/.test(e.code) && !('path' in e)) {
    const [key, detail] = describeSshError(e).split('::');
    return { key: key!, detail };
  }
  const fe = toFsError(err);
  return { key: `files.error.${fe.code}`, detail: fe.message };
}

// ---------------------------------------------------------------------------------------------

parentPort.on('message', (e) => {
  const msg = e.data as MainToHost;
  switch (msg.type) {
    case 'open-local': {
      const port = e.ports[0];
      if (!port) return;
      const s = newTerminal(msg.sessionId, port);
      try {
        attachTransport(s, openLocalPty({ shell: msg.shell, cwd: msg.cwd, cols: msg.cols, rows: msg.rows }, baseEvents(s)));
      } catch (err) {
        baseEvents(s).status('error', `session.error.spawn::${(err as Error).message}`);
        closeTerminal(s);
      }
      break;
    }
    case 'open-telnet': {
      const port = e.ports[0];
      if (!port) return;
      const s = newTerminal(msg.sessionId, port);
      attachTransport(s, openTelnet({ host: msg.host, port: msg.port, cols: msg.cols, rows: msg.rows, connectTimeoutSec: msg.connectTimeoutSec }, baseEvents(s)));
      break;
    }
    case 'open-serial': {
      const port = e.ports[0];
      if (!port) return;
      const s = newTerminal(msg.sessionId, port);
      attachTransport(s, openSerial({ path: msg.path, settings: msg.settings }, baseEvents(s)));
      break;
    }
    case 'open-mosh': {
      const port = e.ports[0];
      if (!port) return;
      const s = newTerminal(msg.sessionId, port);
      attachTransport(
        s,
        openMosh(
          { cols: msg.cols, rows: msg.rows, config: msg.config, moshServer: msg.moshServer, client: msg.client },
          { ...baseEvents(s), ...promptCallbacks(s.id) },
        ),
      );
      break;
    }
    case 'open-ssh': {
      const port = e.ports[0];
      if (!port) return;
      const s = newTerminal(msg.sessionId, port);
      attachTransport(
        s,
        openSsh(
          { cols: msg.cols, rows: msg.rows, config: msg.config },
          { ...baseEvents(s), ...promptCallbacks(s.id), osDetected: (os) => toMain({ type: 'os-detected', sessionId: s.id, os }) },
        ),
      );
      break;
    }
    case 'close': {
      const s = terminals.get(msg.sessionId);
      if (s) closeTerminal(s, true);
      else if (filesystems.has(msg.sessionId) || connecting.has(msg.sessionId)) closeSftp(msg.sessionId);
      break;
    }
    case 'hostkey-result': {
      pendingHostKey.get(msg.promptId)?.(msg.decision);
      pendingHostKey.delete(msg.promptId);
      break;
    }
    case 'auth-result': {
      pendingAuth.get(msg.promptId)?.(msg.responses);
      pendingAuth.delete(msg.promptId);
      break;
    }
    case 'rpc': {
      handleRpc(msg.method, msg.params ?? {}).then(
        (value) => toMain({ type: 'rpc-result', id: msg.id, ok: true, value }),
        (err) => toMain({ type: 'rpc-result', id: msg.id, ok: false, error: rpcError(err) }),
      );
      break;
    }
    case 'shutdown': {
      for (const s of [...terminals.values()]) closeTerminal(s, false);
      for (const id of [...filesystems.keys()]) if (id !== 'local') closeSftp(id, false);
      forwards.stopAll();
      process.exit(0);
    }
  }
});

toMain({ type: 'ready' });
