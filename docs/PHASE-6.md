# Phase 6: team vaults, audit log, signed installers, auto-update (and the rename to chh)

**Status:** complete. 199 unit/integration tests (desktop, packages and server, with the server suites
run against both the memory store and PostgreSQL 16) and 27 end-to-end tests pass on Linux. Typecheck
is clean. Packaging was verified by building the Linux AppImage and `.deb` and launching the packaged app with
all hardening fuses on.

## What works

| Area | Details |
|---|---|
| **Rename** | The project is now **chh** everywhere: npm scope `@chh/*`, product name, app ID `dev.chh.app`, env vars `CHH_*`, the preload API `window.chh`, IPC channels, Docker image `chh-server`. Existing installs keep their data (see "Upgrading from cy-ssh") |
| **Teams** | Create a team (Teams screen, needs a sync account). Each team has its own vault. Its key is generated on your device and sealed to each confirmed member's public key, so the server never sees it, nor the team's name or items |
| **Invites** | An admin invites an account email with a role. The invitee sees the invite live in their Teams screen and accepts. An admin then **confirms** them after comparing the member's public-key fingerprint (shown at the bottom of every member's Teams screen); only then is the team key shared. The app re-checks the fingerprint at the moment of sharing, so a key swapped in between is refused |
| **Roles** | Owner, admin (manage members), editor (change items), viewer (use shared hosts, read-only). Enforced by the server for every write and admin action, and locally (a viewer's app refuses edits before they reach the server). The owner can transfer ownership |
| **Sharing items** | Hosts, identities, keys and snippets show a team badge and can be moved between your personal vault and any team vault you can write to ("Move to…"). New hosts can be created straight in a team vault. Moving re-encrypts the item's secrets for the target vault and leaves a tombstone in the old one, so every device ends up with exactly one copy |
| **Removing members** | Removing a confirmed member **rotates the team key**: every item is re-encrypted with a new key on the admin's device and the key is re-sealed for the remaining members, in one atomic server transaction. The removed member's devices delete their local copies on their next sync. If a member leaves on their own (or an unconfirmed one is dropped) the team shows a "rotate key" warning to admins |
| **Audit log** | Admins see who did what and from which device: team created/renamed, invites, confirmations, role changes, removals, rotations, every item write, downloads, plus **client-reported** events (connecting to a shared host, opening its files, exporting a shared key), which are labelled as such. Stored append-only (a Postgres trigger rejects UPDATE, DELETE and TRUNCATE) |
| **Auto-update** | Signed release builds check GitHub releases in the background (shortly after start, then every 6 hours), download automatically (or only when you click, if you turn that off), and offer "Restart and update". Stable and beta channels. Development builds, unsigned macOS builds and installs that can't update themselves explain why and link to the download page |
| **Signed installers** | Windows NSIS (Azure Trusted Signing or a certificate), macOS DMG + ZIP for Intel and Apple silicon (Developer ID, hardened runtime, notarized), Linux AppImage/deb/rpm. Signing is driven by CI secrets; without them the builds are unsigned. A tag-triggered workflow builds all platforms into a draft GitHub release and publishes the server image to GHCR. See [RELEASING.md](RELEASING.md) |
| **Hardened builds** | Electron fuses: no run-as-node, no `NODE_OPTIONS`, no `--inspect`, asar-only with integrity validation, cookie encryption |

## Team cryptography in short

```
teamKey (random 32 B, made by the creator's device)
  ├─ crypto_box_seal(memberPublicKey) ──▶ one sealed copy per confirmed member (server stores these)
  ├─ XChaCha20-Poly1305 ──▶ every team item  (AD "cy/item/v1|vaultId|itemId", padded, as for personal items)
  ├─ secrets inside items sealed again      (AD "cy/secret/v1|vaultId|itemId|field")
  └─ team name                              (AD "cy/teamname/v1|teamId")
fingerprint(memberPublicKey) = BLAKE2b-128("cy/pkfp/v1|" ‖ publicKey), shown as 8 groups of 4 hex digits
```

Each member's X25519 key pair has existed since Phase 4 (the private key is wrapped by the account key). The
server tracks a **key generation** per team vault. Pushes must name the generation they encrypted with and are
refused when it's stale; pulls report it, so a device that missed a rotation fetches the new key first.

## Bugs found and fixed during this phase

- **"Sync now" could return before syncing.** If a background sync was already running, `syncNow()` returned
  immediately instead of waiting for the extra round it requested. It now waits for the in-flight run, including
  that round. (Found by the new team sync test under parallel load.)
- **Packaging from the pnpm workspace was broken.** electron-builder couldn't find the hoisted Electron, derived
  the executable name from the scoped package name (`@chhdesktop`), and couldn't build the `.deb` without a
  homepage. Fixed in the new config; CI now builds an unpacked Linux package on every run.
- **The architecture promised Electron fuses that weren't set.** They are now. (Disabling
  `GrantFileProtocolExtraPrivileges` as well broke loading the UI from `app.asar`, so that one stays at its
  default; found by launching the packaged app.)

