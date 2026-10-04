# Phase 4: encrypted vault, self-hostable sync, multi-device sync, 2FA, app lock

**Status:** complete. 153 unit/integration tests (server tests run against both an in-memory store and real
PostgreSQL 16) and 19 end-to-end tests pass on Linux (WSL2). The end-to-end tests include two app instances
syncing through a real server. The server Docker image builds and runs. Typecheck is clean.

## What works

| Area | Details |
|---|---|
| **Zero-knowledge vault** | Password → Argon2id (256 MiB, 3 passes) → master key → *auth key* (sent to the server, which stores only an Argon2id hash of it) and *KEK* (never leaves the device). The KEK wraps a random account key, which wraps the vault key and an X25519 key pair (for Phase 6 team vaults). Items are encrypted with XChaCha20-Poly1305, padded to 256-byte buckets and bound to (vault, item) |
| **Sync server** (`apps/server`) | Fastify + PostgreSQL. Register/login/refresh/logout, opaque bearer tokens (1 h access, 90-day rotating refresh with reuse detection), decoy KDF params for unknown emails (no account enumeration), constant-time failure paths, per-IP rate limits, optimistic-concurrency push, paged pull, WebSocket change notifications, device list/remote sign-out, password change (signs other devices out), account deletion, `ALLOW_REGISTRATION` switch |
| **Self-hosting** | Multi-stage Dockerfile, Docker Compose with Postgres, optional Caddy profile for automatic HTTPS, `.env.example`, [SELF_HOSTING.md](SELF_HOSTING.md) |
| **Multi-device sync** | Offline-first: local writes never wait. The engine pulls, then pushes. Concurrent edits merge **per field** (version vectors detect concurrency, hybrid logical clocks pick the latest write per field). Deletes are tombstones. Live updates over WebSocket (reconnect with backoff), periodic sync every 5 minutes, debounced push after local edits. **Rollback protection**: a stale version from the server never replaces newer local data |
| **Joining an account** | A second device keeps its existing local data: its vault is re-keyed into the account's vault (secrets re-sealed in one transaction) and merged up |
| **2FA (TOTP)** | QR code + manual key, 10 one-time recovery codes, replay protection (each 30-second step works once), required for sign-in and password recovery |
| **Recovery key** | Shown once at sign-up (52 base32 characters). Resets a forgotten password without the server ever learning the password or the data: a recovery-derived auth key proves possession, the server returns the recovery-wrapped account key, and the client rewraps it under the new password. All other sessions are signed out |
| **App lock** | *Lock screen*: passcode (Argon2id-hashed), optional Touch ID or Windows Hello, auto-lock after N idle minutes (system-wide idle time), lock on sleep/screen lock, manual lock (⌘⇧L / Ctrl+Shift+L, or the 🔒 button). Retries are throttled with exponential backoff after 5 failures. **While locked, every data IPC call is refused in the main process**, not just hidden. Sessions keep running |
| **Master password** | Encrypts the local database key with Argon2id instead of (only) the OS keychain. It's required at every start; the database isn't opened until then. This also closes the "no keyring on Linux" gap from Phase 1 |
| **UI** | Settings now has sections (General, Terminal, Shortcuts, Security, Sync & account). A sync status icon in the tab bar shows up to date / syncing / offline / error. Sign-in, account creation and recovery forms. Device list. Change password, sign out (keep or remove data), delete account |

## Bugs found and fixed during this phase

- **Error messages were generic since Phase 1.** Electron's contextBridge drops custom properties on errors, so
  the renderer never saw our error codes and fell back to "Something went wrong". Errors now travel encoded in
  the message (`encodeIpcError`/`decodeIpcError`), with a unit test and an E2E assertion on a real error text.
- **The recovery key could vanish.** Creating an account switches the sync panel to the signed-in view
  immediately, which unmounted the recovery-key dialog. The dialog now lives above that switch and can't be
  closed until "I've saved it" is ticked (covered by E2E).
- **Joining an account failed** (foreign-key violation while re-keying the vault): fixed by creating the new
  vault row before moving items.

## New and changed files

