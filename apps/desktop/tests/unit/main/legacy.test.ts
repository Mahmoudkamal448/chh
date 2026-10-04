import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyUserData } from '../../../src/main/legacy';

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('moving data from a pre-rename (cy-ssh) install', () => {
  it('moves the old folder once, renaming the database files', () => {
    root = mkdtempSync(join(tmpdir(), 'chh-legacy-'));
    const legacy = join(root, 'cy-ssh');
    const current = join(root, 'chh');
    mkdirSync(join(legacy, 'logs'), { recursive: true });
    for (const f of ['db.key', 'cy-ssh.db', 'cy-ssh.db-wal', 'weak-keystore-accepted']) writeFileSync(join(legacy, f), f);
    // Chromium may have created the new folder (and some files) before we run.
    mkdirSync(current);
    writeFileSync(join(current, 'Local State'), 'new');

    expect(migrateLegacyUserData(current)).toBe(true);
    expect(readFileSync(join(current, 'db.key'), 'utf8')).toBe('db.key');
    expect(readFileSync(join(current, 'chh.db'), 'utf8')).toBe('cy-ssh.db');
    expect(readFileSync(join(current, 'chh.db-wal'), 'utf8')).toBe('cy-ssh.db-wal');
    expect(existsSync(join(current, 'logs'))).toBe(true);
    expect(readFileSync(join(current, 'Local State'), 'utf8')).toBe('new');
    // Never twice, and never over existing data.
    expect(migrateLegacyUserData(current)).toBe(false);
  });

  it('does nothing without a legacy install', () => {
    root = mkdtempSync(join(tmpdir(), 'chh-legacy-'));
    expect(migrateLegacyUserData(join(root, 'chh'))).toBe(false);
  });
});
