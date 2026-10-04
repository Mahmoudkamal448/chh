# chh

A free, open, cross-platform SSH client and terminal manager for **Windows, macOS and Linux**, built from a single
Electron + TypeScript codebase.

Every feature is free for everyone: there are no plans, trials, device limits or license checks. Sync is optional
and self-hostable ([guide](docs/SELF_HOSTING.md)), and the app works fully offline without an account.

> **Status: all 6 phases complete (v1.0.0).** Phase 6 added shared team vaults with an audit log, signed installers
> and automatic updates, and renamed the project from *cy-ssh* to **chh** ([upgrade notes](docs/PHASE-6.md#upgrading-from-cy-ssh)).

## Features

- **Host manager:** create, edit, duplicate and delete hosts. Organize them with nested **groups** (settings are
  inherited down the tree), **tags** and **favorites**. Search instantly, and the list stays smooth with 10,000+ hosts.
- **SSH sessions:** pick how each host logs in (**Password**, **Key**, **Certificate**, **SSH agent**,
  **Identity**, **Ask every time**, or **Automatic**, which tries them all) in the host editor's Authentication
  section; keyboard-interactive login and a password prompt (with an optional "remember password" box) still work.
- **Host key verification:** you confirm a host's fingerprint the first time you connect. If the key ever changes,
  you get a **loud warning** that shows the previous and new fingerprints.
- **Keys:** generate ED25519/ECDSA/RSA keys; import OpenSSH, PEM/PKCS#8 and **PuTTY .ppk (v2 and v3)**, including
  encrypted ones; copy the public key; export the private key, optionally re-encrypted with a passphrase.
- **Identities:** reusable username + password/key bundles that you can link to hosts or whole groups.
- **SSH certificates:** attach an OpenSSH user certificate (`…-cert.pub`) to a key, from the Keys screen or right
  in the identity and host editors; chh shows who it's valid for and when it expires, presents it whenever the key is
  used (also on jump hosts), and picks it up automatically when importing a key or `~/.ssh/config`.
- **Known hosts manager:** review and remove trusted host keys, and import `~/.ssh/known_hosts` (including hashed
  entries).
- **SFTP file browser:** dual pane (this computer or any host on either side), drag and drop between panes and
  from your desktop, recursive transfers with progress, cancel and conflict handling, plus rename, delete, new
  folder and a permissions editor.
- **Jump hosts and proxies:** multi-hop chains (each hop with its own login), SOCKS4/5 and HTTP CONNECT proxies,
  **agent forwarding**, Pageant support, and per-host/group **environment variables**.
- **Serial ports** (baud, parity, stop bits, flow control), and **FIDO2 security keys** via the System OpenSSH engine.
- **Run snippets on many hosts** in parallel with per-host output and exit codes.
- **Autocomplete** from history and snippets (ghost text, Ctrl+Space), plus optional AI suggestions from any
  OpenAI-compatible endpoint (off by default, local models supported).
- **Cloud import** from AWS EC2 and DigitalOcean (re-import updates changed IPs); automatic **OS detection** with icons.
- **Split view:** split any terminal tab right/down, resize by dragging, move focus between panes.
- **Mosh and Telnet** hosts alongside SSH (Mosh on Windows runs through WSL).
- **Port forwarding:** local, remote and dynamic (SOCKS) rules with start/stop, auto-start and live stats.
- **Snippets** with `{{placeholders}}`, run from a side panel, the palette or the Snippets screen.
- **Command history** across all sessions, searchable, with no shell setup needed; it can be turned off per host.
- **ssh_config import/export**, including Include, wildcards, keys and forwards.
- **Local terminals:** bash, zsh, fish (macOS/Linux); PowerShell 7, Windows PowerShell, cmd, WSL and Git Bash (Windows).
- **Tabs:** with connection status, reconnect, and a find-in-terminal bar.
- **Terminal appearance:** 12 built-in color schemes with a visual picker, app-wide defaults with per-group/host
  overrides, applied live.
- **Keyboard-first:** a command palette and rebindable shortcuts.
- **Light and dark UI** (or match the system theme), with all strings in i18n files.
- **End-to-end encrypted sync** across unlimited devices via your own server (Docker Compose included): offline-first,
  field-level conflict merging, live updates, recovery key, **two-factor authentication**.
- **Team vaults:** share hosts, identities, keys and snippets with other people, end-to-end encrypted. Invite by
  email, confirm members by comparing key fingerprints, owner/admin/editor/viewer roles, automatic key rotation when
  someone is removed, and an **audit log** of who did what from which device.
- **Signed installers and automatic updates** for Windows (NSIS), macOS (DMG, notarized) and Linux (AppImage, deb,
  rpm), with stable and beta channels.
- **App lock:** passcode with Touch ID / Windows Hello, auto-lock on idle or sleep, and an optional **master
  password** that encrypts all local data at rest.
- **Encrypted at rest:** the whole local database is encrypted, its key is protected by the OS keychain, and
  passwords are sealed a second time inside it.

## Quick start

Installers are published on the [releases page](https://github.com/mahmoudkamal448/chh/releases); see the
**[installation guide](docs/INSTALL.md)** for Windows, macOS and Linux (including unsigned builds). To build from
source you need **Node.js 22.12+** and **pnpm** (via Corepack), plus a C/C++ toolchain for native modules
([details](docs/DEVELOPMENT.md#prerequisites)).

```bash
corepack enable
pnpm install
pnpm dev          # run the app with hot reload
```

Other commands:

| Command | What it does |
|---|---|
| `pnpm dev` | Start the app in development mode (HMR for the renderer, auto-restart for main) |
| `pnpm build` | Production build into `apps/desktop/out` |
| `pnpm typecheck` | Type-check every package |
| `pnpm test` | Unit tests (crypto, sync primitives, data layer, IPC contract, …) |
| `pnpm test:e2e` | Build, then run Playwright end-to-end tests against the real app |
| `pnpm --filter @chh/desktop package` | Build installers for the current OS (signed when credentials are set, see [Releasing](docs/RELEASING.md)) |

## Keyboard shortcuts (defaults)

| Action | macOS | Windows / Linux |
|---|---|---|
| Command palette | ⌘K | Ctrl+Shift+K |
| New local terminal | ⌘T | Ctrl+Shift+T |
| Close tab | ⌘W | Ctrl+Shift+W |
| Next / previous tab | ⌃Tab / ⌃⇧Tab | Ctrl+Tab / Ctrl+Shift+Tab |
| Go to hosts | ⌘1 | Alt+1 |
| New host | ⌘N | Ctrl+Shift+N |
| Search hosts / find in terminal | ⌘F | Ctrl+Shift+F |
| Copy / paste in terminal | ⌘C / ⌘V | Ctrl+Shift+C / Ctrl+Shift+V |
| Settings | ⌘, | Ctrl+, |
| Split right / down | ⌘D / ⌘⇧D | Ctrl+Shift+D / Ctrl+Shift+E |
| Next / previous pane | ⌘] / ⌘[ | Ctrl+Shift+] / Ctrl+Shift+[ |
| Snippets & history panel | ⌘⇧S | Ctrl+Shift+S |
| Lock chh | ⌘⇧L | Ctrl+Shift+L |

Shortcuts that would clash with shell keys (Ctrl+W, Ctrl+T, Ctrl+C…) use Ctrl+Shift on Windows and Linux, so the
terminal still gets the plain key. You can rebind everything in **Settings → Keyboard shortcuts**.

In the host list: ↑/↓, PgUp/PgDn, Home/End to move, **Enter** to connect, **F2** to edit, **Delete** to delete.

## Repository layout

```
apps/desktop/          Electron app (main process, session host, preload, React renderer)
apps/server/           Self-hostable sync server (Fastify + PostgreSQL)
deploy/                Docker Compose (server + Postgres + optional Caddy TLS)
packages/shared/       Models, zod schemas, typed IPC contract, i18n strings
packages/sync-core/    Hybrid logical clocks, version vectors, field-level merge
packages/vault-crypto/ libsodium wrappers: XChaCha20-Poly1305, KDF, key wrapping
packages/key-formats/  OpenSSH / PEM / PKCS#8 / PuTTY key parsing and writing, known_hosts
packages/ssh-config/   ssh_config(5) parsing, OpenSSH-accurate resolution, writing
docs/                  Architecture, development, security and phase notes
```

## Documentation

- [Installation](docs/INSTALL.md): get and install chh on Windows, macOS and Linux
- [Architecture](docs/ARCHITECTURE.md): process model, IPC, data model, encryption and sync design
- [Development guide](docs/DEVELOPMENT.md): setup per OS, testing, debugging, troubleshooting
- [Security](docs/SECURITY.md): threat model and how data is protected today
- [Self-hosting](docs/SELF_HOSTING.md): run your own sync server
- [Releasing](docs/RELEASING.md): cutting a release, code signing and notarization
- Phase notes: [Phase 1](docs/PHASE-1.md), [Phase 2](docs/PHASE-2.md), [Phase 3](docs/PHASE-3.md), [Phase 4](docs/PHASE-4.md), [Phase 5](docs/PHASE-5.md), [Phase 6](docs/PHASE-6.md) (what was built, files, how to test, platform differences)

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | App shell, host manager, SSH + local terminal, tabs | ✅ Done |
| 2 | Keys, identities, known-hosts manager, SFTP dual-pane browser | ✅ Done |
| 3 | Port forwarding, snippets, history, split view, Telnet, Mosh, ssh_config import/export | ✅ Done |
| 4 | Zero-knowledge vault, self-hostable sync server, multi-device sync, 2FA, app lock | ✅ Done |
| 5 | Jump hosts, proxies, agent forwarding, serial, FIDO2, env vars, multi-host snippets, autocomplete, AWS/DO import | ✅ Done |
| 6 | Shared team vault + audit log, signed installers, auto-update, rename to chh | ✅ Done |

## License

MIT (proposed; confirm before the first public release).
