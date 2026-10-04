import type { Readable, Writable } from 'node:stream';
import type { FileEntry } from '@cy-ssh/shared';

export class FsError extends Error {
  constructor(
    /** i18n key under "files.error.*" */
    readonly code: 'not_found' | 'exists' | 'permission' | 'not_empty' | 'not_dir' | 'is_dir' | 'generic',
    message: string,
  ) {
    super(message);
  }
}

/** A filesystem the file browser and transfers can work with: the local disk or an SFTP session. */
export interface FsProvider {
  readonly kind: 'local' | 'sftp';
  readonly sep: '/' | '\\';
  home(): Promise<string>;
  list(path: string): Promise<{ path: string; parent: string | null; entries: FileEntry[] }>;
  /** Follows symlinks. Returns null if it doesn't exist. */
  stat(path: string): Promise<FileEntry | null>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Deletes a file, or a directory recursively. */
  remove(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  createReadStream(path: string): Readable;
  createWriteStream(path: string, mode?: number): Writable;
  join(dir: string, name: string): string;
  basename(path: string): string;
  close(): void;
}

/** Maps Node/SFTP error codes to FsError. */
export function toFsError(err: unknown): FsError {
  if (err instanceof FsError) return err;
  const e = err as { code?: string | number; message?: string };
  const msg = e?.message ?? String(err);
  switch (e?.code) {
    case 'ENOENT':
    case 2: // SFTP NO_SUCH_FILE
      return new FsError('not_found', msg);
    case 'EEXIST':
      return new FsError('exists', msg);
    case 'EACCES':
    case 'EPERM':
    case 3: // SFTP PERMISSION_DENIED
      return new FsError('permission', msg);
    case 'ENOTEMPTY':
      return new FsError('not_empty', msg);
    case 'ENOTDIR':
      return new FsError('not_dir', msg);
    case 'EISDIR':
      return new FsError('is_dir', msg);
  }
  return new FsError('generic', msg);
}

export const S_IFMT = 0o170000;
export const S_IFDIR = 0o040000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;

export function typeFromMode(mode: number): FileEntry['type'] {
  switch (mode & S_IFMT) {
    case S_IFDIR:
      return 'dir';
    case S_IFREG:
      return 'file';
    case S_IFLNK:
      return 'symlink';
    default:
      return 'other';
  }
}

export function sortEntries(entries: FileEntry[]): FileEntry[] {
  const isDir = (e: FileEntry) => e.type === 'dir' || (e.type === 'symlink' && e.targetIsDir);
  return entries.sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}
