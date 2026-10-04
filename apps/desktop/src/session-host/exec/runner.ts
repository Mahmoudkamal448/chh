import type { Client, ClientChannel } from 'ssh2';
import type { RunHostStatus, RunOutput } from '@chh/shared';
import type { SshConnectConfig } from '../protocol';
import { connectChain, describeSshError, type ConnectCallbacks } from '../ssh/connect';

const MAX_OUTPUT = 1024 * 1024; // per host
const FLUSH_MS = 80;

interface Job {
  client: Client | null;
  channel: ClientChannel | null;
  cancelled: boolean;
}

/** Runs a script non-interactively over SSH exec channels, streaming output per host. */
export class ExecRunner {
  private readonly jobs = new Map<string, Job>(); // `${runId}/${hostId}`

  constructor(
    private readonly emitStatus: (s: RunHostStatus) => void,
    private readonly emitOutput: (o: RunOutput) => void,
  ) {}

  async run(runId: string, hostId: string, config: SshConnectConfig, script: string, cb: Omit<ConnectCallbacks, 'status' | 'isCancelled'>): Promise<void> {
    const key = `${runId}/${hostId}`;
    const job: Job = { client: null, channel: null, cancelled: false };
    this.jobs.set(key, job);
    const status = (s: Omit<RunHostStatus, 'runId' | 'hostId'>) => this.emitStatus({ runId, hostId, ...s });
    status({ status: 'connecting' });
    try {
      const client = await connectChain(config, { ...cb, status: () => undefined, isCancelled: () => job.cancelled });
      job.client = client;
      if (job.cancelled) {
        client.end();
        return status({ status: 'cancelled' });
      }
      status({ status: 'running' });
      const code = await new Promise<number | null>((resolve, reject) => {
        const env = config.envMethod === 'request' && Object.keys(config.env).length ? { env: config.env } : {};
        const body = config.envMethod === 'export' && Object.keys(config.env).length
          ? `${Object.entries(config.env).map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'`).join('; ')}; ${script}`
          : script;
        client.exec(body, env, (err, ch) => {
          if (err) return reject(err);
          job.channel = ch;
          let total = 0;
          let truncated = false;
          const buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
          let timer: ReturnType<typeof setTimeout> | null = null;
          const flush = () => {
            timer = null;
            for (const stream of ['stdout', 'stderr'] as const) {
              if (buffers[stream]) this.emitOutput({ runId, hostId, stream, data: buffers[stream] });
              buffers[stream] = '';
            }
          };
          const push = (stream: 'stdout' | 'stderr') => (d: Buffer) => {
            if (truncated) return;
            total += d.length;
            if (total > MAX_OUTPUT) {
              truncated = true;
              flush();
              this.emitOutput({ runId, hostId, stream: 'info', data: 'run.truncated' });
              return;
            }
            buffers[stream] += d.toString('utf8');
            timer ??= setTimeout(flush, FLUSH_MS);
          };
          ch.on('data', push('stdout'));
          ch.stderr.on('data', push('stderr'));
          let exitCode: number | null = null;
          ch.on('exit', (c: number | null) => (exitCode = typeof c === 'number' ? c : null));
          ch.on('close', () => {
            if (timer) clearTimeout(timer);
            flush();
            resolve(exitCode);
          });
        });
      });
      client.end();
      status(job.cancelled ? { status: 'cancelled' } : { status: 'done', exitCode: code });
    } catch (e) {
      job.client?.end();
      status(job.cancelled ? { status: 'cancelled' } : { status: 'error', error: describeSshError(e as Error) });
    } finally {
      this.jobs.delete(key);
    }
  }

  cancel(runId: string): void {
    for (const [key, job] of this.jobs) {
      if (!key.startsWith(`${runId}/`)) continue;
      job.cancelled = true;
      job.channel?.signal('INT');
      job.channel?.close();
      job.client?.end();
    }
  }
}
