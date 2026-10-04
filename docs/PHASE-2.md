# Phase 2: keys, identities, known hosts, SFTP file browser

**Status:** complete. 85 unit tests and 10 end-to-end tests pass on Linux (WSL2). Typecheck is clean.

## What works

| Area | Details |
|---|---|
| **Keys** | Generate ED25519, ECDSA (256/384/521) or RSA (2048/3072/4096). Import OpenSSH, PEM (PKCS#1/SEC1), PKCS#8 (incl. encrypted) and **PuTTY .ppk v2 and v3** (Argon2id/i/d, aes256-cbc, MAC verified). Duplicate detection by fingerprint. Copy the public key; export the private key as OpenSSH, optionally re-encrypted (aes256-ctr + bcrypt, readable by `ssh-keygen`). Shows which hosts, groups and identities use each key. Deleting a key unlinks it everywhere |
| **Identities** | Reusable username + password and/or key. Link to a host or a whole group (inherited like any other setting) |
| **Auth order** | Host/identity key → system agent → `~/.ssh` default keys (encrypted ones now **prompt for the passphrase**, up to 3 tries, skippable) → saved password (host, then identity) → keyboard-interactive → password prompt |
| **Known hosts** | Screen listing every trusted host key with search, multi-select removal, and **import of `~/.ssh/known_hosts`**: plain, `[host]:port`, comma lists, wildcards/negation, and **hashed** (`\|1\|…`) entries all match on connect. `@revoked`/`@cert-authority` lines are skipped and counted |
| **SFTP browser** | Dual pane; each side is *This computer* or any host (switchable). Virtualized listings, breadcrumb/path entry, up/refresh, sort folders first |
| File operations | New folder (F7), rename (F2), delete (Del, recursive), **permissions editor** (rwx grid + octal, optional recursive), open folder (Enter/double-click), up (Backspace), multi-select (Ctrl/Shift-click, Ctrl+A, Shift+arrows) |
| Transfers | Copy to other side (F5 or context menu), **drag and drop between panes**, **drop files from the OS** into a pane, drag onto a folder row to target it, drag within a pane to move. Recursive folders, conflict prompt (Overwrite / Skip / Keep both), live progress + speed, cancel (partial file removed), 2 transfers in parallel, panes refresh when done. Works local⇄remote, remote⇄remote (different hosts) and local⇄local |
| Navigation | Home tab now has a rail: Hosts, Keys, Identities, Known hosts. "Open files (SFTP)" in the host context menu and "Browse files on …" in the command palette |

## New and changed files

```
packages/key-formats/                         NEW package
  src/{wire,types,build,openssh,ppk,pem,public,generate,known-hosts,index}.ts
  src/bcrypt-pbkdf.d.ts
  test/key-formats.test.ts                    26 tests against real ssh-keygen / puttygen / openssl output
  test/fixtures/                              throwaway test keys (README explains)

packages/shared/src/model/{key,identity,files}.ts         NEW models
packages/shared/src/model/{settings,known-host,session,index}.ts   identityId/keyId settings, passphrase prompts
packages/shared/src/ipc/contract.ts           keys, identities, knownHosts, sftp namespaces; transfer.update event
packages/shared/src/i18n/en.json              strings for all new screens

apps/desktop/src/main/
  db/{keys-repo,identities-repo}.ts           NEW
  db/known-hosts-repo.ts                      pattern/hashed matching, list/search/remove, import
  db/item-store.ts                            item types 'key' | 'identity'
  sessions.ts                                 identity/key resolution, SFTP sessions, RPC broker, transfer events
  ipc/handlers.ts, index.ts                   new handlers; file dialogs for key/known_hosts import and export
apps/desktop/src/session-host/
  ssh/{connect,keys}.ts                       shared connect + auth (moved from transports/ssh.ts and ssh-keys.ts)
  files/{provider,local-fs,sftp-fs,transfers}.ts   NEW filesystem providers and transfer engine
  transports/ssh.ts, protocol.ts, index.ts    shell uses connectSsh; RPC channel; SFTP endpoints
apps/desktop/src/preload/index.ts             pathForFile() for OS drag-and-drop
apps/desktop/src/renderer/
  features/home/HomeView.tsx                  section rail
  features/keys/{KeysView,GenerateKeyDialog,ImportKeyDialog,ExportKeyDialog}.tsx
  features/identities/IdentitiesView.tsx
  features/known-hosts/KnownHostsView.tsx
  features/sftp/{SftpView,FilePane,use-pane,PermissionsDialog,ConflictDialog,HostPicker}.tsx
  components/PromptDialog.tsx, lib/format.ts
  stores/{vault-store,transfers-store}.ts
  features/hosts/{SettingsFields,HostList,HostsView}.tsx, features/tabs/TabBar.tsx,
  features/palette/CommandPalette.tsx, features/prompts/Prompts.tsx, app/{App.tsx,commands.ts}
apps/desktop/tests/
  support/ssh-server.ts                       NEW reusable test server: password + publickey auth, shell, SFTP
  unit/main/keychain.test.ts, unit/sftp.test.ts
  e2e/phase2.spec.ts
```

## Run and test

```bash
pnpm install
pnpm dev
pnpm test        # 85 unit tests
pnpm test:e2e    # 10 Playwright tests
```

### Manual checklist

1. **Keys → Generate key** (ED25519). Copy the public key into `~/.ssh/authorized_keys` on a server.
   Edit that host → **Key** = your new key → connect: no password prompt.
2. **Keys → Import → From file…** pick a `.ppk` or an encrypted `id_ed25519`. Enter the passphrase once.
3. **Identities → New identity** with username + password. Set it on a **group**, and every host in the
   group uses it.
4. Remove a host from **Known hosts**. The next connection asks you to verify it again.
   **Import known_hosts…** pulls in your OpenSSH trust list (hashed entries included).
5. Right-click a host → **Open files (SFTP)**. Drag a folder from your desktop into the right pane. Press
   F5 on a remote file to download it into the left pane's folder. Right-click → **Permissions…**.
6. Start a large transfer and cancel it: the partial file is removed.

## Platform differences

| | Windows | macOS | Linux |
|---|---|---|---|
| Local pane root | Drive list (C:\, D:\, …) above each drive root | `/` | `/` |
| Local permissions | Not shown or editable (Windows ACLs aren't POSIX modes) | rwx | rwx |
| Drag files in from | Explorer | Finder | Files/Nautilus, Dolphin (XDND) |
| Key file dialogs | Open in `%USERPROFILE%\.ssh` | `~/.ssh` (hidden files shown) | `~/.ssh` (hidden files shown) |
| Exported key permissions | Normal file ACLs | `0600` | `0600` |

## Design notes and deviations

- **Imported keys are stored decrypted inside the vault.** Their passphrase is used once at import,
  and the key is then sealed with the vault key (plus whole-database encryption). Connecting never asks
  for it again. Export re-encrypts with a passphrase you choose.
- **Transfers use streams, not ssh2's `fastGet`/`fastPut`.** Streams can be cancelled instantly and
  behave the same across every provider pair. `fastGet`/`fastPut` are faster on high-latency links but can't
  be aborted. A pipelined, cancellable fast path is a good follow-up.
- **Dragging from a pane out to the OS** (e.g. remote file → desktop) isn't supported yet. Electron's
  `startDrag` needs a local file up front. Use F5 or drag to the local pane instead.
- Directory symlinks are skipped during recursive copies to avoid loops. File symlinks copy their target.
- Host-key checks against imported wildcard/hashed entries scan only those entries. Exact entries use
  the index.
- `putty-tools` was installed on the dev machine only to generate test fixtures. The app doesn't need it.
