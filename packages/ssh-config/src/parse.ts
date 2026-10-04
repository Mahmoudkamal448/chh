/** OpenSSH client config (ssh_config(5)) parsing. Pure: file access is injected for Include. */

export interface ConfigEntry {
  /** Lower-cased keyword, e.g. "hostname". */
  keyword: string;
  args: string[];
  file: string;
  line: number;
}

export interface ConfigBlock {
  kind: 'global' | 'host' | 'match';
  /** Host patterns, or raw Match criteria tokens. */
  patterns: string[];
  entries: ConfigEntry[];
}

export interface ConfigWarning {
  file: string;
  line: number;
  message: string;
}

export interface ParsedConfig {
  blocks: ConfigBlock[];
  warnings: ConfigWarning[];
}

export interface ParseOptions {
  /** Path label of the top-level file (for warnings and relative Includes). */
  file?: string;
  /** Resolves an Include argument (may contain globs) to files' contents. */
  include?: (pattern: string, fromFile: string) => Array<{ path: string; text: string }>;
}

const MAX_INCLUDE_DEPTH = 16;

/** Splits a config line into keyword + arguments, honouring "quotes" and "keyword=value". */
export function tokenize(line: string): { keyword: string; args: string[] } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const m = /^([A-Za-z][A-Za-z0-9]*)(?:\s*=\s*|\s+)(.*)$/.exec(trimmed) ?? /^([A-Za-z][A-Za-z0-9]*)$/.exec(trimmed);
  if (!m) return null;
  const rest = m[2] ?? '';
  const args: string[] = [];
  let cur = '';
  let inQuote = false;
  let has = false;
  for (const ch of rest) {
    if (ch === '"') {
      inQuote = !inQuote;
      has = true;
      continue;
    }
    if (!inQuote && /\s/.test(ch)) {
      if (has) args.push(cur);
      cur = '';
      has = false;
      continue;
    }
    if (!inQuote && ch === '#' && !has) break; // trailing comment
    cur += ch;
    has = true;
  }
  if (has) args.push(cur);
  return { keyword: m[1]!.toLowerCase(), args };
}

export function parseSshConfig(text: string, opts: ParseOptions = {}): ParsedConfig {
  const blocks: ConfigBlock[] = [{ kind: 'global', patterns: [], entries: [] }];
  const warnings: ConfigWarning[] = [];

  const walk = (src: string, file: string, depth: number) => {
    const lines = src.split(/\r?\n/);
    lines.forEach((raw, i) => {
      const tok = tokenize(raw);
      if (!tok) return;
      const line = i + 1;
      if (tok.keyword === 'host') {
        if (!tok.args.length) warnings.push({ file, line, message: 'Host without patterns' });
        blocks.push({ kind: 'host', patterns: tok.args, entries: [] });
        return;
      }
      if (tok.keyword === 'match') {
        blocks.push({ kind: 'match', patterns: tok.args, entries: [] });
        return;
      }
      if (tok.keyword === 'include') {
        if (depth >= MAX_INCLUDE_DEPTH) {
          warnings.push({ file, line, message: 'Include nested too deeply' });
          return;
        }
        if (!opts.include) {
          warnings.push({ file, line, message: 'Include not followed' });
          return;
        }
        for (const pattern of tok.args) {
          try {
            for (const inc of opts.include(pattern, file)) walk(inc.text, inc.path, depth + 1);
          } catch (e) {
            warnings.push({ file, line, message: `Include ${pattern}: ${(e as Error).message}` });
          }
        }
        return;
      }
      blocks[blocks.length - 1]!.entries.push({ keyword: tok.keyword, args: tok.args, file, line });
    });
  };

  walk(text, opts.file ?? 'config', 0);
  return { blocks, warnings };
}
