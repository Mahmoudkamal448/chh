# Security

This document describes how chh protects data **as of Phase 6** (v1.0.0). The full
cryptographic design for sync and team vaults is in [ARCHITECTURE.md §5–6](ARCHITECTURE.md#5-encryption-design).

## What we protect

| Asset | Where it lives | Protection |
|---|---|---|
| Hosts, groups, tags, notes, known hosts, settings | `chh.db` | Whole-database encryption (SQLite3 Multiple Ciphers, ChaCha20-Poly1305) |
| Saved passwords | Inside item JSON in `chh.db` | **Also** sealed with the vault key (XChaCha20-Poly1305) and bound to the item ID and field name |
| Database key | `db.key` | Wrapped by the OS keychain via Electron `safeStorage` (Keychain / DPAPI / libsecret), **or** with a master password set, encrypted with an Argon2id-derived key (256 MiB, 3 passes) |
| Sync account secrets | `sync_account` table | Tokens and the account key are sealed with the vault key inside the encrypted database |
| Vault key | `vaults` table | Wrapped by a subkey derived from the database key, with the vault ID as associated data |
| Keys in the keychain | Inside item JSON in `chh.db` | The private key is stored as an **unencrypted OpenSSH key sealed with the vault key** (on top of whole-database encryption). The import passphrase is used once and isn't stored |
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

## Phase 5 features

- **Jump hosts:** every hop is authenticated and host-key-checked independently, with its own prompts. Credentials for
  one hop are never sent to another.
- **Proxy passwords** are asked for at connect time and never stored. SOCKS4 has no authentication; prefer SOCKS5
  or HTTP CONNECT over a trusted network path.
- **Agent forwarding** is off by default and labelled as risky: a compromised server can use your agent while
  you're connected (it can't extract the keys). Enable it only for servers you trust.
- **System OpenSSH engine:** that host is handled entirely by your `ssh` binary, with its own known_hosts and
  config. chh doesn't see its passwords.
- **Multi-host runs** use the same authentication and host-key checks as interactive sessions. Output stays in
  memory (not in history).
- **AI suggestions** are off by default and only run on request. The request contains the current command line,
  the host's OS, and (only if enabled) your last 10 commands on that host. Never passwords, keys, env vars or
  terminal output. HTTPS is required except for localhost. The API key is sealed with the vault key.
- **Cloud credentials** (AWS keys, DigitalOcean tokens) are used for one request and not stored. Use read-only
  credentials (`ec2:DescribeInstances`, a read-scoped DO token).
- **OS detection** runs one read-only command (`cat /etc/os-release; uname -s`) on a separate channel after login.

## Sync and the server

**Threat model:** the sync server, its database and its operator are untrusted for confidentiality. They
can't read hosts, credentials, keys, notes, snippets or forwarding rules. They can see email addresses, device
names and platforms, item counts, approximate sizes (padded to 256-byte buckets) and change timing.

| Secret | Where | Protection |
|---|---|---|
| Your password | Never leaves the device | Argon2id (256 MiB, 3 passes; the client refuses weaker parameters from a server) → master key |
| Auth key | Sent at sign-in | Derived from the master key; the server stores only an Argon2id hash of it |
| KEK | Never leaves the device | Derived from the master key; wraps the account key |
| Account key | Server stores it **wrapped** (KEK, and separately the recovery key) | XChaCha20-Poly1305, bound to the email |
| Vault key | Server stores it wrapped by the account key | Bound to the vault id |
| Items | Server stores ciphertext | XChaCha20-Poly1305 with associated data `vault|item` (no swapping or moving), padded |
| Recovery key | Shown once; never stored | Unwraps the account key; a derived recovery auth key (hashed server-side) proves possession for a reset |
| TOTP secret | Server | AES-256-GCM with a key derived from `SERVER_SECRET`; codes are single-use per 30 s step |

Further protections:

- **Rollback resistance:** version vectors let the client recognize an older version served by the server.
  It keeps its newer data and re-uploads it.
- **No account enumeration:** unknown emails get deterministic decoy KDF parameters, and login burns the same
  hashing time.
- **Token hygiene:** short-lived opaque access tokens, rotating refresh tokens (reusing an old one signs the
  device out), revocation on device removal, password change and recovery.
- **Transport:** HTTPS is required except for loopback and private-network addresses (where the UI warns).
  Redirects are refused.
- **Delete is real:** deleting the account removes all server data immediately.

What the server operator **can** do: deny service, delete your ciphertext, or withhold updates (devices then
diverge until it behaves). It can't forge items, because the AEAD would fail and the item would be skipped.

## Team vaults

**Threat model:** the same as for personal sync. The server can't read team names, items or secrets, and it
never holds a team key. It does see who belongs to which team, their roles, invites (by email), and the audit
log.

