/**
 * Preload (sandboxed). Exposes a typed, minimal API as `window.cy`. The renderer gets no
 * direct access to ipcRenderer, Node, or raw MessagePorts.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  encodeIpcError,
  EVENT_CHANNEL_PREFIX,
  SESSION_PORT_CHANNEL,
  allMethods,
  channel,
  events,
  type CyApi,
  type IpcResult,
  type PortToHost,
  type PortToRenderer,
  type TerminalHandlers,
  type TerminalStream,
} from '@cy-ssh/shared';

const api: Record<string, unknown> = {};

for (const [ns, m] of allMethods()) {
  const target = (api[ns] ??= {}) as Record<string, (input?: unknown) => Promise<unknown>>;
  target[m] = async (input?: unknown) => {
    const res = (await ipcRenderer.invoke(channel(ns, m), input ?? {})) as IpcResult<unknown>;
    if (res.ok) return res.value;
    // contextBridge keeps only `message`, so the envelope is encoded into it (see decodeIpcError).
    throw new Error(encodeIpcError(res.error));
  };
}

const eventNames = new Set(Object.keys(events));

api.on = (event: string, cb: (payload: unknown) => void) => {
  if (!eventNames.has(event)) throw new Error(`unknown event ${event}`);
  const listener = (_e: unknown, payload: unknown) => cb(payload);
  ipcRenderer.on(EVENT_CHANNEL_PREFIX + event, listener);
  return () => ipcRenderer.removeListener(EVENT_CHANNEL_PREFIX + event, listener);
};

// Session ports arrive from main; keep them here until the renderer attaches. Messages that
// arrive before attach are queued by the (not yet started) port.
const ports = new Map<string, MessagePort>();
ipcRenderer.on(SESSION_PORT_CHANNEL, (e, payload: { sessionId: string }) => {
  const port = e.ports[0];
  if (port && typeof payload?.sessionId === 'string') ports.set(payload.sessionId, port);
});

function waitForPort(sessionId: string): Promise<MessagePort> {
  const existing = ports.get(sessionId);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const check = (_e: unknown, payload: { sessionId: string }) => {
      if (payload?.sessionId !== sessionId) return;
      const p = ports.get(sessionId);
      if (p) {
        ipcRenderer.removeListener(SESSION_PORT_CHANNEL, check);
        resolve(p);
      }
    };
    ipcRenderer.on(SESSION_PORT_CHANNEL, check);
  });
}

api.attachTerminal = (sessionId: string, h: TerminalHandlers): TerminalStream => {
  let port: MessagePort | null = null;
  let detached = false;
  const outbox: PortToHost[] = [];
  const send = (msg: PortToHost) => (port ? port.postMessage(msg) : outbox.push(msg));

  void waitForPort(sessionId).then((p) => {
    if (detached) {
      p.close();
      return;
    }
    port = p;
    ports.delete(sessionId);
    p.onmessage = (ev: MessageEvent<PortToRenderer>) => {
      const msg = ev.data;
      if (msg.t === 'out') h.onData(msg.d);
      else if (msg.t === 'status') h.onStatus(msg.s, msg.msg);
      else if (msg.t === 'exit') h.onExit(msg.code);
    };
    for (const m of outbox.splice(0)) p.postMessage(m);
  });

  return {
    write: (d) => send({ t: 'in', d: String(d) }),
    resize: (cols, rows) => send({ t: 'resize', cols, rows }),
    ack: (n) => send({ t: 'ack', n }),
    detach: () => {
      detached = true;
      port?.close();
      port = null;
    },
  };
};

api.platform = process.platform;
api.pathForFile = (file: File) => webUtils.getPathForFile(file);

contextBridge.exposeInMainWorld('cy', api as CyApi);
