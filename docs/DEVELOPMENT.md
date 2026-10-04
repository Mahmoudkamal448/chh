# Development guide

## Prerequisites

| | Windows | macOS | Linux |
|---|---|---|---|
| Node.js | 22.12+ (`.nvmrc`) | 22.12+ | 22.12+ |
| pnpm | `corepack enable` | `corepack enable` | `corepack enable` |
| C/C++ toolchain | Visual Studio Build Tools 2022 ("Desktop development with C++") + Python 3 | Xcode Command Line Tools (`xcode-select --install`) | `build-essential python3` (Debian/Ubuntu) or `gcc-c++ make python3` (Fedora) |
| Keyring (recommended) | built in (DPAPI) | built in (Keychain) | GNOME Keyring or KWallet running and unlocked |

Native modules:

| Module | Purpose | Build notes |
|---|---|---|
| `better-sqlite3-multiple-ciphers` | Encrypted SQLite | N-API prebuilds for all platforms, so the same binary works in Node and Electron |
| `sodium-native` | libsodium | N-API prebuilds |
| `node-pty` | Local terminals | Prebuilds for Windows/macOS; **compiled on Linux** at install time |
| `ssh2` (optional `cpu-features`, crypto binding) | SSH | Optional native speed-ups; it falls back to pure JS if they fail to build |

`pnpm-workspace.yaml` lists the packages whose install scripts are allowed to run (`allowBuilds`). It also sets
`nodeLinker: hoisted`, because electron-builder and native modules expect a flat `node_modules`.

If Electron reports a `NODE_MODULE_VERSION` mismatch after upgrading Electron, run `pnpm rebuild:electron`.

## Everyday commands

```bash
pnpm install
pnpm dev                 # app with HMR; main/preload rebuild and restart automatically
pnpm typecheck
pnpm test                # all unit tests (sequential across packages)
pnpm test:e2e            # production build + Playwright E2E
pnpm build               # production build → apps/desktop/out
pnpm --filter @cy-ssh/desktop package   # installer for the current OS → apps/desktop/release
```

Run one package's tests: `pnpm --filter @cy-ssh/sync-core test`. Run one E2E test:
`pnpm --filter @cy-ssh/desktop exec playwright test -g "host key"`.

## How the app is wired

The full design is in [ARCHITECTURE.md](ARCHITECTURE.md). The short version:

- **`src/main`** owns the database, secrets, IPC handlers and windows. Every renderer call goes through
  `registerHandlers()` in `ipc/handle.ts`, which checks the sender, validates the input with zod and reduces errors
  to `{ code, messageKey }`.
- **`src/session-host`** is an Electron `utilityProcess` that owns every live connection. Terminal bytes flow
  **renderer ⇄ session host** over a per-session `MessagePort`. The main process only brokers host-key and
  password prompts.
- **`src/preload`** exposes a typed `window.cy` API that is generated from `packages/shared/src/ipc/contract.ts`.
- **`src/renderer`** is the React UI (zustand stores, Radix primitives, Tailwind v4, xterm.js).

### Adding an IPC method

1. Add it to `contract` in `packages/shared/src/ipc/contract.ts` with input and output zod schemas.
2. Implement it in `apps/desktop/src/main/ipc/handlers.ts`. TypeScript fails the build until you do.
3. Call it from the renderer as `window.cy.<namespace>.<method>(input)`. It is fully typed and needs no preload
   changes.

### Adding a UI string

Add it to `packages/shared/src/i18n/en.json` and use `t('section.key')`. Never hard-code user-facing text.

### Adding a synced entity type

Store it through `ItemStore` (`src/main/db/item-store.ts`). Every write stamps per-field HLC clocks and a version
vector, so Phase 4 sync picks it up with no schema change. Add generated columns plus indexes in a **new**
migration if you need to query by a field.

## Sync server

```bash
STORE=memory SERVER_SECRET=$(openssl rand -base64 32) pnpm --filter @cy-ssh/server dev   # http://127.0.0.1:8080
pnpm --filter @cy-ssh/server test                                                       # memory store
TEST_DATABASE_URL=postgres://… pnpm --filter @cy-ssh/server test                         # + real Postgres
docker build -f apps/server/Dockerfile -t cy-ssh-server .
```

To try sync between two app instances on one machine, start the second with a separate profile:
`CY_SSH_USER_DATA=/tmp/cy2 pnpm dev`.

## Environment variables

