# Security

This document describes how cy-ssh protects data **as of Phase 1**, and what later phases add. The full
cryptographic design for sync and team vaults is in [ARCHITECTURE.md §5–6](ARCHITECTURE.md#5-encryption-design).

## What we protect

| Asset | Where it lives | Protection |
|---|---|---|
| Hosts, groups, tags, notes, known hosts, settings | `cy-ssh.db` | Whole-database encryption (SQLite3 Multiple Ciphers, ChaCha20-Poly1305) |
| Saved passwords | Inside item JSON in `cy-ssh.db` | **Also** sealed with the vault key (XChaCha20-Poly1305) and bound to the item ID and field name |
| Database key | `db.key` | Wrapped by the OS keychain via Electron `safeStorage` (Keychain / DPAPI / libsecret) |
| Vault key | `vaults` table | Wrapped by a subkey derived from the database key, with the vault ID as associated data |
| Private keys in `~/.ssh` | Your filesystem | Read on demand by the session host and never copied into the database (key import arrives in Phase 2) |

## Process isolation

- The **renderer** (UI) runs sandboxed with context isolation and no Node.js. It never receives passwords or
  private keys: host objects only carry `hasPassword: boolean`. Prompts the user answers (passwords,
  keyboard-interactive answers) go straight to the main process.
- The **main process** decrypts a saved password only when a connection starts, then hands it to the
  **session host** (a separate utility process) for that connection only.
- Every IPC call is checked against the app's own top-level frame and validated with zod. Errors cross IPC only as
  an i18n key, never as stack traces.
- Navigation, new windows and all web permissions are denied, except clipboard access for terminal copy/paste.
  External links open only through `http(s)` and the OS browser. Production builds ship a strict
  Content-Security-Policy.

## Host key verification

- The first connection to a host shows its SHA-256 fingerprint for the user to verify. "Trust and connect" saves
  the key. "Connect once" doesn't.
- If a host presents a **different key of the same type**, the app shows a "host key has changed" warning with
  both fingerprints, and **Disconnect** is the default action.
- If a host offers a new key type while a different type is already trusted, the app prompts again and mentions
  the known type.
- Keys are stored per `host` / `[host]:port`, so non-default ports are tracked separately (OpenSSH convention).

## Logging

- Logs are written to `logs/main.log` with pino.
- Every path that could hold a secret (`password`, `passphrase`, `privateKey`, `token`, `responses`, …) is
  redacted before it reaches the file.
- Terminal input and output are never logged.
- Error logging records only name, code and message.

## Known limitations (Phase 1)

1. **No keyring on Linux:** on headless Linux or minimal window managers there may be no Secret Service. The app
   warns once, then stores the database key only obfuscated, in a 0600 file. Anyone who can read your home
   directory can then decrypt the database. Phase 4 adds a **master-password lock** that encrypts this key with
   an Argon2id-derived key.
2. **No app lock yet:** while you're logged in to the OS, the app opens without a prompt. Touch ID / Windows Hello /
   master-password lock come in Phase 4.
3. **Key material in memory:** libsodium's guarded memory (`sodium_malloc`) can't be used inside Electron (its V8
   memory cage forbids external buffers). Keys live in ordinary buffers and are zeroed (`sodium_memzero`) when they
   are no longer needed. Strings passed to `ssh2` (passwords) can't be wiped by JavaScript.
4. **Encrypted-key passphrases:** passphrase-protected `~/.ssh` keys aren't prompted for yet. They're skipped, and
   the system agent covers them. Phase 2's key manager adds passphrase prompts.
5. **No post-quantum key exchange:** `ssh2` doesn't implement `mlkem768x25519-sha256` or `sntrup761x25519`. The
   default KEX is `curve25519-sha256` (see risk R6 in the architecture doc).

## Reporting a vulnerability

Please report vulnerabilities privately to the maintainers instead of opening a public issue. A security contact
will be published before the first public release.
