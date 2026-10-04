import { createHmac, timingSafeEqual } from 'node:crypto';
import { isKeyType, type KeyType } from './types';

export interface KnownHostEntry {
  marker: '@cert-authority' | '@revoked' | null;
  /** Plain patterns ("host", "[host]:2222", "*.example.com", "!bad") or a single hashed entry. */
  patterns: string[];
  hashed: { salt: Buffer; hash: Buffer } | null;
  keyType: KeyType;
  publicKey: string;
  comment: string;
}

/** Parses an OpenSSH known_hosts file, skipping comments, blank lines and unsupported key types. */
export function parseKnownHosts(text: string): KnownHostEntry[] {
  const out: KnownHostEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    let marker: KnownHostEntry['marker'] = null;
    if (parts[0] === '@cert-authority' || parts[0] === '@revoked') marker = parts.shift() as KnownHostEntry['marker'];
    const [hosts, keyType, publicKey, ...comment] = parts;
    if (!hosts || !keyType || !publicKey || !isKeyType(keyType)) continue;
    let hashed: KnownHostEntry['hashed'] = null;
    let patterns: string[] = [];
    const hm = /^\|1\|([^|]+)\|([^|]+)$/.exec(hosts);
    if (hm) hashed = { salt: Buffer.from(hm[1]!, 'base64'), hash: Buffer.from(hm[2]!, 'base64') };
    else patterns = hosts.split(',');
    out.push({ marker, patterns, hashed, keyType, publicKey, comment: comment.join(' ') });
  }
  return out;
}

/** The host string OpenSSH uses: "host" for port 22, "[host]:port" otherwise. */
export function hostKeyName(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return re.test(value);
}

/** Does this entry apply to `name` (as produced by hostKeyName)? Negated patterns win. */
export function entryMatches(e: KnownHostEntry, name: string): boolean {
  if (e.hashed) {
    const h = createHmac('sha1', e.hashed.salt).update(name).digest();
    return h.length === e.hashed.hash.length && timingSafeEqual(h, e.hashed.hash);
  }
  let matched = false;
  for (const p of e.patterns) {
    if (p.startsWith('!')) {
      if (globMatch(p.slice(1), name)) return false;
    } else if (globMatch(p, name)) matched = true;
  }
  return matched;
}

/** Hashes a host name the way `ssh-keygen -H` does. */
export function hashHostName(name: string, salt: Buffer): string {
  return `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(name).digest('base64')}`;
}