| Variable | Effect |
|---|---|
| `CY_SSH_USER_DATA=/path` | Use a different user-data directory (isolated profiles, E2E tests, portable installs) |
| `CY_SSH_TEST=1` | Test mode: enables `dev.seedHosts` and a read-only terminal-text hook for E2E |
| `CY_SSH_ALLOW_WEAK_KEYSTORE=1` | Skip the "no keyring" confirmation dialog (CI only) |

## Data locations

| OS | User data |
|---|---|
| Windows | `%APPDATA%\cy-ssh` |
| macOS | `~/Library/Application Support/cy-ssh` |
| Linux | `~/.config/cy-ssh` |

The directory contains:

- `cy-ssh.db` (+ `-wal`/`-shm`): the encrypted database
- `db.key`: the database key, wrapped by the OS keychain
- `logs/main.log`: the log, with secrets redacted

Deleting the directory resets the app.

## Testing

- **Unit tests (Vitest)** run under plain Node. All native modules are N-API, so no Electron runtime is needed.
  Coverage:
  - `vault-crypto`: round trips, tampering, wrong key/AD, key wrapping
  - `sync-core`: HLC monotonicity, version vectors, and a fast-check property test that concurrent edits
    converge in any merge order
  - Desktop data layer: on-disk encryption, password sealing, search and filters, group cycles, known-hosts
    verdicts, sync metadata, 10k-host performance
  - IPC contract validation
  - Session-host helpers: fingerprints, flow control, error mapping
- **Test SSH server:** `apps/desktop/tests/support/ssh-server.ts` is an in-process `ssh2` server with password and
  public-key auth, a fake shell, and a real SFTP subsystem backed by a temp directory. Unit and E2E tests share
  it, so no Docker or sshd is needed.
- **Telnet test server:** `tests/support/telnet-server.ts` negotiates NAWS/TTYPE/ECHO/SGA and echoes lines.
- **Mosh:** with `allowMosh`, the test SSH server runs `mosh-server` locally on `exec`, so Mosh is tested end to
  end with the real `mosh-client`. Install `mosh` to run that test; it's skipped otherwise.
- **Key fixtures:** `packages/key-formats/test/fixtures` holds throwaway keys made by `ssh-keygen`, `puttygen`
  (`apt install putty-tools`) and `openssl`. Regenerate them only if you add formats. The tests compare against
  each tool's own output, not against round trips of our code.
- **E2E tests (Playwright `_electron`)** launch the built app with a throwaway profile. Coverage:
  - Local shell
  - SSH connect with host-key trust
  - Reconnect from the palette with no prompt
  - Changed-key warning
  - Password retry and "remember password"
  - 5,000-host list performance
  - Theme switching
  - Phase 2: key generation + key login, encrypted PuTTY import, identities, known-hosts removal, and the SFTP
    browser (F5 upload, drag-and-drop download, conflict prompt, mkdir, chmod, delete)
  - Phase 3: split panes, snippets with variables + side panel, history capture, Telnet, Mosh, port
    forwarding through a real tunnel, ssh_config import and export

## Platform notes and troubleshooting

| Situation | What to do |
|---|---|
| **Running as root on Linux** (containers, WSL as root) | Chromium refuses to start without `--no-sandbox`. The E2E fixtures add it automatically. For dev, run `pnpm --filter @cy-ssh/desktop exec electron-vite dev --noSandbox`. Don't ship or use `--no-sandbox` otherwise. |
| **WSL2** | WSLg provides a display, so the app and E2E tests run directly. There is usually no keyring, so the app warns once and stores the DB key with weak protection (see SECURITY.md). |
| **Linux without a keyring** | Install and unlock `gnome-keyring` or KWallet for OS-protected keys. Otherwise you'll see a one-time warning. |
| **Linux CI** | Run E2E under `xvfb-run` (see `.github/workflows/ci.yml`). |
| **Windows SSH agent** | The app uses `SSH_AUTH_SOCK` if it's set, otherwise the Windows OpenSSH agent pipe (`\\.\pipe\openssh-ssh-agent`). Start that service with `Get-Service ssh-agent \| Set-Service -StartupType Automatic; Start-Service ssh-agent`. Pageant support arrives with Phase 5's agent settings. |
| **macOS shells** | Local shells start as login shells (`-l`) so `/etc/zprofile` (path_helper) runs, like Terminal.app. |
| **Windows terminals** | Uses ConPTY (Windows 10 1809+). |
| **`pnpm install` says "Ignored build scripts"** | A new native dependency needs to be added to `allowBuilds` in `pnpm-workspace.yaml`. |
