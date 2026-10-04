import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ConflictPolicy, Transfer } from '@chh/shared';
import { FsError, toFsError, type FsProvider } from './provider';

interface FileJob {
  src: string;
  dst: string;
  size: number;
  mode: number | null;
}

interface Plan {
  dirs: string[];
  files: FileJob[];
}

interface Running {
  t: Transfer;
  abort: AbortController;
  src: FsProvider;
  dst: FsProvider;
  dstDir: string;
  conflict: ConflictPolicy;
}

const EMIT_INTERVAL_MS = 250;
const MAX_PARALLEL = 2;

/** Picks "name (1).ext", "name (2).ext", … that doesn't exist yet. */
export async function uniqueName(fs: FsProvider, dir: string, name: string): Promise<string> {
  if (!(await fs.stat(fs.join(dir, name)))) return name;
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!(await fs.stat(fs.join(dir, candidate)))) return candidate;
  }
  throw new FsError('exists', 'no free name');
}

/**
 * Copies files and directory trees between any two providers (local ⇄ SFTP, SFTP ⇄ SFTP,
 * local ⇄ local). Each selected top-level item is one Transfer with live progress.
 */
export class TransferManager {
  private readonly queue: Running[] = [];
  private readonly active = new Map<string, Running>();
  private readonly all = new Map<string, Running>();

  constructor(
    private readonly provider: (endpoint: string) => FsProvider,
    private readonly emit: (t: Transfer) => void,
  ) {}

  start(req: { src: { endpoint: string; paths: string[] }; dst: { endpoint: string; dir: string }; conflict: ConflictPolicy }): string[] {
    const src = this.provider(req.src.endpoint);
    const dst = this.provider(req.dst.endpoint);
    const ids: string[] = [];
    for (const path of req.src.paths) {
      const name = src.basename(path);
      const t: Transfer = {
        id: randomUUID(),
        name,
        src: { endpoint: req.src.endpoint, path },
        dst: { endpoint: req.dst.endpoint, path: dst.join(req.dst.dir, name) },
        state: 'queued',
        totalBytes: 0,
        doneBytes: 0,
        files: 0,
        doneFiles: 0,
        rate: 0,
      };
      const r: Running = { t, abort: new AbortController(), src, dst, dstDir: req.dst.dir, conflict: req.conflict };
      this.all.set(t.id, r);
      this.queue.push(r);
      this.emit({ ...t });
      ids.push(t.id);
    }
    this.pump();
    return ids;
  }

  cancel(id: string): void {
    const r = this.all.get(id);
    if (!r || r.t.state === 'done' || r.t.state === 'error' || r.t.state === 'cancelled') return;
    r.abort.abort();
    if (r.t.state === 'queued') {
      this.queue.splice(this.queue.indexOf(r), 1);
      this.finish(r, 'cancelled');
    }
  }

  /** Cancels every transfer touching an endpoint (its session closed). */
  cancelEndpoint(endpoint: string): void {
    for (const r of this.all.values()) if (r.t.src.endpoint === endpoint || r.t.dst.endpoint === endpoint) this.cancel(r.t.id);
  }

  private pump(): void {
    while (this.active.size < MAX_PARALLEL && this.queue.length) {
      const r = this.queue.shift()!;
      this.active.set(r.t.id, r);
      void this.run(r).finally(() => {
        this.active.delete(r.t.id);
        this.pump();
      });
    }
  }

  private finish(r: Running, state: Transfer['state'], error?: string): void {
    r.t.state = state;
    r.t.rate = 0;
    if (error) r.t.error = error;
    this.emit({ ...r.t });
    // Keep finished transfers briefly so late cancel calls are harmless, then forget them.
    setTimeout(() => this.all.delete(r.t.id), 60_000).unref?.();
  }

  private async run(r: Running): Promise<void> {
    const { t, src, dst, abort } = r;
    t.state = 'running';
    this.emit({ ...t });
    try {
      const top = await src.stat(t.src.path);
      if (!top) throw new FsError('not_found', t.src.path);
      const dstDir = r.dstDir;

      if (src === dst && (top.type === 'dir') && isInside(dst.join(dstDir, t.name), t.src.path, src.sep)) {
        throw new FsError('generic', 'cannot copy a folder into itself');
      }

      const existing = await dst.stat(t.dst.path);
      if (existing) {
        if (r.conflict === 'rename') {
          t.name = await uniqueName(dst, dstDir, t.name);
          t.dst.path = dst.join(dstDir, t.name);
        } else if (r.conflict === 'skip' && top.type !== 'dir') {
          return this.finish(r, 'done');
        }
      }

      const plan: Plan = { dirs: [], files: [] };
      await this.plan(r, t.src.path, t.dst.path, top.type === 'dir', top.size, top.mode, plan);
      t.totalBytes = plan.files.reduce((n, f) => n + f.size, 0);
      t.files = plan.files.length;
      this.emit({ ...t });

      for (const d of plan.dirs) {
        if (abort.signal.aborted) break;
        if (!(await dst.stat(d))) await dst.mkdir(d);
      }

      let lastEmit = Date.now();
      let lastBytes = 0;
      for (const f of plan.files) {
        if (abort.signal.aborted) break;
        if (r.conflict === 'skip' && (await dst.stat(f.dst))) {
          t.doneBytes += f.size;
          t.doneFiles += 1;
          continue;
        }
        const counter = new Transform({
          transform: (chunk: Buffer, _enc, cb) => {
            t.doneBytes += chunk.length;
            const now = Date.now();
            if (now - lastEmit >= EMIT_INTERVAL_MS) {
              t.rate = ((t.doneBytes - lastBytes) * 1000) / (now - lastEmit);
              lastEmit = now;
              lastBytes = t.doneBytes;
              this.emit({ ...t });
            }
            cb(null, chunk);
          },
        });
        try {
          await pipeline(src.createReadStream(f.src), counter, dst.createWriteStream(f.dst, f.mode ?? undefined), { signal: abort.signal });
        } catch (err) {
          if (abort.signal.aborted) {
            await dst.remove(f.dst).catch(() => undefined); // don't leave a truncated file behind
            break;
          }
          throw err;
        }
        t.doneFiles += 1;
      }

      if (abort.signal.aborted) this.finish(r, 'cancelled');
      else this.finish(r, 'done');
    } catch (err) {
      const e = toFsError(err);
      this.finish(r, abort.signal.aborted ? 'cancelled' : 'error', `files.error.${e.code}::${e.message}`);
    }
  }

  private async plan(r: Running, srcPath: string, dstPath: string, isDir: boolean, size: number, mode: number | null, plan: Plan): Promise<void> {
    if (r.abort.signal.aborted) return;
    if (!isDir) {
      plan.files.push({ src: srcPath, dst: dstPath, size, mode });
      return;
    }
    plan.dirs.push(dstPath);
    const listing = await r.src.list(srcPath);
    for (const e of listing.entries) {
      const childDst = r.dst.join(dstPath, e.name);
      if (e.type === 'dir') await this.plan(r, e.path, childDst, true, 0, e.mode, plan);
      else if (e.type === 'file') plan.files.push({ src: e.path, dst: childDst, size: e.size, mode: e.mode });
      else if (e.type === 'symlink' && !e.targetIsDir) plan.files.push({ src: e.path, dst: childDst, size: e.size, mode: e.mode });
      // Directory symlinks and special files are skipped to avoid loops and device files.
    }
  }
}

function isInside(child: string, parent: string, sep: string): boolean {
  const norm = (s: string) => (s.endsWith(sep) ? s : s + sep);
  return norm(child).startsWith(norm(parent));
}
