const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  let i = 0;
  let v = n;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${UNITS[i]}`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function formatDate(ms: number): string {
  return ms > 0 ? dateFmt.format(new Date(ms)) : '';
}

/** 0o755 -> "rwxr-xr-x" */
export function modeString(mode: number | null): string {
  if (mode === null) return '';
  const bits = 'rwxrwxrwx';
  let out = '';
  for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? bits[i] : '-';
  return out;
}

export function octal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, '0');
}

/** Human-readable key algorithm, e.g. "ED25519", "RSA 4096". */
export function keyKind(type: string, bits: number): string {
  if (type === 'ssh-ed25519') return 'ED25519';
  if (type === 'ssh-rsa') return `RSA ${bits}`;
  return `ECDSA ${bits}`;
}