```
apps/server/                                       NEW
  src/{index,app,config,crypto}.ts                 Fastify app, env config, Argon2id/TOTP/token helpers
  src/store/{types,memory,postgres}.ts             storage interface, in-memory and Postgres (with migrations)
  test/server.test.ts                              runs against memory and (if TEST_DATABASE_URL) Postgres
  Dockerfile, build.mjs, package.json, tsconfig.json
deploy/{docker-compose.yml,Caddyfile,.env.example}  NEW
.dockerignore                                       NEW
packages/vault-crypto/src/account.ts               NEW: KDF, key hierarchy, recovery keys, sealed boxes,
                                                   item envelopes, passcode hashing (+ tests)
packages/shared/src/sync/protocol.ts               NEW: request/response schemas shared by client and server
packages/shared/src/model/sync.ts                  NEW: SyncStatus, lock settings/state
packages/shared/src/ipc/contract.ts                sync.*, lock.* namespaces; sync.state, lock.changed events;
                                                   encodeIpcError/decodeIpcError
apps/desktop/src/main/
  context.ts                                       NEW: everything that needs the open database
  index.ts                                         boot restructure: handlers first, DB opened at start or after unlock
  lock.ts                                          NEW: LockManager (passcode, biometrics, idle/sleep, master password)
  sync/{engine,http}.ts                            NEW: sync engine, HTTP client, URL policy
  secrets/local-key.ts                             master-password key file (v2)
  vault/local-vault.ts                             adopt() re-keying, local secret sealing
  db/item-store.ts, db/migrations.ts (v3)          sync rows, change listeners, sync_account table
  ipc/{handle,handlers}.ts                         lock gate; sync and lock handlers
apps/desktop/src/preload/index.ts                  errors encoded into the message
apps/desktop/src/renderer/
  main.tsx                                         lock gate (startup lock vs idle overlay)
  features/lock/LockScreen.tsx, features/settings/SecuritySettings.tsx, features/sync/SyncSettings.tsx
  features/settings/SettingsDialog.tsx (sections), features/tabs/TabBar.tsx (sync/lock indicators)
  stores/lock-store.ts, lib/errors.ts, app/{App.tsx,commands.ts}, lib/keymap.ts
apps/desktop/tests/
  unit/main/sync.test.ts                           two devices + real server: adoption, merge, rollback, deletes,
                                                   WebSocket, TOTP, password change, recovery, sign-out
  unit/ipc-errors.test.ts, e2e/phase4.spec.ts
.github/workflows/ci.yml                           server job (Postgres service + Docker build)
```

## Run and test

```bash
pnpm install
pnpm test                                    # 153 tests (server uses memory store)
# Server tests against real Postgres:
docker run -d --name cy-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=chh -p 127.0.0.1:55432:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/chh pnpm --filter @chh/server test
pnpm test:e2e                                # 19 Playwright tests

# Local sync server for manual testing:
STORE=memory SERVER_SECRET=$(openssl rand -base64 32) pnpm --filter @chh/server dev   # http://127.0.0.1:8080
```

### Manual checklist

1. Start a server (above, or `deploy/` with Docker Compose). Settings → Sync & account → Create account with
   `http://127.0.0.1:8080`. Save the recovery key.
2. Start a second instance with another profile: `CHH_USER_DATA=/tmp/cy2 pnpm dev`. Sign in there. Hosts appear,
   and edits on either side show up on the other within a second.
3. Disconnect the network, edit the same host on both (different fields), reconnect: both changes are kept.
4. Turn on two-factor authentication, then sign in on another profile: a code is required.
5. Forgot password → enter the recovery key and a new password: your data is still there.
6. Settings → Security → turn on the lock screen, press Ctrl+Shift+L. Set a master password, restart: the app asks
   for it before opening anything.

## Platform differences

| | Windows | macOS | Linux |
|---|---|---|---|
| Biometric unlock | Windows Hello through WinRT `UserConsentVerifier` (driven via PowerShell, no native module). **Not yet verified on real Windows hardware** | Touch ID (`systemPreferences.promptTouchID`) | Not available; passcode only |
| Idle detection | System-wide idle time (`powerMonitor`) | same | same (X11/Wayland support varies; on some Wayland compositors idle time may read as 0, so only lock-on-sleep and manual lock apply) |
| Lock on sleep | `suspend` + `lock-screen` events | same | `suspend`; `lock-screen` depends on the desktop |
| Key storage without master password | DPAPI | Keychain | libsecret/KWallet (weak fallback if absent) |

## Design notes and deviations

- **Opaque tokens instead of JWTs.** Access tokens are random and looked up by hash, so revocation (device
  removal, password change, refresh reuse) takes effect immediately.
- **The recovery flow** wasn't spelled out in the architecture draft. It adds a recovery-derived auth key, stored
  as an Argon2id hash on the server, and a short-lived single-use token between its two steps.
- **Delete wins** over a concurrent edit of the same item (the tombstone is permanent).
- **Not synced:** command history, app settings (theme, shortcuts, lock settings) and the master password. These
  are device-local by design.
- **Duplicate hosts:** if two devices created "the same" host independently before syncing, you'll see both
  (they have different ids). Delete one.
- **Password-recovery tokens and WebSocket fan-out are in memory** on the server. Run one replica (or sticky
  sessions); see SELF_HOSTING.md.
- **Windows Hello** goes through PowerShell rather than the native addon proposed in risk R3. It avoids shipping a
  native module but must be verified on Windows. The passcode always works as a fallback.
