# Phase 1: App shell, host manager, SSH + local terminal, tabs

**Status:** complete. 44 unit tests and 6 end-to-end tests pass on Linux (WSL2). Typecheck is clean.

## What works

| Area | Details |
|---|---|
| App shell | Hardened Electron window, single-instance lock, app menu, light/dark/system theme, i18n (English) |
| Host manager | Create/edit/duplicate/delete hosts. Nested groups with **inherited settings** (username, port, agent, default keys, keep-alive, timeout, theme, font). Tags, favorites, multi-term search over label/address/username/tags. Keyboard navigation and context menu. Virtualized list (10k hosts tested) |
| SSH | Auth order: system agent → default `~/.ssh` keys (unencrypted) → saved password (also answers PAM keyboard-interactive) → keyboard-interactive prompts → password prompt with up to 3 attempts and "remember password". Asks for the username when none is set or inherited. Keep-alives, connect timeout, friendly error messages |
| Host keys | TOFU dialog with SHA-256 fingerprint; changed-key warning showing both fingerprints; per-port entries |
| Local terminal | Detects available shells per OS; default is configurable in Settings; right-click **+** to pick one |
| Terminal | xterm.js with WebGL renderer (DOM fallback), fit, unicode11, web links (open in the OS browser), find bar, Ctrl+Shift+C/V copy/paste on Windows/Linux, native ⌘C/⌘V on macOS, back-pressure so floods can't freeze the UI |
| Tabs | Status dot, middle-click to close, reconnect bar on exit/error, Ctrl+Tab cycling |
| Productivity | Command palette (hosts + commands), configurable shortcuts with a recorder in Settings |
| Storage | Encrypted SQLite, OS keychain-wrapped key, sealed passwords, sync-ready item store (HLC clocks + version vectors + tombstones) |

## Files

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, .nvmrc, .gitignore
.github/workflows/ci.yml                     CI: typecheck, unit, build, E2E on Windows/macOS/Linux

packages/shared/src/
  brand.ts                                   product name / app id
  model/{common,settings,host,group,known-host,app-settings,session}.ts   zod models, settings inheritance
  ipc/contract.ts                            typed IPC contract + events + CyApi type
  i18n/en.json                               all UI strings
packages/shared/test/settings.test.ts

packages/sync-core/src/{hlc,version-vector,merge}.ts    HLC, version vectors, field-level LWW merge
packages/sync-core/test/sync-core.test.ts               incl. fast-check convergence property

packages/vault-crypto/src/index.ts           XChaCha20-Poly1305 AEAD, KDF subkeys, key wrap, sealed strings
packages/vault-crypto/test/vault-crypto.test.ts

apps/desktop/
  electron.vite.config.ts, electron-builder.yml, playwright.config.ts, vitest.config.ts, tsconfig.*.json
  build/entitlements.mac.plist
  src/main/
    index.ts                                 boot: keystore → DB → vault → repos → IPC → window
    window.ts                                hardened BrowserWindow, trusted-sender check
    env.ts, log.ts                           flags; pino with secret redaction
    secrets/local-key.ts                     safeStorage-wrapped DB key (weak-keystore fallback)
    vault/local-vault.ts                     personal vault key, seal/open secrets
    db/{database,migrations,item-store,hosts-repo,groups-repo,known-hosts-repo,settings-repo}.ts
    ipc/{handle,handlers}.ts                 validated handler registration; all handlers
    sessions.ts                              session-host supervisor, prompt broker, known-hosts checks
    shells.ts                                local shell detection per OS
  src/session-host/
    index.ts                                 utilityProcess entry, per-session MessagePorts
    protocol.ts                              main ⇄ session-host messages
    flow.ts                                  back-pressure
    host-key.ts, ssh-keys.ts                 fingerprints; default keys + agent discovery
    transports/{types,ssh,local-pty}.ts
  src/preload/{index.ts,api.d.ts}            typed window.cy bridge
  src/renderer/
    main.tsx, i18n.ts, styles.css, index.html
    app/{App.tsx,commands.ts}                layout, global shortcuts, command dispatch
    components/{ui,Dialog,ConfirmDialog}.tsx
    features/hosts/{HostsView,HostList,Sidebar,HostEditor,GroupEditor,SettingsFields}.tsx
    features/terminal/{TerminalView.tsx,registry.ts}
    features/{tabs/TabBar,palette/CommandPalette,settings/SettingsDialog,prompts/Prompts}.tsx
    stores/{app,hosts,tabs,prompts}-store.ts
    themes/terminal-themes.ts                12 original color schemes
    lib/{keymap,errors,cn}.ts
  src/types/better-sqlite3-multiple-ciphers.d.ts
  tests/unit/{ipc-contract,session-host}.test.ts, tests/unit/main/data-layer.test.ts
  tests/e2e/{fixtures.ts,app.spec.ts}
