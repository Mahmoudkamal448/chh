import { AppSettingsSchema, DEFAULT_APP_SETTINGS, type AppSettings } from '@chh/shared';
import type { Db } from './database';

/** Device-local key/value settings (never synced). */
export class SettingsRepo {
  constructor(private readonly db: Db) {}

  getRaw(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setRaw(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  getApp(): AppSettings {
    const raw = this.getRaw('app');
    if (!raw) return { ...DEFAULT_APP_SETTINGS };
    const parsed = AppSettingsSchema.partial().safeParse(JSON.parse(raw));
    return { ...DEFAULT_APP_SETTINGS, ...(parsed.success ? parsed.data : {}) };
  }

  setApp(patch: Partial<AppSettings>): AppSettings {
    const next = AppSettingsSchema.parse({ ...this.getApp(), ...patch });
    this.setRaw('app', JSON.stringify(next));
    return next;
  }
}
