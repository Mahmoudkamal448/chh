# cy-ssh — Architecture

> **Status:** approved. Phases 1–5 are implemented (risk R1 outcome: FIDO2 via the System OpenSSH engine, see PHASE-5.md); see the deviation notes in [PHASE-1.md](PHASE-1.md#deviations-from-the-architecture-draft),
> [PHASE-2.md](PHASE-2.md#design-notes-and-deviations), [PHASE-3.md](PHASE-3.md#design-notes-and-deviations) and
> [PHASE-4.md](PHASE-4.md#design-notes-and-deviations) and [PHASE-5.md](PHASE-5.md#design-notes-and-deviations).

> **Product name:** `cy-ssh` (npm scope `@cy-ssh/*`, bundle ID `dev.cyssh.app`). Name, icon and
> colors live in `packages/shared/src/brand.ts` + `apps/desktop/build/`. All branding/UI is original.

---

## 0. Changes to the requested stack (and why)

| Requested | Proposed | Reason |
|---|---|---|
| `better-sqlite3` | **`better-sqlite3-multiple-ciphers`** (drop-in fork, same API) | Gives whole-DB encryption at rest (SQLCipher-compatible), so host labels, history and metadata are encrypted too, not only secrets. |
| OS keychain via `keytar` (implied) | **Electron `safeStorage`** | `keytar` is archived. `safeStorage` uses Keychain (macOS), DPAPI (Windows) and libsecret/kwallet (Linux) with no extra native module. On Linux, if it reports the `basic_text` backend (no keyring), we tell the user and require a master password instead. |
| Run sessions in the Electron main process | **A `utilityProcess` "session host"** | ssh2/pty/serial/telnet run in a separate Node process. Terminal bytes go straight from that process to the renderer through `MessagePort`s. The main process stays responsive with 50+ busy tabs, and if a native module crashes, it can't take down the window. |
| (unspecified) build tooling | **pnpm workspaces + electron-vite + Vitest** | Fast HMR for main, preload and renderer. Shared TS packages without publishing them. |
| (unspecified) server DB layer | **`postgres` (porsager) + plain SQL migrations** | Small, fast and readable. No ORM magic in a security-sensitive service. |
| Raw Tailwind components | Tailwind v4 + **Radix UI primitives** | Accessible dialogs, menus and focus management come built in. |
| — | **Zustand** (state), **TanStack Virtual** (1k+ host lists), **cmdk** (command palette), **i18next** (strings), **zod** (IPC + API validation), **pino** (logging with redaction) | Each covers one NFR directly. |

**Toolchain:** the local machine has Node 18.13. Electron's current toolchain and Vite need Node ≥ 20, so we'll pin **Node 22 LTS** via `.nvmrc` / `packageManager` / `engines`.

---

## 1. Repository layout

```
cy-ssh/
├─ package.json                 # pnpm workspace root, scripts, engines
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ .nvmrc                       # 22
├─ .github/workflows/
│  ├─ ci.yml                    # lint + typecheck + unit + E2E on win/mac/linux
│  └─ release.yml               # tag → build, sign, notarize, publish (Phase 6)
├─ deploy/
│  ├─ docker-compose.yml        # server + postgres (+ optional mailpit)
│  └─ .env.example
├─ docs/
│  ├─ ARCHITECTURE.md
│  ├─ SECURITY.md               # threat model, crypto spec
│  └─ SELF_HOSTING.md
│
├─ packages/
│  ├─ shared/                   # pure TS, no Node/DOM deps
│  │  └─ src/
│  │     ├─ brand.ts
│  │     ├─ ipc/contract.ts     # THE typed IPC contract (zod schemas + types)
│  │     ├─ model/              # Host, Group, Identity, Key, Snippet, ... types + zod
│  │     ├─ sync/protocol.ts    # REST/WS request/response schemas (shared w/ server)
│  │     └─ i18n/en.json
│  ├─ sync-core/                # pure TS: HLC, version vectors, field-level merge
│  ├─ vault-crypto/             # sodium-native wrappers: KDF, AEAD, key wrapping, sealed boxes
│  ├─ ssh-config/               # ~/.ssh/config parser/serializer (Include, Match, Host *)
│  ├─ key-formats/              # OpenSSH/PEM/PPK v2+v3 parse, fingerprints, known_hosts (incl. hashed)
│  └─ native-winhello/          # tiny N-API addon (C++/WinRT UserConsentVerifier), Phase 4
│
└─ apps/
   ├─ desktop/
   │  ├─ electron.vite.config.ts
   │  ├─ electron-builder.yml
   │  ├─ build/                 # icons, entitlements.mac.plist, installer assets
   │  ├─ src/
   │  │  ├─ main/               # Electron main process
   │  │  │  ├─ index.ts         # app lifecycle, fuses check, single-instance lock
   │  │  │  ├─ window.ts        # BrowserWindow w/ hardened webPreferences + CSP
   │  │  │  ├─ ipc/             # one handler file per contract namespace
   │  │  │  ├─ db/              # SQLite open/migrate, repositories
   │  │  │  ├─ secrets/         # safeStorage-backed local key mgmt, app lock
   │  │  │  ├─ vault/           # item encrypt/decrypt, personal/team vault keys
   │  │  │  ├─ sync/            # sync engine (pull/push/merge/WS), offline outbox
   │  │  │  ├─ session-host.ts  # spawns + supervises the utilityProcess
   │  │  │  ├─ importers/       # ssh_config, AWS EC2, DigitalOcean
   │  │  │  ├─ updater.ts       # electron-updater (Phase 6)
   │  │  │  └─ log.ts           # pino w/ redaction
   │  │  ├─ session-host/       # utilityProcess entry: owns all live connections
   │  │  │  ├─ index.ts
   │  │  │  ├─ transports/      # ssh.ts, local-pty.ts, telnet.ts, mosh.ts, serial.ts
   │  │  │  ├─ ssh/             # auth, jump chains, proxies, agent, forwarding, sftp
   │  │  │  ├─ broadcast.ts     # multi-host snippet runner
   │  │  │  └─ shell-integration/ # OSC 133 prompt marks for history/autocomplete
   │  │  ├─ preload/
   │  │  │  └─ index.ts         # contextBridge: exposes typed `window.cy`
   │  │  └─ renderer/           # React app
   │  │     ├─ main.tsx
   │  │     ├─ app/             # layout, routing, theme provider, i18n init
   │  │     ├─ features/        # hosts, terminal, sftp, keys, identities, snippets,
   │  │     │                   # forwarding, history, settings, sync, team, palette
   │  │     ├─ terminal/        # xterm wrapper, addons, pane tree (split view)
   │  │     ├─ components/      # design-system primitives (Radix + Tailwind)
   │  │     ├─ stores/          # zustand stores
   │  │     └─ themes/          # 12 terminal color schemes + UI light/dark tokens
   │  └─ tests/
   │     ├─ unit/
   │     └─ e2e/                # Playwright `_electron`
   │
   └─ server/
      ├─ Dockerfile
      ├─ src/
      │  ├─ index.ts            # Fastify bootstrap
      │  ├─ config.ts           # env parsing (zod)
      │  ├─ db/migrations/*.sql
      │  ├─ routes/             # auth, devices, sync, teams, invites, audit
      │  ├─ ws/                 # change notifications
      │  ├─ services/           # mail (SMTP optional), totp, tokens
      │  └─ plugins/            # auth guard, rate limit, error handler
      └─ tests/
```

---

## 2. Process model

```
┌────────────────────────────── Electron app ───────────────────────────────┐
│                                                                           │
│  Renderer (sandboxed, no Node)          Main process (Node)               │
│  ┌──────────────────────────┐  invoke   ┌──────────────────────────────┐  │
│  │ React UI, xterm.js       │──────────▶│ IPC handlers (zod-validated) │  │
│  │ window.cy (typed API)    │◀──events──│ DB (SQLCipher), vault crypto │  │
│  └──────────┬───────────────┘           │ sync engine, importers       │  │
│             │ MessagePort per session   │ safeStorage, app lock        │  │
│             │ (raw bytes, no JSON)      └──────────────┬───────────────┘  │
│             │                                  control │ (parentPort)     │
│             ▼                                          ▼                  │
│  ┌──────────────────────────────────────────────────────────────────┐     │
│  │ Session host (utilityProcess, Node)                              │     │
│  │ ssh2 · node-pty · serialport · telnet · mosh-client (via pty)    │     │
│  │ SFTP · port forwards · agent · jump chains · broadcast runner    │     │
│  └──────────────────────────────────────────────────────────────────┘     │
└───────────────────────────────────────────────────────────────────────────┘
                     │ HTTPS + WSS (opaque ciphertext only)
                     ▼
            ┌──────────────────────┐
            │ Sync server (Fastify)│──▶ PostgreSQL
            └──────────────────────┘
```

* **Renderer** never sees passwords or private keys. It asks main to open a session for `hostId`. Main resolves the full config: group inheritance, identity, decrypted secrets and the jump chain. It hands that config to the session host and gives the renderer a `MessagePort` for the session's byte stream.
* **Main ↔ session host:** a control channel over `parentPort` (open/close/resize/forward/sftp ops, host-key prompts relayed to the UI). Hot data never passes through main.
* **Hardening:** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, and a strict CSP (`default-src 'self'`). Navigation and `window.open` are denied. Every IPC handler checks `event.senderFrame.url` against the app origin. The build also sets Electron fuses: RunAsNode off, NodeOptions off, OnlyLoadAppFromAsar on, EmbeddedAsarIntegrityValidation on.

---

## 3. IPC design: typed contract + contextBridge

One source of truth in `packages/shared/src/ipc/contract.ts`:

```ts
import { z } from 'zod';
import { HostSchema, HostInputSchema, ... } from '../model';

export const contract = {
  hosts: {
    list:   { input: z.object({ query: z.string().optional(), groupId: z.string().optional(),
                                tag: z.string().optional(), favoritesOnly: z.boolean().optional(),
                                offset: z.number().int().min(0), limit: z.number().int().max(500) }),
              output: z.object({ items: z.array(HostSummarySchema), total: z.number() }) },
    get:    { input: z.object({ id: z.string() }), output: HostSchema },
    upsert: { input: HostInputSchema, output: HostSchema },
    remove: { input: z.object({ ids: z.array(z.string()) }), output: z.void() },
  },
  sessions: {
    open:   { input: OpenSessionSchema,  output: z.object({ sessionId: z.string() }) }, // port delivered separately
    resize: { input: z.object({ sessionId: z.string(), cols: z.number(), rows: z.number() }), output: z.void() },
    close:  { input: z.object({ sessionId: z.string() }), output: z.void() },
  },
  // keys, identities, knownHosts, sftp, forwards, snippets, history, settings, sync, team, app ...
} as const;

export const events = {
  'session.status':     SessionStatusSchema,     // connecting | ready | closed | error
  'hostkey.prompt':     HostKeyPromptSchema,     // new / changed fingerprint → UI decision
  'sync.state':         SyncStateSchema,
  'app.locked':         z.object({}),
} as const;

type In<T>  = T extends { input: infer I extends z.ZodTypeAny } ? z.input<I> : never;
type Out<T> = T extends { output: infer O extends z.ZodTypeAny } ? z.output<O> : never;
export type CyApi = {
  [NS in keyof typeof contract]: {
    [M in keyof (typeof contract)[NS]]: (input: In<(typeof contract)[NS][M]>) =>
      Promise<Out<(typeof contract)[NS][M]>>
  }
} & { on<E extends keyof typeof events>(e: E, cb: (p: z.infer<(typeof events)[E]>) => void): () => void };
```

* **Preload** builds `window.cy` by walking `contract` and mapping each `ns.method` to `ipcRenderer.invoke('ns.method', input)`. Event subscriptions use an allow-list of names. Session ports arrive through `ipcRenderer.on('session.port', e => e.ports[0])` and are re-exposed as a small `TerminalStream` wrapper, because a `MessagePort` can't cross contextBridge directly. The preload holds the port and passes `Uint8Array` chunks to a callback.
* **Main** registers handlers with `handle(contract.hosts.list, impl)`. The helper parses input with zod, runs the implementation, validates the output in dev builds, and turns errors into `{ code, messageKey }` (an i18n key, never stack traces or secrets).
* Both sides are type-checked against the same object, so renaming a method breaks the build instead of failing at runtime.

---

## 4. Data model

### 4.1 Local SQLite (encrypted with SQLCipher, key from `safeStorage`)

Synced entities share a single **generic item store**. Sync, encryption and conflict resolution are written once and work for every entity type. Fast queries come from **generated columns + indexes**.

```sql
CREATE TABLE vaults (
  id            TEXT PRIMARY KEY,         -- uuid v7
  kind          TEXT NOT NULL CHECK (kind IN ('personal','team')),
  name          TEXT NOT NULL,
  team_id       TEXT,                     -- server team id, null for personal
  role          TEXT,                     -- my role in team vault
  vault_key_enc BLOB NOT NULL,            -- vault key wrapped by local DB key (and by account key when synced)
  sync_cursor   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE items (
  id         TEXT PRIMARY KEY,            -- uuid v7
  vault_id   TEXT NOT NULL REFERENCES vaults(id),
  type       TEXT NOT NULL,               -- host|group|identity|key|snippet|forward|known_host|tag|theme
  fields     TEXT NOT NULL,               -- JSON; secret fields hold sealed ciphertext (see 5.3)
  clocks     TEXT NOT NULL,               -- JSON { field: HLC } for field-level LWW
  vv         TEXT NOT NULL,               -- JSON version vector { deviceId: counter }
  server_rev INTEGER,                     -- last server revision seen (null = never synced)
  dirty      INTEGER NOT NULL DEFAULT 0,  -- pending push
  deleted    INTEGER NOT NULL DEFAULT 0,  -- tombstone (also an LWW field "_deleted")
  -- generated columns for querying/indexing
  label      TEXT GENERATED ALWAYS AS (json_extract(fields,'$.label')) VIRTUAL,
  group_id   TEXT GENERATED ALWAYS AS (json_extract(fields,'$.groupId')) VIRTUAL,
  favorite   INTEGER GENERATED ALWAYS AS (json_extract(fields,'$.favorite')) VIRTUAL
);
CREATE INDEX items_type_label ON items(type, vault_id, label COLLATE NOCASE) WHERE deleted = 0;
CREATE INDEX items_group      ON items(type, group_id) WHERE deleted = 0;
CREATE VIRTUAL TABLE items_fts USING fts5(id UNINDEXED, label, address, tags, notes); -- host search

-- local-only (never synced)
CREATE TABLE history (id INTEGER PRIMARY KEY, host_id TEXT, session_id TEXT, command TEXT,
                      cwd TEXT, exit_code INTEGER, at INTEGER);
CREATE VIRTUAL TABLE history_fts USING fts5(command, content='history', content_rowid='id');
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);        -- device-local prefs
CREATE TABLE sync_account (id INTEGER PRIMARY KEY CHECK (id=1), server_url TEXT, email TEXT,
                           device_id TEXT, refresh_token_enc BLOB, account_key_enc BLOB,
                           private_key_enc BLOB, public_key BLOB);
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
```

**Entity field shapes** (zod schemas in `packages/shared/src/model`):

| type | key fields |
|---|---|
| `group` | `label, parentId, settings: Partial<HostSettings>` (inherited down the tree) |
| `host` | `label, address, port, protocol (ssh/telnet/mosh/serial/local), groupId, tags[], favorite, identityId?, username?, password?🔒, keyId?, jumpChain: hostId[], proxy?, agentForwarding, env: {k:v}, startupSnippetId?, osHint, settings: Partial<HostSettings>, serial?: {path, baud, dataBits, parity, stopBits, flow}, notes` |
| `HostSettings` | `theme, fontFamily, fontSize, cursorStyle, scrollback, keepAlive, ciphers?, kex?, encoding, mosh options` |
| `identity` | `label, username, password?🔒, keyId?` |
| `key` | `label, algorithm, bits?, publicKey, privateKey🔒, passphrase?🔒, fingerprint, isHardware (sk-*), comment` |
| `snippet` | `label, script, tags[], vars: {name, default}[], runIn: 'active'|'multi'` |
| `forward` | `label, hostId, kind (local/remote/dynamic), bindHost, bindPort, destHost?, destPort?, autoStart` |
| `known_host` | `hostPattern, port, keyType, fingerprintSha256, publicKey, addedAt` |
| `theme` | custom terminal color schemes (12 built-ins ship in code, not DB) |

🔒 = sealed with the vault key inside the item (section 5.3), so it's encrypted twice when stored locally.

**Effective host config** = defaults ← group chain (root → leaf) ← host. This is resolved in main by `resolveHost(hostId)`, and the result is never sent to the renderer when it contains secrets.

### 4.2 Server PostgreSQL

```sql
users            (id uuid pk, email citext unique, auth_hash text,        -- argon2id(authKey)
                  kdf_salt bytea, kdf_params jsonb,                       -- {alg:'argon2id', ops, mem}
                  account_key_wrapped bytea,                              -- wrapped by KEK (client-side)
                  recovery_wrapped bytea null,                            -- wrapped by recovery key
                  public_key bytea, private_key_wrapped bytea,            -- X25519 for team sharing
                  totp_secret_enc bytea null, totp_enabled bool, created_at)
devices          (id uuid pk, user_id, name, platform, last_seen_at, created_at)
refresh_tokens   (id uuid pk, user_id, device_id, token_hash bytea, expires_at, revoked_at, replaced_by)
vaults           (id uuid pk, kind text, owner_user_id uuid null, team_id uuid null, seq bigint default 0)
items            (vault_id, item_id uuid, rev bigint, seq bigint, ciphertext bytea, nonce bytea,
                  vv jsonb, size int, updated_by_device uuid, updated_at,
                  primary key (vault_id, item_id))
                  -- index (vault_id, seq) for pulls
teams            (id uuid pk, name_enc bytea, created_by, created_at)
team_members     (team_id, user_id, role text check in ('owner','admin','editor','viewer'),
                  vault_key_wrapped bytea null,  -- sealed to member's X25519 pubkey; null until confirmed
                  status text ('invited','accepted','confirmed'), primary key (team_id,user_id))
team_invites     (id uuid pk, team_id, email citext, role, token_hash bytea, invited_by, expires_at, accepted_at)
audit_log        (id bigserial pk, team_id, actor_user_id, device_id, action text, item_id uuid null,
                  ip inet, at timestamptz, meta jsonb)   -- append-only (no UPDATE/DELETE grant)
```

The server holds **no plaintext vault data**. Even team names are encrypted. The only exception is the TOTP secret: the server has to verify codes, so that secret is encrypted with a server-side key from env.

---

## 5. Encryption design

### 5.1 Key hierarchy

```
master password ──Argon2id(salt, ops=3, mem=256 MiB; params stored per user)──▶ masterKey (32B)
   masterKey ──crypto_kdf(id=1,"cy-auth")──▶ authKey   → sent to server at login (server stores argon2id(authKey))
   masterKey ──crypto_kdf(id=2,"cy-kek_")──▶ KEK       → never leaves device

KEK  ──XChaCha20-Poly1305──▶ wraps accountKey (random 32B)
accountKey ──wraps──▶ personal vaultKey (random 32B)
accountKey ──wraps──▶ X25519 private key (crypto_box keypair)
teamVaultKey ──crypto_box_seal(memberPublicKey)──▶ one wrapped copy per team member
recoveryKey (random 32B, shown once as base32 words) ──wraps──▶ accountKey  (optional)
```

* **Changing the password** only rewraps `accountKey`. No items are re-encrypted.
* **Forgotten password** without a recovery key means the vault can't be recovered. That's the zero-knowledge tradeoff, and the UI states it clearly.
* **Prelogin** (`POST /v1/auth/prelogin {email}`) returns the salt and KDF params. For unknown emails it returns a deterministic fake salt (HMAC of the email with a server secret), so accounts can't be enumerated.

### 5.2 Item encryption (sync)

```
plaintext = JSON { type, fields, clocks, deleted }     // padded to 256-byte buckets
nonce     = random 24B
ct        = crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, ad, nonce, vaultKey)
ad        = "cy/item/v1|" + vaultId + "|" + itemId
```

The AD binds each ciphertext to its vault and item, so a malicious server can't swap or move items between them. Rollback, where the server serves an old revision, is detected because the client tracks the max `rev` and VV it has seen per item and refuses regressions.

### 5.3 Local at-rest

1. **Local DB key** (random 32B): stored as `safeStorage.encryptString` output in `userData/db.key`. It opens the SQLCipher DB.
2. **Secret fields** (passwords, private keys, passphrases, tokens) are also sealed inside `fields` with the vault key. They're decrypted only in main, only on demand (for example right before connecting), and zeroed with `sodium_memzero` where the API allows it.
3. **App lock modes:**
   * *Off:* the DB opens automatically at login.
   * *OS-auth gate:* Touch ID (`systemPreferences.promptTouchID`) or Windows Hello (`native-winhello`) must succeed before the UI loads. On Linux this falls back to a PIN.
   * *Master-password mode (strongest):* the DB key is wrapped with an Argon2id-derived key, not only `safeStorage`, so the data is cryptographically locked until the password is entered. Biometrics can be layered on top as a convenience unlock using a key in the OS keychain.
4. **Logging:** pino with `redact` paths (`*.password`, `*.privateKey`, `*.passphrase`, `*.token`, `authorization`, …). Terminal I/O is never logged. A lint rule bans `console.*` in main and session-host.

### 5.4 Account 2FA (TOTP)

The server generates a TOTP secret (RFC 6238, otplib) and the user enrolls it with a QR code. After that, login takes password plus a TOTP code. Recovery codes are stored hashed (argon2id). This protects the **account**, meaning access to the ciphertext and team membership. The vault itself is protected by the master password.

---

## 6. Sync design

### 6.1 Clocks
* **HLC (hybrid logical clock)** per device: `(wallMs, counter, deviceId)`. Every field write stamps `clocks[field] = hlc.now()`. Total order comes from comparing `(wallMs, counter, deviceId)`, so ties are broken deterministically.
* **Version vector** per item: `{ deviceId: n }`. It's incremented on every local edit to the item.

### 6.2 Protocol (REST + WS, schemas in `packages/shared/src/sync/protocol.ts`)

| Call | Purpose |
|---|---|
| `POST /v1/sync/pull {vaultId, since, limit}` | Returns `{changes:[{itemId, rev, seq, vv, nonce, ciphertext}], nextSince, hasMore}`. Paged by vault `seq`. |
| `POST /v1/sync/push {vaultId, changes:[{itemId, baseRev, vv, nonce, ciphertext}]}` | Per-item result: `ok {rev, seq}` or `conflict {current}`. Applied atomically per item with `WHERE rev = baseRev` (optimistic concurrency). |
| `GET /v1/sync/ws` (WSS, auth via first message) | Server pushes `{type:'changed', vaultId, seq}`. The client then pulls. Heartbeats every 30s, and the client reconnects with exponential backoff and jitter. |

### 6.3 Client algorithm (offline-first)
1. Every local write goes to SQLite immediately: `dirty=1`, clocks and VV bumped. The UI never waits on the network.
2. The sync loop runs on startup, on a WS `changed` event, on a local write (debounced 1s), and on a 5-minute timer. It **pulls first**, then pushes.
3. For each pulled item:
   * not present or not dirty locally → decrypt and take the remote version
   * local dirty → compare the VVs:
     * remote dominates → take remote
     * local dominates → keep local and push
     * **concurrent** → **merge per field**: for each field, keep the value with the larger HLC. Then VV = pointwise max plus our increment. Mark dirty and push with `baseRev = remote.rev`.
4. If a push returns `conflict`, the client merges against `current` (step 3) and retries, at most 3 times per cycle.
5. **Deletes** are tombstones: the `_deleted` field is just another LWW field, so it resolves the same way as any edit. Tombstones are compacted after 90 days once every known device has synced past them.
6. Merge, HLC and VV logic lives in `packages/sync-core`. It's pure functions with property-based tests (fast-check) for convergence: any interleaving of operations across N replicas must end up identical.

### 6.4 Team vault
* **Invite:** an admin enters an email. The server creates an invite (SMTP email if configured, otherwise the admin copies the link). The invitee signs in or signs up and accepts, which sets status `accepted`.
* **Confirm:** the admin's client fetches the invitee's public key and shows its **fingerprint** (to defend against a server swapping in its own key; verification is optional but encouraged). It then seals `teamVaultKey` to that public key and uploads it, which sets status `confirmed`.
* **Roles:** `owner`/`admin` manage members; `editor` can read and write items; `viewer` can only read. The server enforces writes, since push requires editor or higher. Reads are enforced cryptographically: only members get the key.
* **Member removal:** the client rotates `teamVaultKey`, re-encrypts all items and rewraps the key for the remaining members. The removed member can't decrypt anything that changes afterward. They may still hold plaintext they had already synced, and the UI says so.
* **Audit log:** the server records every authenticated action (push/pull per item, membership changes, invites, logins on team-scoped tokens). "Viewed secret" and "connected using shared host" events are **client-reported**. They're useful, but a modified client could skip them, so the UI labels them that way.

---

## 7. Terminal & sessions

* **xterm.js** with the WebGL renderer (falls back to canvas/DOM), plus the fit, search, web-links, unicode11 and serialize addons.
* **Pane tree:** a split-view layout is a binary tree `{dir:'h'|'v', ratio, a, b} | {sessionId}` stored per tab. Panes can be resized, moved and zoomed with keyboard shortcuts.
* **Back-pressure:** the session host pauses the SSH channel or pty when the renderer's unacked bytes exceed 512 KB. This uses xterm's write callback to send acks over the port, so `cat bigfile` can't freeze the UI.
* **History & autocomplete:**
  * *Best:* on bash and zsh we can inject an optional OSC 133 shell-integration snippet. It's opt-in per host and transparent: we show exactly what gets sent. That gives precise command boundaries and exit codes.
  * *Fallback:* a heuristic line buffer of keystrokes sent since the last prompt. Commands are skipped when input isn't echoed back, which catches password prompts.
  * *Suggestions:* a ghost-text overlay above xterm. Providers implement
    ```ts
    interface SuggestionProvider { id: string; suggest(ctx: SuggestCtx, signal: AbortSignal): AsyncIterable<Suggestion> }
    ```
    The built-ins are history (frecency) and snippets. An **AI provider** is optional and off by default: the user supplies an endpoint and model, it's enabled per host, it never sees secrets or env vars, and it only receives the current line and recent history if the user allows that.

---

## 8. Technical risks & proposed workarounds

| # | Risk | Proposed approach |
|---|---|---|
| R1 | **FIDO2 / `sk-ssh-ed25519` in `ssh2`**: ssh2 doesn't implement security-key signatures (the `sk-*` algorithms need flags and a counter in the signature, and a CTAP2 device conversation). | (a) **Primary:** go through the **system ssh-agent** (OpenSSH ≥ 8.2 handles touch and PIN), with a small `patch-package` patch so ssh2 passes `sk-*` key types and signatures through unchanged. (b) For keys generated in-app: create them with `ssh-keygen -t ed25519-sk` (from the user's OpenSSH install) instead of linking libfido2 ourselves. (c) **Fallback:** for hosts marked "use system ssh", spawn the OpenSSH `ssh` binary inside node-pty. This is a prototype spike at the start of Phase 5; if (a) fails we ship (b) and (c). |
| R2 | **Mosh on Windows**: there's no maintained native Windows `mosh-client`. | We bootstrap over ssh2 (`mosh-server new …` → parse `MOSH CONNECT port key`) and spawn `mosh-client` in a pty with `MOSH_KEY`. **macOS/Linux:** detect it on PATH or Homebrew, and the UI tells the user how to install it if it's missing. **Windows:** use `wsl.exe mosh-client` when WSL has it; otherwise Mosh is disabled with an explanation. Bundling a Cygwin build is possible later, but it's GPLv3, so we'd also have to publish the corresponding source. |
| R3 | **Windows Hello**: Electron has no API for it. | A ~150-line N-API addon calling WinRT `UserConsentVerifier` (`packages/native-winhello`), with prebuilt binaries made in CI. If it's unavailable, the app falls back to PIN or master password. |
| R4 | **Linux keyring may be missing** (headless or minimal window managers), and then `safeStorage` uses `basic_text`. | Detect it with `safeStorage.getSelectedStorageBackend()` and require master-password mode. The app never silently stores the key in plaintext. |
| R5 | **Native modules** (node-pty, sqlite-mc, sodium-native, serialport) need builds per Electron ABI × 3 OSes × x64/arm64. | Use `electron-builder install-app-deps` and prebuilds where they exist; the CI matrix builds each target on its own OS. Windows needs the VS Build Tools for node-pty/ConPTY. |
| R6 | **No post-quantum KEX in ssh2** (`mlkem768x25519-sha256`, `sntrup761`). Servers still accept curve25519, but OpenSSH ≥ 10.1 logs a warning. | Default to `curve25519-sha256` plus `chacha20-poly1305@openssh.com` / AES-GCM, and document the gap. The "use system ssh" path (R1c) gives PQ KEX when it's needed. |
| R7 | **PPK v3** encrypted keys use Argon2 variants that libsodium doesn't fully cover (argon2d). | Write our own PPK v2/v3 parser in `key-formats` and use `hash-wasm` for argon2d/i/id. |
| R8 | **macOS notarization / Windows signing** need paid certificates (Apple Developer ID; an EV/OV cert or Azure Trusted Signing). | The pipeline reads them from CI secrets and makes **unsigned** builds when they're absent. You'll need to provide the credentials. |
| R9 | **Auto-update on Linux**: only AppImage supports in-app updates. | AppImage uses electron-updater; for .deb/.rpm the app shows a notice linking to the package (optionally an APT/RPM repo later). |
| R10 | **History capture over SSH** can't see remote echo state reliably. | OSC 133 when enabled, the echo heuristic otherwise; history is local-only by default, with a per-host "don't record" toggle. |
| R11 | **E2E tests against real SSH** need a server. | CI runs a Docker `openssh-server` on the Linux runner for integration and E2E. On macOS and Windows runners, E2E covers the UI and local terminal, and a Node in-process ssh2 server handles SSH flows. |

---

## 9. Testing & CI

* **Unit (Vitest):** `vault-crypto` (known-answer vectors, tamper and AD-mismatch rejection, key wrapping round-trips), `sync-core` (fast-check convergence, VV ordering, HLC monotonicity), `ssh-config` (round-trip on a fixture corpus), `key-formats` (OpenSSH/PEM/PPK v2/v3 fixtures, hashed known_hosts), and group-inheritance resolution.
* **Server:** Fastify `inject` tests against Postgres (a service container in CI), covering auth, optimistic concurrency, RBAC and the audit log.
* **E2E (Playwright `_electron`):** create a host, connect to the test sshd, type and assert output, split a pane, run a snippet on 2 hosts, and accept a host-key change warning.
* **CI matrix:** `ubuntu-latest`, `macos-latest`, `windows-latest` × Node 22 → install, lint, typecheck, unit, build, E2E (with xvfb on Linux).

---

## 10. Phase plan (as requested, with phase-specific notes)

1. **Shell + host manager + SSH/local terminal + tabs.** Includes the IPC contract, SQLCipher DB, safeStorage key, virtualized host list (tested with 5k seeded hosts), command palette skeleton, light/dark UI, and i18n plumbing.
2. **Keys, identities, known-hosts, SFTP** dual-pane browser (drag-and-drop between panes and from the OS, chmod editor, transfer queue with progress).
3. **Forwarding, snippets, history, themes (12 schemes), split view, Telnet, Mosh, ssh_config import/export.**
4. **Vault crypto, sync server (+ Docker Compose), multi-device sync, TOTP 2FA, app lock (Touch ID / Windows Hello).**
5. **Jump hosts, HTTP/SOCKS proxies, agent forwarding, serial, FIDO2 (after the R1 spike), env vars, multi-host snippets, autocomplete + AI provider interface, AWS/DO import.**
6. **Team vault + audit log, electron-builder packaging for all targets, signing hooks, auto-update.**

Every phase ends with `pnpm dev` running, `pnpm test` green, and run/test instructions plus Windows/macOS/Linux notes.

---

## 11. Non-negotiables (enforced in code review)

* No plans, tiers, trials, device limits, license checks or upgrade prompts, in either the app or the server. There's no `plan`/`tier` column in the schema.
* Sync is optional. Every feature works with no account and no network.
* The server URL is user-configurable, and nothing is hardcoded besides an empty default.
* No secrets in logs, crash reports, IPC error messages, or the renderer process.
