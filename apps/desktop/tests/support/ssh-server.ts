/**
 * In-process SSH test server (ssh2): password + public-key auth, a fake shell, and a real SFTP
 * subsystem backed by a directory on disk. Used by unit and E2E tests — no Docker or sshd needed.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { connect, createServer, type Server as NetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Server, utils, type Connection, type SFTPWrapper } from 'ssh2';

const { STATUS_CODE, flagsToString } = utils.sftp;

export interface TestSshServer {
  port: number;
  fingerprint: string;
  close(): Promise<void>;
  /** Environment variables received via SSH env requests (last session). */
  env: Record<string, string>;
  /** Whether the last session asked for agent forwarding. */
  agentForwardRequested(): boolean;
}

export interface TestSshOptions {
  port?: number;
  /** Directory exposed over SFTP as "/". Defaults to no SFTP. */
  sftpRoot?: string;
  /** OpenSSH public key lines allowed for user "tester". */
  authorizedKeys?: string[];
  password?: string;
  /** Allow `exec` of mosh-server (spawned locally) so Mosh can be tested end to end. */
  allowMosh?: boolean;
  /** Content returned for the OS probe (`cat /etc/os-release; uname -s`). */
  osRelease?: string;
  /** Scripted `exec` results for other commands. */
  exec?: (command: string) => { stdout?: string; stderr?: string; code?: number; delayMs?: number };
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
  // ssh2 drops a leading zero byte from about 1 in 256 ed25519 keys it generates, and then can't parse them.
  let key: ReturnType<typeof utils.generateKeyPairSync>;
  let parsed: ReturnType<typeof utils.parseKey>;
  do {
    key = utils.generateKeyPairSync('ed25519');
    parsed = utils.parseKey(key.public);
  } while (parsed instanceof Error || utils.parseKey(key.private) instanceof Error);
  const pubBlob = (Array.isArray(parsed) ? parsed[0]! : parsed).getPublicSSH();
  const fingerprint = `SHA256:${createHash('sha256').update(pubBlob).digest('base64').replace(/=+$/, '')}`;
  const authorized = (opts.authorizedKeys ?? []).map((line) => {
    const k = utils.parseKey(line);
    if (k instanceof Error) throw k;
    return Array.isArray(k) ? k[0]! : k;
  });

  const clients = new Set<Connection>();
  let port = 0;
  const env: Record<string, string> = {};
  let agentRequested = false;
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
    const listeners: NetServer[] = [];
    client.on('close', () => listeners.forEach((l) => l.close()));
    client.on('ready', () => {
      // ssh -L / -D: connect to the requested target and splice.
      client.on('tcpip', (accept, reject, info) => {
        const sock = connect(info.destPort, info.destIP);
        sock.once('connect', () => {
          const ch = accept();
          sock.pipe(ch).pipe(sock);
          ch.on('close', () => sock.destroy());
          sock.on('close', () => ch.destroy());
        });
        sock.once('error', () => reject());
      });
      // ssh -R: listen here and send connections back over the SSH connection.
      client.on('request', (accept, reject, name, info) => {
        if (name !== 'tcpip-forward' || !accept) return reject?.();
        const fwd = info as { bindAddr: string; bindPort: number };
        const srv = createServer((sock) => {
          client.forwardOut(fwd.bindAddr, fwd.bindPort, sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, (err, ch) => {
            if (err) return sock.destroy();
            sock.pipe(ch).pipe(sock);
            ch.on('close', () => sock.destroy());
          });
        });
        srv.on('error', () => reject?.());
        srv.listen(fwd.bindPort, fwd.bindAddr, () => {
          listeners.push(srv);
          accept((srv.address() as AddressInfo).port);
        });
      });
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acc) => acc?.());
        session.on('env', (acc, _rej, info) => {
          env[info.key] = info.val;
          acc?.();
        });
        session.on('auth-agent', (acc) => {
          agentRequested = true;
          acc?.();
        });
        session.on('window-change', (acc) => acc?.());
        session.on('exec', (acc, rej, info) => {
          if (info.command.startsWith('cat /etc/os-release')) {
            const stream = acc();
            stream.write(opts.osRelease ?? 'Linux\n');
            stream.exit(0);
            stream.end();
            return;
          }
          if (opts.exec) {
            const r = opts.exec(info.command);
            const stream = acc();
            setTimeout(() => {
              if (r.stdout) stream.write(r.stdout);
              if (r.stderr) stream.stderr.write(r.stderr);
              stream.exit(r.code ?? 0);
              stream.end();
            }, r.delayMs ?? 0);
            return;
          }
          // Only mosh-server bootstrap is supported, and only when explicitly enabled.
          if (!opts.allowMosh || !/^'mosh-server' new /.test(info.command)) return rej?.();
          const stream = acc();
          const child = spawn('sh', ['-c', info.command], {
            env: { ...process.env, SSH_CONNECTION: `127.0.0.1 50000 127.0.0.1 ${port}` },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          child.stdout.on('data', (d) => stream.write(d));
          child.stderr.on('data', (d) => stream.stderr.write(d));
          child.on('exit', (code) => {
            stream.exit(code ?? 0);
            stream.end();
          });
        });
        session.on('sftp', (acc) => {
          if (!opts.sftpRoot) return;
          serveSftp(acc(), opts.sftpRoot);
        });
        session.on('shell', (acc) => {
          const stream = acc();
          stream.write('Welcome to chh-test\r\n$ ');
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

  // Track raw sockets so close() can't hang on half-open connections.
  const rawSockets = new Set<import('node:net').Socket>();
  (server as unknown as { _srv: import('node:net').Server })._srv.on('connection', (sock) => {
    rawSockets.add(sock);
    sock.on('close', () => rawSockets.delete(sock));
  });
  await new Promise<void>((res) => server.listen(opts.port ?? 0, '127.0.0.1', () => res()));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    fingerprint,
    env,
    agentForwardRequested: () => agentRequested,
    close: () =>
      new Promise<void>((res) => {
        // server.close() waits for open connections, so drop them first.
        for (const c of clients) c.end();
        for (const sock of rawSockets) sock.destroy();
        server.close(() => res());
      }),
  };
}
