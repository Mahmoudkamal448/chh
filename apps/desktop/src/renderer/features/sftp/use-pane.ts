import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileEntry } from '@chh/shared';
import { errorMessage } from '../../lib/errors';

export type PaneSource = { kind: 'local' } | { kind: 'host'; hostId: string; label: string };

export interface PaneState {
  source: PaneSource;
  /** 'local' or the SFTP session id once connected. */
  endpoint: string | null;
  status: 'connecting' | 'ready' | 'error' | 'closed';
  /** i18n key (+ detail) for the last error. */
  error: { key: string; detail?: string } | null;
  sep: '/' | '\\';
  path: string;
  parent: string | null;
  entries: FileEntry[];
  loading: boolean;
}

export interface Pane extends PaneState {
  connect(source: PaneSource): Promise<void>;
  navigate(path: string): Promise<void>;
  refresh(): Promise<void>;
  join(name: string, dir?: string): string;
  /** Runs a file operation and refreshes; returns false (and sets error) on failure. */
  run(op: (endpoint: string) => Promise<unknown>): Promise<boolean>;
  clearError(): void;
}

function ipcErr(err: unknown): { key: string; detail?: string } {
  const { key, detail } = errorMessage(err);
  return { key, detail: detail || undefined };
}

export function usePane(initial: PaneSource): Pane {
  const [s, setS] = useState<PaneState>({
    source: initial,
    endpoint: null,
    status: 'connecting',
    error: null,
    sep: '/',
    path: '',
    parent: null,
    entries: [],
    loading: false,
  });
  const ref = useRef(s);
  ref.current = s;
  const update = (patch: Partial<PaneState>) => setS((prev) => ({ ...prev, ...patch }));

  const list = useCallback(async (endpoint: string, path: string) => {
    update({ loading: true });
    try {
      const res = await window.chh.sftp.list({ endpoint, path });
      update({ path: res.path, parent: res.parent, entries: res.entries, loading: false, error: null });
      return true;
    } catch (err) {
      update({ loading: false, error: ipcErr(err) });
      return false;
    }
  }, []);

  const closeRemote = (endpoint: string | null) => {
    if (endpoint && endpoint !== 'local') void window.chh.sftp.close({ sessionId: endpoint });
  };

  const connect = useCallback(
    async (source: PaneSource) => {
      closeRemote(ref.current.endpoint);
      update({ source, endpoint: null, status: 'connecting', error: null, entries: [], path: '', parent: null });
      try {
        const endpoint = source.kind === 'local' ? 'local' : (await window.chh.sftp.open({ hostId: source.hostId })).sessionId;
        // The user may have switched source while we were connecting.
        if (ref.current.source !== source) return closeRemote(endpoint);
        const home = await window.chh.sftp.home({ endpoint });
        update({ endpoint, status: 'ready', sep: home.separator });
        await list(endpoint, home.path);
      } catch (err) {
        if (ref.current.source === source) update({ status: 'error', error: ipcErr(err) });
      }
    },
    [list],
  );

  // Connect on mount; close any SFTP session on unmount.
  useEffect(() => {
    void connect(initial);
    return () => closeRemote(ref.current.endpoint);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Server closed the session (network drop, idle timeout…).
  useEffect(
    () =>
      window.chh.on('session.status', ({ sessionId, status }) => {
        if (sessionId === ref.current.endpoint && status === 'closed') update({ status: 'closed', endpoint: null });
      }),
    [],
  );

  const navigate = useCallback(async (path: string) => {
    const ep = ref.current.endpoint;
    if (ep) await list(ep, path);
  }, [list]);

  const refresh = useCallback(async () => {
    const ep = ref.current.endpoint;
    if (ep) await list(ep, ref.current.path);
  }, [list]);

  const join = useCallback((name: string, dir?: string) => {
    const d = dir ?? ref.current.path;
    const sep = ref.current.sep;
    return d.endsWith(sep) ? d + name : d + sep + name;
  }, []);

  const run = useCallback(
    async (op: (endpoint: string) => Promise<unknown>) => {
      const ep = ref.current.endpoint;
      if (!ep) return false;
      try {
        await op(ep);
        await list(ep, ref.current.path);
        return true;
      } catch (err) {
        // Refresh first (a partial operation may have changed things), then show the error.
        await list(ep, ref.current.path);
        update({ error: ipcErr(err) });
        return false;
      }
    },
    [list],
  );

  return { ...s, connect, navigate, refresh, join, run, clearError: () => update({ error: null }) };
}
