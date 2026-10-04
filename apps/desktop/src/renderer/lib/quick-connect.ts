export interface QuickTarget {
  host: string;
  port: number;
  username: string;
}

/**
 * Parses what people type to connect: "host", "user@host", "host:2222", "user@host:2222",
 * "ssh user@host -p 2222", "[2001:db8::1]:22" or a bare IPv6 address. Returns null if it isn't one.
 */
export function parseQuickTarget(input: string): QuickTarget | null {
  let s = input.trim();
  let port: number | null = null;
  // Pasted commands: "ssh [-p port] [user@]host" (other options are ignored).
  if (/^ssh\s/.test(s)) {
    const parts = s.split(/\s+/).slice(1);
    let target = '';
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (p === '-p' && parts[i + 1]) port = Number(parts[++i]);
      else if (/^-[46AaCfGgKkMNnqsTtVvXxYy]+$/.test(p)) continue;
      else if (p.startsWith('-')) i++; // an option with a value we don't use
      else if (!target) target = p;
    }
    s = target;
  }
  if (s.startsWith('ssh://')) s = s.slice(6).replace(/\/.*$/, '');
  if (!s || /\s/.test(s)) return null;

  let username = '';
  const at = s.lastIndexOf('@');
  if (at >= 0) {
    username = s.slice(0, at);
    s = s.slice(at + 1);
  }
  let host = s;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (bracketed) {
    host = bracketed[1]!;
    if (bracketed[2]) port = Number(bracketed[2]);
  } else if ((s.match(/:/g) ?? []).length === 1) {
    const [h, p] = s.split(':');
    host = h!;
    if (!/^\d+$/.test(p ?? '')) return null;
    port = Number(p);
  }
  if (!host || !/^[\w.\-:%]+$/.test(host)) return null;
  const finalPort = port ?? 22;
  if (!Number.isInteger(finalPort) || finalPort < 1 || finalPort > 65535) return null;
  return { host, port: finalPort, username };
}
