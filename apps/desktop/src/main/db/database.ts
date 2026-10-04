import Database from 'better-sqlite3-multiple-ciphers';
import { MIGRATIONS } from './migrations';

export type Db = Database.Database;

/**
 * Opens (or creates) the encrypted database. Uses SQLite3 Multiple Ciphers with the
 * ChaCha20-Poly1305 scheme and a raw 256-bit key, so no password KDF runs at startup.
 */
export function openDatabase(path: string, key: Buffer): Db {
  const db = new Database(path);
  try {
    db.pragma(`cipher = 'chacha20'`);
    db.pragma(`hexkey = '${key.toString('hex')}'`);
    // Fails with "file is not a database" if the key is wrong.
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    migrate(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

export function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version);
    })();
  }
}
