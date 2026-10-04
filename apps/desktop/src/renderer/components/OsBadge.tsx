import { Cpu, Server } from 'lucide-react';

/**
 * Small OS indicator for host rows: an original monogram on a color, not a vendor logo (logos are
 * trademarks). Unknown OS falls back to a generic icon.
 */
const OS: Record<string, { label: string; bg: string; fg?: string }> = {
  ubuntu: { label: 'Ub', bg: '#e95420' },
  debian: { label: 'De', bg: '#a80030' },
  raspbian: { label: 'Rp', bg: '#c51a4a' },
  fedora: { label: 'Fe', bg: '#294172' },
  centos: { label: 'Ce', bg: '#932279' },
  rhel: { label: 'RH', bg: '#cc0000' },
  rocky: { label: 'Ro', bg: '#10b981' },
  almalinux: { label: 'Al', bg: '#0f4266' },
  oracle: { label: 'Or', bg: '#c74634' },
  amazon: { label: 'Am', bg: '#232f3e', fg: '#ff9900' },
  arch: { label: 'Ar', bg: '#1793d1' },
  manjaro: { label: 'Mj', bg: '#35bf5c' },
  alpine: { label: 'Ap', bg: '#0d597f' },
  opensuse: { label: 'oS', bg: '#73ba25' },
  suse: { label: 'SU', bg: '#30ba78' },
  nixos: { label: 'Nx', bg: '#5277c3' },
  gentoo: { label: 'Ge', bg: '#54487a' },
  kali: { label: 'Ka', bg: '#367bf0' },
  mint: { label: 'Mt', bg: '#87cf3e', fg: '#16301a' },
  popos: { label: 'Po', bg: '#48b9c7', fg: '#10292d' },
  void: { label: 'Vo', bg: '#478061' },
  linux: { label: 'Lx', bg: '#333a45' },
  macos: { label: 'Ma', bg: '#555b65' },
  freebsd: { label: 'FB', bg: '#ab2b28' },
  openbsd: { label: 'OB', bg: '#d6a700', fg: '#2a2000' },
  netbsd: { label: 'NB', bg: '#f26711' },
  solaris: { label: 'So', bg: '#2d5c8a' },
  windows: { label: 'Wi', bg: '#0067b8' },
};

export function OsBadge({ os, protocol }: { os: string | null; protocol: string }) {
  const known = os ? OS[os] : undefined;
  if (protocol === 'serial') {
    return (
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted" aria-hidden>
        <Cpu size={16} />
      </div>
    );
  }
  if (!known) {
    return (
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted" aria-hidden>
        <Server size={16} />
      </div>
    );
  }
  return (
    <div
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[11px] font-bold"
      style={{ background: known.bg, color: known.fg ?? '#fff' }}
      title={os ?? undefined}
      aria-label={os ?? undefined}
      data-testid="os-badge"
      data-os={os}
    >
      {known.label}
    </div>
  );
}