## New and changed files

```
packages/shared/src/sync/protocol.ts      team, invite, member, rotation and audit wire schemas; keyGen on pull/push
packages/shared/src/model/{team,update}.ts renderer-facing team/vault/audit models, update status
packages/shared/src/ipc/contract.ts       teams.*, updates.*; teams.changed and update.status events
packages/vault-crypto/src/account.ts      team name encryption, seal/open team keys, public-key fingerprints
apps/server/src/
  teams.ts                                 team routes, role checks, vault access rules, audit helper
  http.ts, hub.ts                          shared HTTP error/parse helpers, WebSocket hub (multi-user notify)
  app.ts                                   team-aware pull/push (roles, key generations, audit), account deletion guard
  store/{types,memory,postgres}.ts         teams, members, invites, rotation, append-only audit log (migration 3)
apps/desktop/src/main/
  vault/local-vault.ts                     keyring: personal + team vault keys, per-vault sealing, re-keying
  db/item-store.ts, db/migrations.ts       per-vault writes, read-only policy, moves + tombstones, audit outbox (v4)
  sync/engine.ts                           multi-vault sync, team refresh, key-generation checks, audit upload
  sync/teams.ts                            TeamService: create, invite, confirm, roles, rotation, moves, audit
  updater.ts                               UpdateService (electron-updater) and build capability detection
  legacy.ts                                one-time move of the pre-rename user-data folder
  db/*-repo.ts, sessions.ts, context.ts, index.ts, ipc/*   vault ids, audit hooks, wiring
apps/desktop/src/renderer/
  features/teams/{TeamsView,MoveToVaultDialog,VaultBadge}.tsx, stores/teams-store.ts
  features/settings/UpdateSettings.tsx     Updates section and "ready to install" banner
  features/{hosts,identities,keys,snippets}/*   team badges, "Move to…", vault picker for new hosts
apps/desktop/electron-builder.config.cjs   signing, notarization, fuses, publish (replaces electron-builder.yml)
apps/desktop/build/icon.{svg,png}          app icon (original artwork)
.github/workflows/release.yml              tag → signed installers in a draft release + server image
docs/RELEASING.md                          release process and signing setup
tests: apps/server/test/teams.test.ts, apps/desktop/tests/unit/main/{teams,updater,legacy}.test.ts,
       apps/desktop/tests/e2e/phase6.spec.ts
```

## Run and test

```bash
pnpm test                                     # unit + integration (server: set TEST_DATABASE_URL to include Postgres)
pnpm test:e2e                                 # Playwright against the built app (Mosh needs a UTF-8 locale)
pnpm --filter @chh/desktop package            # installers for this OS (unsigned without credentials)
```

### Manual checklist

