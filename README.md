# cy-ssh

A free, open, cross-platform SSH client and terminal manager for **Windows, macOS and Linux**, built from a single
Electron + TypeScript codebase.

Every feature is free for everyone: there are no plans, trials, device limits or license checks. Sync (coming in
Phase 4) is optional and self-hostable, and the app works fully offline without an account.

> **Status: Phase 1 of 6 complete.** The host manager, SSH and local terminals, and tabs work today. See the
> [roadmap](#roadmap) for what comes next.

## Features (Phase 1)

- **Host manager:** create, edit, duplicate and delete hosts. Organize them with nested **groups** (settings are
  inherited down the tree), **tags** and **favorites**. Search instantly, and the list stays smooth with 10,000+ hosts.
- **SSH sessions:** authenticate with the system SSH agent, your default `~/.ssh` keys, a saved password,
  keyboard-interactive login or a password prompt (with an optional "remember password" box).
- **Host key verification:** you confirm a host's fingerprint the first time you connect. If the key ever changes,
  you get a **loud warning** that shows the previous and new fingerprints.
- **Local terminals:** bash, zsh, fish (macOS/Linux); PowerShell 7, Windows PowerShell, cmd, WSL and Git Bash (Windows).
- **Tabs:** with connection status, reconnect, and a find-in-terminal bar.
- **Per-host terminal appearance:** 12 built-in color schemes, plus font family, font size, cursor and scrollback.
- **Keyboard-first:** a command palette and rebindable shortcuts.
- **Light and dark UI** (or match the system theme), with all strings in i18n files.
- **Encrypted at rest:** the whole local database is encrypted, its key is protected by the OS keychain, and
  passwords are sealed a second time inside it.

## Quick start

Requirements: **Node.js 22.12+** and **pnpm** (via Corepack), plus a C/C++ toolchain for native modules
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
| `pnpm --filter @cy-ssh/desktop package` | Build an installer for the current OS (unsigned until Phase 6) |

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

Shortcuts that would clash with shell keys (Ctrl+W, Ctrl+T, Ctrl+C…) use Ctrl+Shift on Windows and Linux, so the
terminal still gets the plain key. You can rebind everything in **Settings → Keyboard shortcuts**.

In the host list: ↑/↓, PgUp/PgDn, Home/End to move, **Enter** to connect, **F2** to edit, **Delete** to delete.

## Repository layout

```
apps/desktop/          Electron app (main process, session host, preload, React renderer)
packages/shared/       Models, zod schemas, typed IPC contract, i18n strings
packages/sync-core/    Hybrid logical clocks, version vectors, field-level merge
packages/vault-crypto/ libsodium wrappers: XChaCha20-Poly1305, KDF, key wrapping
docs/                  Architecture, development, security and phase notes
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md): process model, IPC, data model, encryption and sync design
- [Development guide](docs/DEVELOPMENT.md): setup per OS, testing, debugging, troubleshooting
- [Security](docs/SECURITY.md): threat model and how data is protected today
- [Phase 1 notes](docs/PHASE-1.md): what was built, files, how to test, platform differences

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | App shell, host manager, SSH + local terminal, tabs | ✅ Done |
| 2 | Keys, identities, known-hosts manager, SFTP dual-pane browser | Next |
| 3 | Port forwarding, snippets, history, split view, Telnet, Mosh, ssh_config import/export | |
| 4 | Zero-knowledge vault, self-hostable sync server, multi-device sync, 2FA, app lock | |
| 5 | Jump hosts, proxies, agent forwarding, serial, FIDO2, env vars, multi-host snippets, autocomplete, AWS/DO import | |
| 6 | Shared team vault + audit log, signed installers, auto-update | |

## License

MIT (proposed; confirm before the first public release).
