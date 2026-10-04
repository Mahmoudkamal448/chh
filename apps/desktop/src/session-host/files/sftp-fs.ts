import path from 'node:path/posix';
import type { Client, SFTPWrapper, Stats } from 'ssh2';
import type { FileEntry } from '@chh/shared';
import { sortEntries, toFsError, typeFromMode, type FsProvider } from './provider';

const S_IFDIR = 0o040000;

function p<T>(fn: (cb: (err: Error | null | undefined, v?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, v) => (err ? reject(toFsError(err)) : resolve(v as T))));
}

/** SFTP filesystem over an authenticated ssh2 client. Paths are POSIX. */
export class SftpFs implements FsProvider {
  readonly kind = 'sftp' as const;
  readonly sep = '/' as const;

  private constructor(
    private readonly client: Client,
    private readonly sftp: SFTPWrapper,
  ) {}

  static open(client: Client): Promise<SftpFs> {
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => (err ? reject(err) : resolve(new SftpFs(client, sftp))));
    });
  }

  home(): Promise<string> {
    return p<string>((cb) => this.sftp.realpath('.', cb));
  }

  private entryFrom(dir: string, name: string, attrs: Stats, longname?: string): FileEntry {
    const parts = longname?.split(/\s+/);
    return {
      name,
      path: path.join(dir, name),
      type: typeFromMode(attrs.mode),
      targetIsDir: false,
      size: typeFromMode(attrs.mode) === 'dir' ? 0 : attrs.size,
      mtime: attrs.mtime * 1000,
      mode: attrs.mode & 0o7777,
      // ls -l style longname: perms links owner group size ... (owner/group names when the server provides them)
      owner: parts && parts.length > 3 ? parts[2]! : String(attrs.uid),
      group: parts && parts.length > 3 ? parts[3]! : String(attrs.gid),
    };
  }

  async list(dirPath: string) {
    const abs = await p<string>((cb) => this.sftp.realpath(dirPath || '.', cb));
    const raw = await p<Array<{ filename: string; longname: string; attrs: Stats }>>((cb) => this.sftp.readdir(abs, cb));
    const entries = await Promise.all(
      raw
        .filter((r) => r.filename !== '.' && r.filename !== '..')
        .map(async (r) => {
          const e = this.entryFrom(abs, r.filename, r.attrs, r.longname);
          if (e.type === 'symlink') {
            try {
              const target = await p<Stats>((cb) => this.sftp.stat(e.path, cb));
              e.targetIsDir = (target.mode & 0o170000) === S_IFDIR;
              if (!e.targetIsDir) e.size = target.size;
            } catch {
              // dangling link
            }
          }
          return e;
        }),
    );
    const parent = abs === '/' ? null : path.dirname(abs);
    return { path: abs, parent, entries: sortEntries(entries) };
  }

  async stat(filePath: string) {
    try {
      const s = await p<Stats>((cb) => this.sftp.stat(filePath, cb));
      return this.entryFrom(path.dirname(filePath), path.basename(filePath), s);
    } catch (err) {
      if ((err as { code?: string }).code === 'not_found') return null;
      throw err;
    }
  }

  async mkdir(dir: string) {
    await p<void>((cb) => this.sftp.mkdir(dir, cb));
  }

  async rename(from: string, to: string) {
    await p<void>((cb) => this.sftp.rename(from, to, cb));
  }

  async remove(target: string) {
    const s = await p<Stats>((cb) => this.sftp.lstat(target, cb));
    if ((s.mode & 0o170000) !== S_IFDIR) {
      await p<void>((cb) => this.sftp.unlink(target, cb));
      return;
    }
    const children = await p<Array<{ filename: string }>>((cb) => this.sftp.readdir(target, cb));
    for (const c of children) {
      if (c.filename === '.' || c.filename === '..') continue;
      await this.remove(path.join(target, c.filename));
    }
    await p<void>((cb) => this.sftp.rmdir(target, cb));
  }

  async chmod(target: string, mode: number) {
    await p<void>((cb) => this.sftp.chmod(target, mode, cb));
  }

  createReadStream(filePath: string) {
    return this.sftp.createReadStream(filePath, { highWaterMark: 64 * 1024 });
  }

  createWriteStream(filePath: string, mode?: number) {
    return this.sftp.createWriteStream(filePath, { mode: mode ?? 0o644 });
  }

  join(dir: string, name: string) {
    return path.join(dir, name);
  }

  basename(filePath: string) {
    return path.basename(filePath);
  }

  close() {
    this.sftp.end();
    this.client.end();
  }
}
