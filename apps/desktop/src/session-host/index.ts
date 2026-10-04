/**
 * Session host — runs in an Electron utilityProcess and owns every live connection
 * (SSH, local PTY, …). Terminal bytes flow directly to the renderer over a MessagePort
 * per session; the main process only sees control messages.
 */
import { randomUUID } from 'node:crypto';
import type { MessagePortMain } from 'electron';
import type { HostKeyDecision, PortToHost, PortToRenderer } from '@cy-ssh/shared';
import { FlowControl, chunkSize } from './flow';
import type { HostToMain, MainToHost } from './protocol';
import { openLocalPty } from './transports/local-pty';
import { openSsh } from './transports/ssh';
import type { Transport, TransportEvents } from './transports/types';

interface Session {
  id: string;
  port: MessagePortMain;
  transport: Transport | null;
  flow: FlowControl | null;
  closed: boolean;
}

const parentPort = process.parentPort;
const sessions = new Map<string, Session>();
const pendingHostKey = new Map<string, (d: HostKeyDecision) => void>();
const pendingAuth = new Map<string, (r: string[] | null) => void>();
const promptsBySession = new Map<string, Set<string>>();

function toMain(msg: HostToMain): void {
  parentPort.postMessage(msg);
}

function toRenderer(s: Session, msg: PortToRenderer): void {
  if (!s.closed) s.port.postMessage(msg);
}

function trackPrompt(sessionId: string, promptId: string): void {
  let set = promptsBySession.get(sessionId);
  if (!set) promptsBySession.set(sessionId, (set = new Set()));
  set.add(promptId);
}

function closeSession(s: Session, notifyMain = true): void {
  if (s.closed) return;
  toRenderer(s, { t: 'status', s: 'closed' });
  s.closed = true;
  s.transport?.close();
  s.port.close();
  sessions.delete(s.id);
  // Fail any prompts still waiting for an answer.
  for (const pid of promptsBySession.get(s.id) ?? []) {
    pendingHostKey.get(pid)?.('reject');
    pendingAuth.get(pid)?.(null);
    pendingHostKey.delete(pid);
    pendingAuth.delete(pid);
  }
  promptsBySession.delete(s.id);
  if (notifyMain) toMain({ type: 'closed', sessionId: s.id });
}

function baseEvents(s: Session): TransportEvents {
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
      closeSession(s);
    },
  };
}

function wirePort(s: Session): void {
  s.port.on('message', (e) => {
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
  s.port.on('close', () => closeSession(s));
  s.port.start();
}

function newSession(id: string, port: MessagePortMain): Session {
  const s: Session = { id, port, transport: null, flow: null, closed: false };
  sessions.set(id, s);
  wirePort(s);
  return s;
}

function attachTransport(s: Session, t: Transport): void {
  s.transport = t;
  s.flow = new FlowControl(
    () => t.pause(),
    () => t.resume(),
  );
}

parentPort.on('message', (e) => {
  const msg = e.data as MainToHost;
  switch (msg.type) {
    case 'open-local': {
      const port = e.ports[0];
      if (!port) return;
      const s = newSession(msg.sessionId, port);
      try {
        attachTransport(s, openLocalPty({ shell: msg.shell, cwd: msg.cwd, cols: msg.cols, rows: msg.rows }, baseEvents(s)));
      } catch (err) {
        baseEvents(s).status('error', `session.error.spawn::${(err as Error).message}`);
        closeSession(s);
      }
      break;
    }
    case 'open-ssh': {
      const port = e.ports[0];
      if (!port) return;
      const s = newSession(msg.sessionId, port);
      const ev = baseEvents(s);
      attachTransport(
        s,
        openSsh(
          { cols: msg.cols, rows: msg.rows, config: msg.config },
          {
            ...ev,
            verifyHostKey: (info) =>
              new Promise<boolean>((resolve) => {
                const promptId = randomUUID();
                trackPrompt(s.id, promptId);
                pendingHostKey.set(promptId, (d) => resolve(d !== 'reject'));
                toMain({ type: 'hostkey-check', sessionId: s.id, promptId, ...info });
              }),
            requestAuth: (req) =>
              new Promise<string[] | null>((resolve) => {
                const promptId = randomUUID();
                trackPrompt(s.id, promptId);
                pendingAuth.set(promptId, resolve);
                toMain({ type: 'auth-prompt', sessionId: s.id, promptId, ...req });
              }),
            authSucceeded: (password) => toMain({ type: 'auth-succeeded', sessionId: s.id, password }),
          },
        ),
      );
      break;
    }
    case 'close': {
      const s = sessions.get(msg.sessionId);
      if (s) closeSession(s, true);
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
    case 'shutdown': {
      for (const s of [...sessions.values()]) closeSession(s, false);
      process.exit(0);
    }
  }
});

toMain({ type: 'ready' });
