/**
 * In-process SSH test server (ssh2): password + public-key auth, a fake shell, and a real SFTP
 * subsystem backed by a directory on disk. Used by unit and E2E tests — no Docker or sshd needed.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Server, utils, type Connection, type SFTPWrapper } from 'ssh2';

const { STATUS_CODE, flagsToString } = utils.sftp;

export interface TestSshServer {
  port: number;
  fingerprint: string;
  close(): Promise<void>;
}

export interface TestSshOptions {
  port?: number;
  /** Directory exposed over SFTP as "/". Defaults to no SFTP. */
  sftpRoot?: string;
  /** OpenSSH public key lines allowed for user "tester". */
  authorizedKeys?: string[];
  password?: string;
}

function statusFor(err: unknown): number {
  switch ((err as { code?: string }).code) {
    case 'ENOENT':
      return STATUS_CODE.NO_SUCH_FILE;
    case 'EACCES':
    case 'EPERM':
      return STATUS_CODE.PERMISSION_DENIED;
    default:
      return STATUS_CODE.FAILURE;
  }
}

function attrsOf(s: fs.Stats) {
  return { mode: s.mode, uid: s.uid, gid: s.gid, size: s.size, atime: Math.floor(s.atimeMs / 1000), mtime: Math.floor(s.mtimeMs / 1000) };
}

function serveSftp(sftp: SFTPWrapper, root: string): void {
  const real = (p: string) => path.posix.resolve('/', p || '.');
  const local = (p: string) => {
    const full = path.join(root, real(p));
    if (!full.startsWith(path.resolve(root))) throw Object.assign(new Error('escape'), { code: 'EACCES' });
    return full;
  };
  let next = 0;
  const handles = new Map<string, { fd?: number; dir?: string; listed?: boolean }>();
  const newHandle = (v: { fd?: number; dir?: string }) => {
    const h = Buffer.alloc(4);
    h.writeUInt32BE(next++);
    handles.set(h.toString('hex'), v);
    return h;
  };
  const get = (h: Buffer) => handles.get(h.toString('hex'));
  const safe = (reqid: number, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      sftp.status(reqid, statusFor(err));
    }
  };

  sftp.on('REALPATH', (reqid, p) => safe(reqid, () => sftp.name(reqid, [{ filename: real(p), longname: real(p), attrs: {} as never }])));
  sftp.on('STAT', (reqid, p) => safe(reqid, () => sftp.attrs(reqid, attrsOf(fs.statSync(local(p))))));
  sftp.on('LSTAT', (reqid, p) => safe(reqid, () => sftp.attrs(reqid, attrsOf(fs.lstatSync(local(p))))));
  sftp.on('FSTAT', (reqid, h) => safe(reqid, () => sftp.attrs(reqid, attrsOf(fs.fstatSync(get(h)!.fd!)))));
  sftp.on('OPENDIR', (reqid, p) =>
    safe(reqid, () => {
      if (!fs.statSync(local(p)).isDirectory()) throw Object.assign(new Error('not dir'), { code: 'ENOTDIR' });
      sftp.handle(reqid, newHandle({ dir: local(p) }));
    }),
  );
  sftp.on('READDIR', (reqid, h) =>
    safe(reqid, () => {
      const d = get(h);
      if (!d?.dir || d.listed) return sftp.status(reqid, STATUS_CODE.EOF);
      d.listed = true;
      const names = fs.readdirSync(d.dir).map((n) => {
        const s = fs.lstatSync(path.join(d.dir!, n));
        return { filename: n, longname: `-rw-r--r-- 1 tester users ${s.size} Jan 1 00:00 ${n}`, attrs: attrsOf(s) };
      });
      sftp.name(reqid, names);
    }),
  );
  sftp.on('OPEN', (reqid, filename, flags, attrs) =>
    safe(reqid, () => {
      const fd = fs.openSync(local(filename), flagsToString(flags) ?? 'r', attrs?.mode ?? 0o644);
      sftp.handle(reqid, newHandle({ fd }));
    }),
  );
  sftp.on('READ', (reqid, h, offset, length) =>
    safe(reqid, () => {
      const buf = Buffer.alloc(length);
      const n = fs.readSync(get(h)!.fd!, buf, 0, length, offset);
      if (n === 0) sftp.status(reqid, STATUS_CODE.EOF);
      else sftp.data(reqid, buf.subarray(0, n));
    }),
  );
  sftp.on('WRITE', (reqid, h, offset, data) =>
    safe(reqid, () => {
      fs.writeSync(get(h)!.fd!, data, 0, data.length, offset);
      sftp.status(reqid, STATUS_CODE.OK);
    }),
  );
  sftp.on('CLOSE', (reqid, h) =>
    safe(reqid, () => {
      const v = get(h);
      if (v?.fd !== undefined) fs.closeSync(v.fd);
      handles.delete(h.toString('hex'));
      sftp.status(reqid, STATUS_CODE.OK);
    }),
  );
  const ok = (reqid: number, fn: () => void) => safe(reqid, () => (fn(), sftp.status(reqid, STATUS_CODE.OK)));
  sftp.on('MKDIR', (reqid, p) => ok(reqid, () => fs.mkdirSync(local(p))));
  sftp.on('RMDIR', (reqid, p) => ok(reqid, () => fs.rmdirSync(local(p))));
  sftp.on('REMOVE', (reqid, p) => ok(reqid, () => fs.unlinkSync(local(p))));
  sftp.on('RENAME', (reqid, a, b) => ok(reqid, () => fs.renameSync(local(a), local(b))));
  sftp.on('SETSTAT', (reqid, p, attrs) => ok(reqid, () => attrs.mode !== undefined && fs.chmodSync(local(p), attrs.mode)));
  sftp.on('FSETSTAT', (reqid, h, attrs) => ok(reqid, () => attrs.mode !== undefined && fs.fchmodSync(get(h)!.fd!, attrs.mode)));
}

