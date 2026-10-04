import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { FileEntry } from '@cy-ssh/shared';
import { sortEntries, toFsError, type FsProvider } from './provider';

const isWin = process.platform === 'win32';
/** On Windows, "" lists the available drive letters. */
const DRIVES_ROOT = '';

async function toEntry(full: string, name: string): Promise<FileEntry | null> {
  try {
    const l = await lstat(full);
    let type: FileEntry['type'] = l.isDirectory() ? 'dir' : l.isFile() ? 'file' : l.isSymbolicLink() ? 'symlink' : 'other';
    let targetIsDir = false;
    let size = l.size;
    if (type === 'symlink') {
      try {
        const s = await stat(full);
        targetIsDir = s.isDirectory();
        size = s.size;
      } catch {
        // dangling link
      }
    }
    if (type === 'dir') size = 0;
    return {
      name,
      path: full,
      type,
      targetIsDir,
      size,
      mtime: l.mtimeMs,
      mode: isWin ? null : l.mode & 0o7777,
      owner: isWin ? null : String(l.uid),
      group: isWin ? null : String(l.gid),
    };
  } catch {
    return null; // vanished or unreadable (e.g. Windows system files)
  }
}

export class LocalFs implements FsProvider {
  readonly kind = 'local' as const;
  readonly sep = path.sep as '/' | '\\';

  async home(): Promise<string> {
    return homedir();
  }

  async list(p: string) {
    if (isWin && p === DRIVES_ROOT) {
      const entries: FileEntry[] = [];
      for (let c = 65; c <= 90; c++) {
        const d = `${String.fromCharCode(c)}:\\`;
        if (existsSync(d)) entries.push({ name: d, path: d, type: 'dir', targetIsDir: false, size: 0, mtime: 0, mode: null, owner: null, group: null });
      }
      return { path: DRIVES_ROOT, parent: null, entries };
    }
    const abs = path.resolve(p);
    let names: string[];
    try {
      names = await readdir(abs);
    } catch (err) {
      throw toFsError(err);
    }
    const entries = (await Promise.all(names.map((n) => toEntry(path.join(abs, n), n)))).filter((e): e is FileEntry => !!e);
    const parentDir = path.dirname(abs);
    const parent = parentDir !== abs ? parentDir : isWin ? DRIVES_ROOT : null;
    return { path: abs, parent, entries: sortEntries(entries) };
  }

  async stat(p: string) {
    try {
      const s = await stat(p);
      return {
        name: path.basename(p),
        path: p,
        type: s.isDirectory() ? ('dir' as const) : s.isFile() ? ('file' as const) : ('other' as const),
        targetIsDir: false,
        size: s.size,
        mtime: s.mtimeMs,
        mode: isWin ? null : s.mode & 0o7777,
        owner: null,
        group: null,
      };
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return null;
      throw toFsError(err);
    }
  }

  async mkdir(p: string) {
    try {
      await mkdir(p);
    } catch (err) {
      throw toFsError(err);
    }
  }

  async rename(from: string, to: string) {
    try {
      await rename(from, to);
    } catch (err) {
      throw toFsError(err);
    }
  }

  async remove(p: string) {
    try {
      await rm(p, { recursive: true, force: false });
    } catch (err) {
      throw toFsError(err);
    }
  }

  async chmod(p: string, mode: number) {
    try {
      await chmod(p, mode);
    } catch (err) {
      throw toFsError(err);
    }
  }

  createReadStream(p: string) {
    return createReadStream(p, { highWaterMark: 256 * 1024 });
  }

  createWriteStream(p: string, mode?: number) {
    return createWriteStream(p, { mode: mode ?? 0o644 });
  }

  join(dir: string, name: string) {
    return path.join(dir, name);
  }

  basename(p: string) {
    return path.basename(p);
  }

  close() {}
}