| Secret | Protection |
|---|---|
| Team key | Random 32 bytes made on the creator's device; stored on the server only as one `crypto_box_seal` copy per confirmed member (sealed to that member's X25519 public key) |
| Team items and their secrets | Same envelope as personal items, with the team key; secrets inside are sealed again, bound to vault, item and field |
| Team name | XChaCha20-Poly1305 with the team key, bound to the team id |
| Locally | Team keys are wrapped by a subkey of the database key, like the personal vault key |

- **Key substitution:** before sharing the key, an admin compares the member's public-key fingerprint
  (BLAKE2b-128 of the key, 32 hex digits) with the member through another channel. The app re-derives the
  fingerprint from the key it is about to seal to and refuses if it changed. This is the defence against a server
  that hands out its own key; skipping the comparison means trusting the server for that member.
- **Roles** are enforced by the server (writes need editor, membership changes need admin, deleting the team needs
  the owner) and mirrored in the app. Reading is protected by cryptography: only confirmed members hold the key.
- **Removal rotates the key.** The admin's device re-encrypts every item with a new key and seals it for the
  remaining members; the server applies this atomically and refuses pushes made with an older key generation.
  A removed member can't decrypt anything that changes afterwards. What they had already synced may remain on
  their devices (their app deletes it, a modified app wouldn't). When someone leaves on their own, admins are
  prompted to rotate.
- **Audit log:** every authenticated team action is recorded server-side with the actor, device and time, in an
  append-only table (a trigger rejects UPDATE, DELETE and TRUNCATE; you can also revoke those privileges from the
  server's database role). Events only the app can observe (connecting to a shared host, exporting a shared key)
  are reported by the app and labelled "reported by app": a modified client could omit them. The audit log is
  readable by team owners and admins, and by the server operator.
- **Leaving a team or signing out** removes that team's data from the device.

## Updates and release integrity

- Release builds are **code-signed** (Windows: Authenticode via Azure Trusted Signing or a certificate; macOS:
  Developer ID with the hardened runtime, notarized). See [RELEASING.md](RELEASING.md).
- The updater (electron-updater) downloads from the project's GitHub releases over HTTPS and checks every file
  against the SHA-512 in the release metadata. On Windows it additionally refuses an update not signed by the
  configured publisher; on macOS Squirrel only installs updates signed with the same Developer ID.
- Update checks send no account or usage data. They can be limited to manual checks, and
  `CHH_DISABLE_UPDATES=1` turns them off for managed installations.
- Release builds set Electron fuses that stop the binary from being used as a Node.js interpreter
  (`RunAsNode`, `NODE_OPTIONS`, `--inspect` disabled) and only load the integrity-checked `app.asar`.

## App lock

- **Lock screen** (passcode, Touch ID, Windows Hello): when locked, the main process rejects every IPC call
  except unlocking, so a compromised or buggy renderer can't read data behind the overlay. Terminal and forwarding
  sessions keep running. After 5 failed attempts, retries are delayed exponentially (up to 15 minutes).
- **Master password:** without it, the database key on disk is useless, even to someone with full access to your
  files and OS account. It's needed at every start. If it's forgotten, local data is unrecoverable (synced data can
  be restored by signing in again).
- A lock screen without a master password is a privacy screen: someone with access to your OS account and
  files could still use the OS-keychain-protected key. Use the master password for protection at rest.

## Known limitations

1. **No keyring on Linux:** without a Secret Service, the database key is only obfuscated, unless you set a master
   password (Settings → Security), which fixes this.
2. **Key material in memory:** libsodium's guarded memory (`sodium_malloc`) can't be used inside Electron (its V8
   memory cage forbids external buffers). Keys live in ordinary buffers and are zeroed (`sodium_memzero`) when no
   longer needed. Strings passed to `ssh2` (passwords) and decrypted sync payloads in JavaScript can't be wiped.
3. **Default-key passphrases** are asked for on each connection (they aren't cached). Import the key into the
   keychain to avoid repeated prompts.
4. **No post-quantum key exchange:** `ssh2` doesn't implement `mlkem768x25519-sha256` or `sntrup761x25519`. The
   default KEX is `curve25519-sha256` (see risk R6 in the architecture doc).
5. **Windows Hello** is implemented via PowerShell/WinRT and not yet verified on real hardware. The passcode
   fallback always works.
6. **Team metadata is visible to the server:** membership, roles, invite emails, item counts and timing, and the
   audit log. Only names, items and secrets are encrypted.
7. **Linux packages aren't code-signed;** updates rely on HTTPS and the SHA-512 hashes in the release metadata.

## Reporting a vulnerability

Please report vulnerabilities privately to the maintainers instead of opening a public issue. A security contact
will be published before the first public release.
