import { existsSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BRAND } from '@chh/shared';

/** The product was called "cy-ssh" before Phase 6; its data lived in a folder of that name. */
const LEGACY_SLUG = 'cy-ssh';

/**
 * Moves data from a pre-rename install into the current user-data folder, once. Only runs when the
 * current folder has no database key yet and the legacy folder has one, so it never overwrites
 * anything. Returns true if data was moved.
 */
export function migrateLegacyUserData(userData: string): boolean {
  const legacy = join(dirname(userData), LEGACY_SLUG);
  if (legacy === userData || existsSync(join(userData, 'db.key')) || !existsSync(join(legacy, 'db.key'))) return false;
  for (const name of readdirSync(legacy)) {
    const target = join(userData, renameDbFile(name));
    // Chromium may already have created its own files (Local State, caches) in the new folder.
    if (!existsSync(target)) renameSync(join(legacy, name), target);
  }
  return true;
}

/** `cy-ssh.db`, `cy-ssh.db-wal`, … → `chh.db`, … */
function renameDbFile(name: string): string {
  return name.startsWith(`${LEGACY_SLUG}.db`) ? BRAND.slug + name.slice(LEGACY_SLUG.length) : name;
}
