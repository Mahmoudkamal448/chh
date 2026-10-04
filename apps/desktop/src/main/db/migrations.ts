/** Ordered schema migrations. Never edit a shipped migration — append a new one. */
export const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE vaults (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL CHECK (kind IN ('personal', 'team')),
        name          TEXT NOT NULL,
        team_id       TEXT,
        role          TEXT,
        vault_key_enc BLOB NOT NULL,
        sync_cursor   INTEGER NOT NULL DEFAULT 0
      );

      -- Generic, sync-ready item store. Every synced entity (hosts, groups, known hosts, ...)
      -- is a row; per-field HLC clocks + a version vector make it mergeable later.
      CREATE TABLE items (
        id         TEXT PRIMARY KEY,
        vault_id   TEXT NOT NULL REFERENCES vaults(id),
        type       TEXT NOT NULL,
        fields     TEXT NOT NULL,
        clocks     TEXT NOT NULL,
        vv         TEXT NOT NULL,
        server_rev INTEGER,
        dirty      INTEGER NOT NULL DEFAULT 1,
        deleted    INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        label      TEXT GENERATED ALWAYS AS (json_extract(fields, '$.label')) VIRTUAL,
        address    TEXT GENERATED ALWAYS AS (json_extract(fields, '$.address')) VIRTUAL,
        group_id   TEXT GENERATED ALWAYS AS (json_extract(fields, '$.groupId')) VIRTUAL,
        parent_id  TEXT GENERATED ALWAYS AS (json_extract(fields, '$.parentId')) VIRTUAL,
        favorite   INTEGER GENERATED ALWAYS AS (json_extract(fields, '$.favorite')) VIRTUAL,
        pattern    TEXT GENERATED ALWAYS AS (json_extract(fields, '$.hostPattern')) VIRTUAL
      );
      CREATE INDEX items_type_label ON items (type, label COLLATE NOCASE) WHERE deleted = 0;
      CREATE INDEX items_type_group ON items (type, group_id) WHERE deleted = 0;
      CREATE INDEX items_type_parent ON items (type, parent_id) WHERE deleted = 0;
      CREATE INDEX items_known_host ON items (type, pattern) WHERE deleted = 0;
      CREATE INDEX items_dirty ON items (vault_id) WHERE dirty = 1;
    `,
  },
  {
    version: 2,
    sql: `
      -- Command history: device-local, never synced.
      CREATE TABLE history (
        id      INTEGER PRIMARY KEY,
        host_id TEXT,
        source  TEXT NOT NULL,
        command TEXT NOT NULL,
        at      INTEGER NOT NULL
      );
      CREATE INDEX history_at ON history (at DESC);
      CREATE INDEX history_host ON history (host_id, at DESC);
    `,
  },
  {
    version: 3,
    sql: `
      -- The signed-in sync account (at most one). Secrets inside are sealed with the local vault.
      CREATE TABLE sync_account (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        server_url  TEXT NOT NULL,
        email       TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        device_id   TEXT NOT NULL,
        kdf         TEXT NOT NULL,
        secrets     TEXT NOT NULL,
        totp        INTEGER NOT NULL DEFAULT 0,
        last_sync   INTEGER
      );
    `,
  },
  {
    version: 4,
    sql: `
      -- Team vaults: key generation of the key we hold (bumped by rotations).
      ALTER TABLE vaults ADD COLUMN key_gen INTEGER NOT NULL DEFAULT 1;

      -- Items moved to another vault leave a tombstone to upload to their old vault.
      CREATE TABLE vault_moves (
        vault_id TEXT NOT NULL,
        item_id  TEXT NOT NULL,
        type     TEXT NOT NULL,
        base_rev INTEGER NOT NULL,
        vv       TEXT NOT NULL,
        PRIMARY KEY (vault_id, item_id)
      );

      -- Team audit events only this app can observe (e.g. connecting to a shared host), queued
      -- until the next sync.
      CREATE TABLE audit_outbox (
        id       INTEGER PRIMARY KEY,
        vault_id TEXT NOT NULL,
        action   TEXT NOT NULL,
        item_id  TEXT,
        at       INTEGER NOT NULL
      );
      CREATE INDEX items_vault ON items (vault_id, type) WHERE deleted = 0;
    `,
  },
];
