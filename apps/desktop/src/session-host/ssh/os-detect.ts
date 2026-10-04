import type { Client } from 'ssh2';

/** Known distribution ids from /etc/os-release (ID=) mapped to our os hints. */
const OS_IDS: Record<string, string> = {
  ubuntu: 'ubuntu',
  debian: 'debian',
  raspbian: 'raspbian',
  fedora: 'fedora',
  centos: 'centos',
  rhel: 'rhel',
  rocky: 'rocky',
  almalinux: 'almalinux',
  ol: 'oracle',
  amzn: 'amazon',
  arch: 'arch',
  manjaro: 'manjaro',
  alpine: 'alpine',
  opensuse: 'opensuse',
  'opensuse-leap': 'opensuse',
  'opensuse-tumbleweed': 'opensuse',
  sles: 'suse',
  nixos: 'nixos',
  gentoo: 'gentoo',
  kali: 'kali',
  linuxmint: 'mint',
  pop: 'popos',
  void: 'void',
};

/** Turns `cat /etc/os-release; uname -s` output into an os hint ("ubuntu", "macos", "freebsd", "linux"…). */
export function parseOs(output: string): string | null {
  const id = /^ID="?([A-Za-z0-9._-]+)"?\s*$/m.exec(output)?.[1]?.toLowerCase();
  if (id) return OS_IDS[id] ?? 'linux';
  const uname = output.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  if (/^Darwin$/i.test(uname)) return 'macos';
  if (/^FreeBSD$/i.test(uname)) return 'freebsd';
  if (/^OpenBSD$/i.test(uname)) return 'openbsd';
  if (/^NetBSD$/i.test(uname)) return 'netbsd';
  if (/^SunOS$/i.test(uname)) return 'solaris';
  if (/^Linux$/i.test(uname)) return 'linux';
  if (/MINGW|MSYS|CYGWIN|Windows/i.test(uname)) return 'windows';
  return null;
}

/** Runs a tiny, read-only probe on a separate channel. Never throws; null if unknown. */
export function detectOs(client: Client): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10_000);
    try {
      client.exec('cat /etc/os-release 2>/dev/null; uname -s 2>/dev/null', (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return resolve(null);
        }
        let out = '';
        stream.on('data', (d: Buffer) => {
          if (out.length < 16_384) out += d.toString('utf8');
        });
        stream.stderr.resume();
        stream.on('close', () => {
          clearTimeout(timer);
          resolve(parseOs(out));
        });
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}