1. Sign in to sync on two computers with **different** accounts (A and B).
2. A: Teams → **+** → name it. Invite B's email as Editor.
3. B: Teams → accept the invite. Read out the fingerprint at the bottom of the Teams screen.
4. A: the member shows "Needs confirmation" → **Confirm…** → compare the fingerprint → **Share team key**.
5. A: right-click a host → **Move to…** → the team. B sees it with a team badge and can connect.
6. A: change B to Viewer; B can still connect but can't edit the host.
7. A: Teams → **Audit log**: B's connection shows as "Connected to a host · reported by app".
8. A: remove B. B's copy disappears; the key generation at the bottom of A's team view goes up by one.
9. Settings → **Updates**: a development build says it doesn't update itself. In a signed release build, publish a
   newer release and use **Check for updates**.

## Upgrading from cy-ssh

- **App data** moves from the old `cy-ssh` folder to `chh` automatically on first start (`cy-ssh.db` becomes
  `chh.db`). Nothing is copied over existing data.
- **Database key:** if you use a master password, nothing else is needed. Otherwise the key is protected by the
  OS keychain, and on macOS and Linux the keychain entry belongs to the app name. If chh can't read it, it stops
  with an explanation rather than starting empty. Either open the old build once and set a master password
  (Settings → Security) before upgrading, or sign in to sync on the new build to get your synced data back.
  Windows (DPAPI) isn't affected.
- **Self-hosted servers:** see [SELF_HOSTING.md](SELF_HOSTING.md#upgrading-from-cy-ssh) to keep using the existing
  database volume.
- **Unchanged on purpose:** the cryptographic context strings (`cy/item/v1`, `cy-auth_`, …) are part of the data
  format, so existing local data, sync accounts and server data stay readable.

## Platform differences

| | Windows | macOS | Linux |
|---|---|---|---|
| Installer | NSIS `.exe` (per user) | `.dmg` (Intel / Apple silicon) | AppImage, `.deb`, `.rpm` |
| Code signing | Azure Trusted Signing or certificate | Developer ID + notarization | none (SHA-512 verified updates) |
| Auto-update | Yes (only updates signed by the configured publisher) | Yes, signed builds only | AppImage, `.deb`, `.rpm` (the latter two ask for your password via `pkexec`); not for other installs |
| Teams, audit log | All | All | All |

## Design notes and deviations

- **Invites match the account email** instead of an emailed token: the server has no mail dependency, and the
  invitee proves the email by signing in. The admin tells the person out of band (the same channel used to
  compare fingerprints). An optional SMTP notification could be added later without changing the protocol.
- **Fingerprint verification is the trust anchor.** A malicious server could offer its own public key for an
  invitee; comparing fingerprints defeats that. It's strongly encouraged in the UI but can't be enforced.
  When rotating, the admin's app seals the new key to the public keys the server lists for already-confirmed
  members; those were verified when they were confirmed.
- **Rotation re-encrypts from the server's copy** of the vault (not from local data), so the item set is exactly
  what the server checks, including tombstones. The server rejects a rotation if anything changed meanwhile, and
  the app retries.
- **Pulls are audited per request** (with the number of items) rather than per item, to keep the log readable;
  writes are audited per item.
- **Removed members may keep what they already had.** A key rotation protects everything that changes afterwards.
  Their app deletes its local copies, but a modified app wouldn't.
- **Team data never stays on a signed-out device**, even when "keep data" is chosen; it belongs to the team.
- **Linked items aren't moved automatically.** Moving a host into a team doesn't move the identity or key it uses.
  You keep using them (all vaults are local to you); teammates need them moved too.
- **Windows arm64 and Linux arm64** packages aren't built yet: the native modules would need cross-compilation
  or arm64 runners.
- **Native module rebuilds** for Electron couldn't be exercised in this development environment (the Electron
  headers download is blocked by its network proxy); the packaged-app smoke test used modules built for Node.
  CI runners have normal network access.
