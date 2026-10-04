# Releasing

Releases are built by [`.github/workflows/release.yml`](../.github/workflows/release.yml) when a version tag is
pushed. Packaging is configured in [`apps/desktop/electron-builder.config.cjs`](../apps/desktop/electron-builder.config.cjs).

## Cutting a release

1. Set the same version in `package.json`, `apps/desktop/package.json` and `apps/server/package.json`
   (for example `1.1.0`, or `1.1.0-beta.1` for the beta channel).
2. Commit, then tag and push: `git tag v1.1.0 && git push origin v1.1.0`. The workflow refuses a tag that doesn't
   match the desktop version.
3. The workflow runs the unit tests and builds on macOS, Windows and Linux. Each job uploads its installers and
   update metadata (`latest.yml`, `latest-mac.yml`, `latest-linux.yml`) to a **draft** GitHub release, and the
   sync server image is pushed to `ghcr.io/<owner>/chh-server:<version>`.
4. Check the draft: install it on each platform and write release notes (they are shown in the app's update
   dialog). Mark beta versions as pre-releases.
5. **Publish** the draft. Installed apps on the stable channel see the update on their next check (at most six hours
   later, or immediately with Settings → Updates → Check for updates). Beta-channel apps also see pre-releases.

Without signing secrets the workflow still succeeds and produces **unsigned** packages. That's fine for testing,
but don't publish unsigned Windows or macOS builds: Windows SmartScreen warns about them, macOS Gatekeeper blocks
them, and macOS can't install updates for an unsigned app.

## Artifacts

| Platform | Installers | Updates via |
|---|---|---|
| Windows (x64) | `chh-<v>-win-x64.exe` (NSIS, per-user, installation directory can be changed) | NSIS, differential downloads |
| macOS (Intel and Apple silicon) | `chh-<v>-mac-<arch>.dmg` | `chh-<v>-mac-<arch>.zip` (Squirrel.Mac) |
| Linux (x64) | `.AppImage`, `.deb`, `.rpm` | AppImage replaces itself; `.deb`/`.rpm` are downloaded and installed with `pkexec` |

## Signing credentials

Store these as **repository secrets** (Settings → Secrets and variables → Actions). Every one of them is optional;
each platform signs only when its credentials are present.

### macOS: Developer ID + notarization

| Secret | Value |
|---|---|
| `MAC_CSC_LINK` | Your *Developer ID Application* certificate and private key exported as `.p12`, base64-encoded (`base64 -i cert.p12`) |
| `MAC_CSC_KEY_PASSWORD` | The `.p12` export password |
| `APPLE_API_KEY_P8` | Contents of an App Store Connect API key (`AuthKey_XXXX.p8`) with the Developer role |
| `APPLE_API_KEY_ID` | That key's ID |
| `APPLE_API_ISSUER` | Your App Store Connect issuer ID |

The app is built with the hardened runtime and the entitlements in `apps/desktop/build/entitlements.mac.plist`
(JIT for V8, USB/serial devices), signed, then notarized and stapled by electron-builder. An Apple ID with an
app-specific password (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) works too if you prefer.

### Windows: Azure Trusted Signing (recommended) or a certificate

Azure Trusted Signing (Artifact Signing) needs no hardware token:

| Secret | Value |
|---|---|
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | An app registration with the *Trusted Signing Certificate Profile Signer* role |
| `AZURE_SIGNING_ENDPOINT` | e.g. `https://weu.codesigning.azure.net` |
| `AZURE_SIGNING_ACCOUNT` | The signing account name |
| `AZURE_SIGNING_PROFILE` | The certificate profile name |

Alternatively use a code-signing certificate file: `WIN_CSC_LINK` (base64 `.pfx`) and `WIN_CSC_KEY_PASSWORD`.
EV certificates that live on a hardware token can't be used from hosted runners; use Trusted Signing or a
self-hosted runner instead.

Set the repository **variable** (not secret) `WIN_PUBLISHER_NAME` to the certificate subject's common name
(e.g. `Jane Doe` or `Example Ltd`). It's embedded in the app, and the updater then refuses to install any update
that isn't signed by that publisher.

### Linux

Linux packages aren't code-signed. Updates are verified against the SHA-512 hashes in `latest-linux.yml`,
which comes from the same GitHub release over HTTPS.

## What the build hardens

Release builds set these Electron fuses: `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off,
`EnableNodeCliInspectArguments` off, `EnableEmbeddedAsarIntegrityValidation` on, `OnlyLoadAppFromAsar` on and
`EnableCookieEncryption` on. So the shipped binary can't be repurposed as a Node.js interpreter, can't be
debugged through command-line flags, and only runs its own integrity-checked `app.asar`.

## Building packages locally

```bash
pnpm --filter @chh/desktop package          # installers for the current OS, unsigned unless credentials are set
pnpm --filter @chh/desktop exec electron-builder --config electron-builder.config.cjs --linux dir   # quick unpacked build
```

Output goes to `apps/desktop/release/<version>/`. The first build downloads Electron and the headers needed to
rebuild native modules (node-pty, SQLite, sodium, serialport) for Electron.

## Publishing somewhere other than GitHub

Set `CHH_RELEASE_REPO=owner/repo` to publish to another GitHub repository. For a self-hosted update server,
change `publish` in `electron-builder.config.cjs` to a `generic` provider with your URL and upload the files from
`release/<version>/` (including the `latest*.yml` files) there.