```

## Run and test

```bash
corepack enable && pnpm install
pnpm dev                     # run the app
pnpm typecheck
pnpm test                    # 44 unit tests
pnpm test:e2e                # 6 Playwright tests (needs a display; use xvfb-run on headless Linux)
```

### Manual test checklist

1. **New host** → enter an address (e.g. a server you can reach) → leave the username empty → **Save**.
   Double-click it: you're asked for a username, then shown the host-key dialog.
2. Create a group with username `deploy` and put a host in it. The host editor shows "Inherit" placeholders, and
   connecting uses `deploy`.
3. Wrong password → "That didn't work" → right password with **Remember** ticked. A key icon appears on the host
   row.
4. Press `Ctrl+Shift+K` (⌘K) and type part of a host name, then Enter to connect.
5. Press `Ctrl+Shift+T` (⌘T) for a local shell, then run `yes | head -c 50000000`. The UI stays responsive.
6. Settings → rebind "New local terminal" and check that the palette shows the new keys.

## Platform differences

| | Windows | macOS | Linux |
|---|---|---|---|
| Default local shell | PowerShell 7 if installed, else Windows PowerShell; also cmd, WSL, Git Bash | `$SHELL` (zsh), started as a login shell | `$SHELL` (bash/zsh/fish) |
| PTY backend | ConPTY | forkpty | forkpty |
| SSH agent | `SSH_AUTH_SOCK` or the OpenSSH agent pipe | `SSH_AUTH_SOCK` (launchd agent) | `SSH_AUTH_SOCK` |
| DB key protection | DPAPI | Keychain | libsecret/KWallet; one-time warning + weak fallback if absent |
| Shortcuts | Ctrl+Shift+… | ⌘… | Ctrl+Shift+… |
| Copy/paste in terminal | Ctrl+Shift+C/V | ⌘C/⌘V (native menu) | Ctrl+Shift+C/V |

## Deviations from the architecture draft

- **Host search** uses indexed generated columns and `LIKE` rather than FTS5. It comfortably handles 10k hosts (a unit
  test enforces a time budget) and supports substring matching. FTS5 can be added later if history search needs it.
- **Unit tests run in plain Node**, not through Electron, because every native module is N-API.
- **`sodium_malloc` isn't used**. Electron forbids external ArrayBuffers, so keys use zeroed ordinary buffers
  (see SECURITY.md).
- Split view, terminal theme management UI and the known-hosts manager screen are scheduled for Phases 2–3 as
  planned. Per-host themes and fonts already work through host and group settings.

## Known limitations

- Passphrase-protected default keys are skipped (use the agent until Phase 2's key manager).
- No OS detection icons yet: all hosts show a generic server icon (Phase 5's cloud/OS detection fills `osHint`).
- Packaging works for the current OS (`package` script), but signing, notarization and auto-update are Phase 6.
- The renderer bundle is about 2 MB, unoptimized. Code-splitting will come once SFTP and other heavy screens
  land.
