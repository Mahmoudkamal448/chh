import type { HistoryEntry } from '@cy-ssh/shared';
import type { Db } from './database';

const MAX_ENTRIES = 50_000;

/** Device-local command history (inside the encrypted database; never synced). */
export class HistoryRepo {
  private inserts = 0;

  constructor(private readonly db: Db) {}

  /** Records a command, skipping immediate repeats from the same source. Returns true if stored. */
  add(hostId: string | null, source: string, command: string): boolean {
    const cmd = command.trim();
    if (!cmd) return false;
    const last = this.db
      .prepare('SELECT command FROM history WHERE source = ? AND host_id IS ? ORDER BY id DESC LIMIT 1')
      .get(source, hostId) as { command: string } | undefined;
    if (last?.command === cmd) return false;
    this.db.prepare('INSERT INTO history (host_id, source, command, at) VALUES (?, ?, ?, ?)').run(hostId, source, cmd, Date.now());
    if (++this.inserts % 500 === 0) this.prune();
    return true;
  }

  /** Newest first. Every whitespace-separated term must appear in the command. */
  search(query: string | undefined, hostId: string | undefined, limit: number): HistoryEntry[] {
    const where: string[] = [];
    const params: unknown[] = [];
    for (const term of (query ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
      where.push(`command LIKE ? ESCAPE '\\'`);
      params.push(`%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    if (hostId) {
      where.push('host_id = ?');
      params.push(hostId);
    }
    const rows = this.db
      .prepare(`SELECT id, host_id, source, command, at FROM history ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as Array<{ id: number; host_id: string | null; source: string; command: string; at: number }>;
    return rows.map((r) => ({ id: r.id, hostId: r.host_id, source: r.source, command: r.command, at: r.at }));
  }

  remove(ids: number[]): void {
    const stmt = this.db.prepare('DELETE FROM history WHERE id = ?');
    this.db.transaction(() => ids.forEach((id) => stmt.run(id)))();
  }

  clear(): void {
    this.db.prepare('DELETE FROM history').run();
  }

  /** Keeps the newest MAX_ENTRIES rows. */
  prune(): void {
    this.db.prepare('DELETE FROM history WHERE id <= (SELECT id FROM history ORDER BY id DESC LIMIT 1 OFFSET ?)').run(MAX_ENTRIES);
  }
}