export async function startSshServer(opts: TestSshOptions = {}): Promise<TestSshServer> {
  const password = opts.password ?? 'secret';
  const key = utils.generateKeyPairSync('ed25519');
  const parsed = utils.parseKey(key.public);
  if (parsed instanceof Error) throw parsed;
  const pubBlob = (Array.isArray(parsed) ? parsed[0]! : parsed).getPublicSSH();
  const fingerprint = `SHA256:${createHash('sha256').update(pubBlob).digest('base64').replace(/=+$/, '')}`;
  const authorized = (opts.authorizedKeys ?? []).map((line) => {
    const k = utils.parseKey(line);
    if (k instanceof Error) throw k;
    return Array.isArray(k) ? k[0]! : k;
  });

  const clients = new Set<Connection>();
  const server = new Server({ hostKeys: [key.private] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      if (ctx.username !== 'tester') return ctx.reject();
      if (ctx.method === 'password' && ctx.password === password) return ctx.accept();
      if (ctx.method === 'publickey') {
        const match = authorized.find((k) => k.getPublicSSH().equals(ctx.key.data));
        if (match && (!ctx.signature || match.verify(ctx.blob!, ctx.signature, ctx.hashAlgo))) return ctx.accept();
      }
      ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acc) => acc?.());
        session.on('window-change', (acc) => acc?.());
        session.on('sftp', (acc) => {
          if (!opts.sftpRoot) return;
          serveSftp(acc(), opts.sftpRoot);
        });
        session.on('shell', (acc) => {
          const stream = acc();
          stream.write('Welcome to cy-test\r\n$ ');
          let line = '';
          stream.on('data', (d: Buffer) => {
            for (const ch of d.toString('utf8')) {
              if (ch === '\r' || ch === '\n') {
                stream.write('\r\n');
                const cmd = line.trim();
                line = '';
                if (cmd === 'exit') {
                  stream.exit(0);
                  stream.end();
                  return;
                }
                if (cmd.startsWith('echo ')) stream.write(`${cmd.slice(5)}\r\n`);
                stream.write('$ ');
              } else if (ch === '\x7f') {
                line = line.slice(0, -1);
                stream.write('\b \b');
              } else {
                line += ch;
                stream.write(ch);
              }
            }
          });
        });
      });
    });
  });

  await new Promise<void>((res) => server.listen(opts.port ?? 0, '127.0.0.1', () => res()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    fingerprint,
    close: () =>
      new Promise<void>((res) => {
        // server.close() waits for open connections, so drop them first.
        for (const c of clients) c.end();
        server.close(() => res());
      }),
  };
}
