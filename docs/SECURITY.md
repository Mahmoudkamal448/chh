# Security

This document describes how cy-ssh protects data **as of Phase 3**, and what later phases add. The full
cryptographic design for sync and team vaults is in [ARCHITECTURE.md §5–6](ARCHITECTURE.md#5-encryption-design).

## What we protect

| Asset | Where it lives | Protection |
|---|---|---|
| Hosts, groups, tags, notes, known hosts, settings | `cy-ssh.db` | Whole-database encryption (SQLite3 Multiple Ciphers, ChaCha20-Poly1305) |
| Saved passwords | Inside item JSON in `cy-ssh.db` | **Also** sealed with the vault key (XChaCha20-Poly1305) and bound to the item ID and field name |
| Database key | `db.key` | Wrapped by the OS keychain via Electron `safeStorage` (Keychain / DPAPI / libsecret) |
| Vault key | `vaults` table | Wrapped by a subkey derived from the database key, with the vault ID as associated data |
| Keys in the keychain | Inside item JSON in `cy-ssh.db` | The private key is stored as an **unencrypted OpenSSH key sealed with the vault key** (on top of whole-database encryption). The import passphrase is used once and isn't stored |
| Identity passwords | Inside item JSON | Sealed with the vault key, like host passwords |
| Private keys in `~/.ssh` | Your filesystem | Read on demand by the session host and never copied into the database unless you import them |

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

## Keys

- The renderer only sees public data: public key line, fingerprint, type and label. Private keys are decrypted
  in the main process just before connecting and passed to the session host for that connection.
- When you import from a file, main reads it after a native file dialog. The file content never passes
  through the renderer. (Pasted keys necessarily do, since you typed or pasted them there.)
- Exports go through a native save dialog with mode `0600`. The app warns when you export without a
  passphrase. With a passphrase, it uses aes256-ctr + bcrypt-pbkdf (16 rounds), the same as `ssh-keygen`.
- PuTTY files are MAC-verified before use, so a modified `.ppk` is rejected.
- DSA keys aren't supported (they're obsolete and insecure).

## File transfers

- File operations run in the session host, against the local disk or an SFTP session that belongs to the
  requesting window. Main rejects calls that name another window's session.
- A cancelled transfer deletes the partially written destination file.

## Phase 3 features

- **Telnet is unencrypted.** The host editor says so when Telnet is selected, and saved passwords are never
  sent automatically over Telnet.
- **Mosh:** authentication and host-key verification happen over SSH exactly as for SSH hosts. The session key
  (`MOSH_KEY`) is passed only through the mosh-client process environment and is never logged.
- **Port forwarding** binds to `127.0.0.1` by default. Any other listen address shows a warning, because other
  machines could then use the tunnel. The SOCKS proxy accepts only CONNECT and has no authentication, so keep
  it on loopback.
- **Command history** lives only in the encrypted local database and never leaves the device. It can be
  disabled globally or per host/group (e.g. for production servers), and non-echoed input such as passwords
  isn't captured (see PHASE-3.md).
- **ssh_config import** reads your config and the files it Includes (max 256 files, 1 MB each). Paths never
  round-trip through the renderer; a preview token refers to data held in the main process. Export goes
  through a save dialog and never overwrites `~/.ssh/config` without the OS confirming.

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
4. **Default-key passphrases** are asked for on each connection (they aren't cached). Import the key into the
   keychain to avoid repeated prompts.
5. **No post-quantum key exchange:** `ssh2` doesn't implement `mlkem768x25519-sha256` or `sntrup761x25519`. The
   default KEX is `curve25519-sha256` (see risk R6 in the architecture doc).

## Reporting a vulnerability

Please report vulnerabilities privately to the maintainers instead of opening a public issue. A security contact
will be published before the first public release.
