import type { ConfigBlock, ConfigEntry, ParsedConfig } from './parse';

/** Keywords whose every occurrence applies (instead of first-obtained-value-wins). */
const MULTI = new Set(['identityfile', 'certificatefile', 'localforward', 'remoteforward', 'dynamicforward', 'sendenv', 'setenv']);

function globToRegExp(glob: string): RegExp {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`, 'i');
}

/** ssh_config pattern list: comma-separated, `!` negates; a negated match vetoes the block. */
export function matchPatternList(patterns: string[], name: string): boolean {
  let matched = false;
  for (const p of patterns.flatMap((x) => x.split(','))) {
    if (!p) continue;
    if (p.startsWith('!')) {
      if (globToRegExp(p.slice(1)).test(name)) return false;
    } else if (globToRegExp(p).test(name)) matched = true;
  }
  return matched;
}

/** Evaluates simple Match criteria; returns null when it can't be evaluated statically. */
function matchCriteria(tokens: string[], alias: string, hostName: string | undefined, user: string | undefined): boolean | null {
  let ok = true;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!.toLowerCase();
    if (t === 'all') continue;
    const negate = t.startsWith('!');
    const crit = negate ? t.slice(1) : t;
    const arg = tokens[i + 1];
    let res: boolean;
    switch (crit) {
      case 'host':
        res = !!arg && matchPatternList([arg], hostName ?? alias);
        i++;
        break;
      case 'originalhost':
        res = !!arg && matchPatternList([arg], alias);
        i++;
        break;
      case 'user':
        res = !!arg && !!user && matchPatternList([arg], user);
        i++;
        break;
      default:
        return null; // exec, localuser, canonical, final, … can't be decided at import time
    }
    ok &&= negate ? !res : res;
  }
  return ok;
}

export interface ResolvedHost {
  alias: string;
  /** keyword -> args of the first occurrence (or all occurrences for multi-valued keywords). */
  options: Map<string, string[][]>;
  /** Blocks we couldn't evaluate (e.g. Match exec) and skipped. */
  skippedMatches: number;
}

/** Computes the effective options for `alias`, exactly as `ssh -G alias` would (minus Match exec etc.). */
export function resolveHost(config: ParsedConfig, alias: string): ResolvedHost {
  const options = new Map<string, string[][]>();
  let skippedMatches = 0;
  const apply = (entries: ConfigEntry[]) => {
    for (const e of entries) {
      const prev = options.get(e.keyword);
      if (!prev) options.set(e.keyword, [e.args]);
      else if (MULTI.has(e.keyword)) prev.push(e.args);
    }
  };
  const first = (k: string) => options.get(k)?.[0]?.[0];
  for (const b of config.blocks as ConfigBlock[]) {
    if (b.kind === 'global') apply(b.entries);
    else if (b.kind === 'host') {
      if (matchPatternList(b.patterns, alias)) apply(b.entries);
    } else {
      const m = matchCriteria(b.patterns, alias, first('hostname'), first('user'));
      if (m === null) skippedMatches++;
      else if (m) apply(b.entries);
    }
  }
  return { alias, options, skippedMatches };
}

/** Concrete aliases defined in Host lines (no wildcards / negations), in file order. */
export function concreteAliases(config: ParsedConfig): string[] {
  const out: string[] = [];
  for (const b of config.blocks) {
    if (b.kind !== 'host') continue;
    for (const p of b.patterns.flatMap((x) => x.split(','))) {
      if (p && !/[*?!]/.test(p) && !out.includes(p)) out.push(p);
    }
  }
  return out;
}
