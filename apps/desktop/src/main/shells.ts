import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { LocalShell } from '@chh/shared';

function which(cmd: string): string | null {
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const p = join(d, cmd + e);
      if (d && existsSync(p)) return p;
    }
  }
  return null;
}

/** Shells available on this machine, default first. */
export function detectShells(): LocalShell[] {
  if (process.platform === 'win32') {
    const out: LocalShell[] = [];
    const pwsh = which('pwsh');
    if (pwsh) out.push({ id: 'pwsh', label: 'PowerShell 7', path: pwsh, args: ['-NoLogo'] });
    const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const winps = join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (existsSync(winps)) out.push({ id: 'powershell', label: 'Windows PowerShell', path: winps, args: ['-NoLogo'] });
    const cmd = process.env.ComSpec ?? join(sysRoot, 'System32', 'cmd.exe');
    out.push({ id: 'cmd', label: 'Command Prompt', path: cmd, args: [] });
    const wsl = join(sysRoot, 'System32', 'wsl.exe');
    if (existsSync(wsl)) out.push({ id: 'wsl', label: 'WSL', path: wsl, args: [] });
    const gitBash = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
    if (existsSync(gitBash)) out.push({ id: 'git-bash', label: 'Git Bash', path: gitBash, args: ['--login', '-i'] });
    return out;
  }

  const candidates = new Set<string>();
  if (process.env.SHELL) candidates.add(process.env.SHELL);
  try {
    for (const line of readFileSync('/etc/shells', 'utf8').split('\n')) {
      const p = line.trim();
      if (p && !p.startsWith('#')) candidates.add(p);
    }
  } catch {
    // no /etc/shells
  }
  for (const p of ['/bin/zsh', '/bin/bash', '/usr/bin/fish', '/bin/sh']) candidates.add(p);

  const out: LocalShell[] = [];
  const seenNames = new Set<string>();
  for (const p of candidates) {
    const name = basename(p);
    if (!existsSync(p) || seenNames.has(name) || ['nologin', 'false', 'git-shell', 'rbash'].includes(name)) continue;
    seenNames.add(name);
    // macOS terminals start login shells so /etc/zprofile (path_helper) runs.
    out.push({ id: name, label: name, path: p, args: process.platform === 'darwin' ? ['-l'] : [] });
  }
  return out;
}

export interface MoshClient {
  path: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Locates mosh-client: on PATH (macOS/Linux, incl. Homebrew), or inside WSL on Windows, where no
 * maintained native build exists.
 */
export function detectMoshClient(): MoshClient | null {
  if (process.platform === 'win32') {
    const wsl = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
    if (!existsSync(wsl)) return null;
    try {
      execFileSync(wsl, ['-e', 'sh', '-c', 'command -v mosh-client'], { stdio: 'ignore', timeout: 5000 });
    } catch {
      return null;
    }
    // WSLENV forwards MOSH_KEY into the Linux side.
    return { path: wsl, args: ['-e', 'mosh-client'], env: { WSLENV: 'MOSH_KEY/u' } };
  }
  const extra = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [];
  for (const dir of extra) if (existsSync(join(dir, 'mosh-client'))) return { path: join(dir, 'mosh-client'), args: [], env: {} };
  const found = which('mosh-client');
  return found ? { path: found, args: [], env: {} } : null;
}

/** The system OpenSSH client (for the "System OpenSSH" engine: FIDO2 keys, post-quantum KEX). */
export function detectOpenSsh(): string | null {
  if (process.platform === 'win32') {
    const builtin = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
    if (existsSync(builtin)) return builtin;
  }
  return which('ssh');
}
