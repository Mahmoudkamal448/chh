import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  resolveSettings,
  type SshImportCandidate,
  type SshImportPreview,
  type SshImportResult,
} from '@chh/shared';
import { importCandidates, parseSshConfig, writeSshConfig, type ExportHost, type ImportCandidate } from '@chh/ssh-config';
import type { ForwardsRepo } from './db/forwards-repo';
import type { GroupsRepo } from './db/groups-repo';
import type { HostsRepo } from './db/hosts-repo';
import type { IdentitiesRepo } from './db/identities-repo';
import type { KeysRepo } from './db/keys-repo';
import { AppError } from './ipc/handle';

const MAX_FILE = 1024 * 1024;
const MAX_INCLUDED_FILES = 256;
const STAGE_TTL_MS = 15 * 60 * 1000;

export const defaultSshConfigPath = () => join(homedir(), '.ssh', 'config');

function globToRe(seg: string): RegExp {
  return new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

/** Expands a path whose segments may contain * and ? (as OpenSSH's Include does). */
export function expandGlob(pattern: string): string[] {
  const parts = pattern.split(/[\\/]+/);
  let bases = [pattern.startsWith('/') ? '/' : parts.shift()!];
  if (pattern.startsWith('/')) parts.shift();
  for (const seg of parts) {
    const next: string[] = [];
    for (const base of bases) {
      if (!/[*?]/.test(seg)) {
        next.push(join(base, seg));
        continue;
      }
      try {
        const re = globToRe(seg);
        for (const name of readdirSync(base).sort()) if (re.test(name)) next.push(join(base, name));
      } catch {
        // unreadable directory
      }
    }
    bases = next;
    if (bases.length > MAX_INCLUDED_FILES) bases = bases.slice(0, MAX_INCLUDED_FILES);
  }
  return bases.filter((p) => existsSync(p) && statSync(p).isFile());
}

function readLimited(path: string): string {
  if (statSync(path).size > MAX_FILE) throw new Error('file too large');
  return readFileSync(path, 'utf8');
}

function loadConfig(path: string) {
  const sshDir = join(homedir(), '.ssh');
  let included = 0;
  return parseSshConfig(readLimited(path), {
    file: path,
    include: (pattern) => {
      let p = pattern.startsWith('~/') ? join(homedir(), pattern.slice(2)) : pattern;
      // Relative Includes in a user config are relative to ~/.ssh (ssh_config(5)).
      if (!isAbsolute(p)) p = join(path === defaultSshConfigPath() ? sshDir : dirname(path), p);
      return expandGlob(p).map((f) => {
        if (++included > MAX_INCLUDED_FILES) throw new Error('too many included files');
        return { path: f, text: readLimited(f) };
      });
    },
  });
}

interface Deps {
  hosts: HostsRepo;
  groups: GroupsRepo;
  keys: KeysRepo;
  identities: IdentitiesRepo;
  forwards: ForwardsRepo;
}

/** ssh_config import/export. Previews are staged in memory so the renderer never sends paths back. */
export class SshConfigIO {
  private readonly staged = new Map<string, { path: string; candidates: ImportCandidate[]; expires: number }>();

  constructor(private readonly d: Deps) {}

  preview(path: string): SshImportPreview {
    if (!existsSync(path)) throw new AppError('not_found', 'sshConfig.error.notFound');
    let parsed;
    try {
      parsed = loadConfig(path);
    } catch {
      throw new AppError('unreadable', 'sshConfig.error.unreadable');
    }
    const candidates = importCandidates(parsed, { home: homedir(), localUser: safeUser() });
    const existing = new Set(this.d.hosts.list({}).items.map((h) => `${h.label}\n${h.address}`.toLowerCase()));
    const now = Date.now();
    for (const [k, v] of this.staged) if (v.expires < now) this.staged.delete(k);
    const token = randomUUID();
    this.staged.set(token, { path, candidates, expires: now + STAGE_TTL_MS });
    return {
      token,
      path,
      candidates: candidates.map((c): SshImportCandidate => ({ ...c, exists: existing.has(`${c.alias}\n${c.hostName}`.toLowerCase()) })),
      warnings: parsed.warnings.map((w) => `${w.file}:${w.line}: ${w.message}`),
    };
  }

  async import(opts: { token: string; aliases: string[]; groupLabel?: string; importKeys: boolean; importForwards: boolean }): Promise<SshImportResult> {
    const stage = this.staged.get(opts.token);
    if (!stage) throw new AppError('expired', 'sshConfig.error.expired');
    const wanted = new Set(opts.aliases);
    const chosen = stage.candidates.filter((c) => wanted.has(c.alias));
    const result: SshImportResult = { hosts: 0, keys: 0, forwards: 0, skippedKeys: [] };
    const keyByPath = new Map<string, string | null>();

    const importKey = async (path: string, certificateFiles: string[]): Promise<string | null> => {
      if (keyByPath.has(path)) return keyByPath.get(path)!;
      let id: string | null = null;
      try {
        if (!existsSync(path)) result.skippedKeys.push({ path, reason: 'missing' });
        else {
          // Like OpenSSH: CertificateFile entries, then "<key>-cert.pub"; the one that certifies this key is attached.
          const certificates = [...certificateFiles, `${path}-cert.pub`].filter((f) => existsSync(f)).map((f) => readLimited(f));
          const res = await this.d.keys.importText(readLimited(path), path.split(/[\\/]/).pop(), undefined, certificates);
          if (res.status === 'imported') {
            id = res.key.id;
            result.keys++;
          } else if (res.status === 'duplicate') id = res.existing.id;
          else result.skippedKeys.push({ path, reason: 'encrypted' });
        }
      } catch {
        result.skippedKeys.push({ path, reason: 'unsupported' });
      }
      keyByPath.set(path, id);
      return id;
    };

    const groupId = opts.groupLabel ? this.d.groups.create({ label: opts.groupLabel }).id : null;
    for (const c of chosen) {
      let keyId: string | null = null;
      if (opts.importKeys) {
        for (const f of c.identityFiles) {
          const id = await importKey(f, c.certificateFiles);
          keyId ??= id;
        }
      }
      const notes = [
        `Imported from ${stage.path}`,
        c.proxyJump ? `ProxyJump: ${c.proxyJump}` : null,
        c.forwardAgent ? 'ForwardAgent: yes' : null,
        c.unsupported.length ? `Other options not imported: ${c.unsupported.join(', ')}` : null,
      ].filter(Boolean);
      const host = this.d.hosts.create({
        label: c.alias,
        address: c.hostName,
        groupId,
        notes: notes.join('\n'),
        settings: {
          ...(c.user ? { username: c.user } : {}),
          ...(c.port ? { port: c.port } : {}),
          ...(keyId ? { keyId } : {}),
        },
      });
      result.hosts++;
      if (opts.importForwards) {
        for (const f of c.forwards) {
          this.d.forwards.create({
            label: `${c.alias}: ${f.kind === 'dynamic' ? 'SOCKS' : f.kind} ${f.bindPort}`,
            hostId: host.id,
            kind: f.kind,
            bindHost: f.bindHost,
            bindPort: f.bindPort,
            destHost: f.destHost,
            destPort: f.destPort,
          });
          result.forwards++;
        }
      }
    }
    this.staged.delete(opts.token);
    return result;
  }

  exportText(hostIds?: string[]): string {
    const groups = this.d.groups.map();
    const all = this.d.hosts.list({}).items;
    const hosts = hostIds ? all.filter((h) => hostIds.includes(h.id)) : all;
    const forwards = this.d.forwards.list();
    const keyLabel = (id: string | null) => (id ? this.d.keys.list().find((k) => k.id === id)?.label : undefined);
    const out: ExportHost[] = [];
    for (const h of hosts) {
      if (h.protocol === 'telnet') continue;
      const s = resolveSettings(h.groupId, h.settings, groups);
      const identity = s.identityId ? this.d.identities.list().find((i) => i.id === s.identityId) : undefined;
      const key = keyLabel(s.keyId ?? identity?.keyId ?? null);
      out.push({
        alias: h.label,
        hostName: h.address,
        port: s.port,
        user: s.username || identity?.username || undefined,
        forwards: forwards.filter((f) => f.hostId === h.id),
        comment: key ? `Key "${key}" is stored in chh (export it from Keys to use with OpenSSH)` : undefined,
      });
    }
    return writeSshConfig(out, `Exported by chh on ${new Date().toISOString().slice(0, 10)}`);
  }
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'user';
  }
}
