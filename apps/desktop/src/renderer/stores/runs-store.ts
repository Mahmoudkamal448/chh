import { create } from 'zustand';
import type { RunHostStatus } from '@chh/shared';

export interface RunHost {
  hostId: string;
  label: string;
  status: RunHostStatus['status'] | 'skipped';
  exitCode?: number | null;
  error?: string;
  skipped?: string;
  output: Array<{ stream: 'stdout' | 'stderr' | 'info'; data: string }>;
}

export interface Run {
  runId: string;
  title: string;
  script: string;
  hostIds: string[];
  hosts: Record<string, RunHost>;
  startedAt: number;
}

interface RunsState {
  runs: Record<string, Run>;
  add(run: Run): void;
}

export const useRuns = create<RunsState>((set, get) => ({
  runs: {},
  add: (run) => set({ runs: { ...get().runs, [run.runId]: run } }),
}));

function patchHost(runId: string, hostId: string, fn: (h: RunHost) => RunHost) {
  const runs = useRuns.getState().runs;
  const run = runs[runId];
  const host = run?.hosts[hostId];
  if (!run || !host) return;
  useRuns.setState({ runs: { ...runs, [runId]: { ...run, hosts: { ...run.hosts, [hostId]: fn(host) } } } });
}

window.chh.on('run.status', (s) => patchHost(s.runId, s.hostId, (h) => ({ ...h, status: s.status, exitCode: s.exitCode, error: s.error })));
window.chh.on('run.output', (o) => patchHost(o.runId, o.hostId, (h) => ({ ...h, output: [...h.output, { stream: o.stream, data: o.data }] })));

/** Starts a run and returns its id (the caller opens a tab for it). */
export async function startRun(hostIds: string[], script: string, title: string): Promise<string> {
  const res = await window.chh.run.start({ hostIds, script, title });
  const hosts: Record<string, RunHost> = {};
  for (const h of res.hosts) {
    hosts[h.hostId] = { hostId: h.hostId, label: h.label, status: h.skipped ? 'skipped' : 'queued', skipped: h.skipped, output: [] };
  }
  useRuns.getState().add({ runId: res.runId, title, script, hostIds: res.hosts.map((h) => h.hostId), hosts, startedAt: Date.now() });
  return res.runId;
}
