# Installing chh

chh runs on **Windows 10/11 (x64)**, **macOS (Apple silicon and Intel)** and **Linux (x64)**. Every feature is free
and works offline; sync is optional ([self-hosting guide](SELF_HOSTING.md)).

- [1. Get an installer](#1-get-an-installer)
- [2. Windows](#2-windows)
- [3. macOS](#3-macos)
- [4. Linux](#4-linux)
- [5. After installing](#5-after-installing)

## 1. Get an installer

Pick whichever is easiest for you.

### A. Download a release

Open the [releases page](https://github.com/mahmoudkamal448/chh/releases) and download the file for your system:

| System | File |
|---|---|
| Windows | `chh-<version>-win-x64.exe` |
| macOS, Apple silicon (M1 and later) | `chh-<version>-mac-arm64.dmg` |
| macOS, Intel | `chh-<version>-mac-x64.dmg` |
| Linux, any distribution | `chh-<version>-linux-x86_64.AppImage` |
| Debian, Ubuntu, Mint, Pop!_OS | `chh-<version>-linux-amd64.deb` |
| Fedora, RHEL, openSUSE | `chh-<version>-linux-x86_64.rpm` |

Not sure which Mac you have? Apple menu → **About This Mac**: "Chip: Apple M…" means Apple silicon, "Processor:
Intel" means Intel.

### B. Let GitHub build it (no release published yet, or you want the latest `main`)

1. Open the repository's **Actions** tab → **Release** → **Run workflow** → branch `main` → **Run workflow**.
2. Wait for the run to finish (about 15–20 minutes). It builds all three systems on GitHub's machines.
3. Open the run and download the artifact for your system from **Artifacts**: `chh-windows-latest`,
   `chh-macos-latest` or `chh-ubuntu-latest`. Unzip it to get the files from the table above.

The same run also uploads everything to a **draft** release. Publishing that draft makes a download page for others
and lets installed apps update themselves (see [RELEASING.md](RELEASING.md)). Pushing a tag such as `v1.0.0` (it must
match the version in `apps/desktop/package.json`) runs the same workflow.

### C. Build it yourself

You need Node.js 22.12+, Git and a C/C++ toolchain:

| Windows | macOS | Linux |
|---|---|---|
| Visual Studio Build Tools 2022 with "Desktop development with C++", and Python 3 | Xcode Command Line Tools: `xcode-select --install` | Debian/Ubuntu: `sudo apt install build-essential python3` (add `rpm` to build `.rpm`); Fedora: `sudo dnf install gcc-c++ make python3 rpm-build` |

```bash
git clone https://github.com/mahmoudkamal448/chh.git
cd chh
corepack enable
pnpm install
pnpm --filter @chh/desktop package
```

The installers end up in `apps/desktop/release/<version>/`. Each system builds only its own installers: the
Windows `.exe` must be built on Windows and the macOS `.dmg` on a Mac (or use option B).

> Builds are **unsigned** unless signing credentials are configured ([RELEASING.md](RELEASING.md#signing-credentials)).
> That's fine for your own use; the sections below explain the one extra click each system asks for.

## 2. Windows

1. Run `chh-<version>-win-x64.exe`.
2. **Unsigned build:** if SmartScreen says "Windows protected your PC", click **More info** → **Run anyway**.
3. Follow the installer. It installs for your user only (no administrator rights needed), and you can change the
   folder.
4. Start **chh** from the Start menu or the desktop shortcut.

- **Updates:** signed release builds check for updates in the background (Settings → **Updates**).
- **Uninstall:** Settings → Apps → Installed apps → **chh** → Uninstall. Your data stays in `%APPDATA%\chh` until
  you delete that folder.
- Local terminals offer PowerShell 7, Windows PowerShell, cmd, WSL and Git Bash, whichever are installed.

## 3. macOS

1. Open the `.dmg` and drag **chh** into **Applications**.
2. Start chh from Applications or Launchpad.
3. **Unsigned build:** macOS blocks it the first time ("chh cannot be opened because the developer cannot be
   verified"). Either:
   - right-click (or Control-click) chh in Applications → **Open** → **Open**, or
   - open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to the chh message.

   If macOS instead says chh "is damaged and can't be opened", remove the download quarantine once:

   ```bash
   xattr -dr com.apple.quarantine /Applications/chh.app
   ```

- **Updates:** only signed and notarized builds can update themselves (Settings → **Updates** explains this on
  unsigned builds). For an unsigned build, install the new `.dmg` over the old app; your data is kept.
- **Uninstall:** drag chh from Applications to the Trash. Your data stays in
  `~/Library/Application Support/chh` until you delete it.
- Touch ID can unlock the app lock (Settings → **Security**).

## 4. Linux

### AppImage (any distribution)

```bash
chmod +x chh-*-linux-x86_64.AppImage
./chh-*-linux-x86_64.AppImage
```

AppImages need FUSE 2. If it doesn't start and mentions FUSE, install it: Ubuntu 24.04+ `sudo apt install
libfuse2t64`, older Ubuntu/Debian `sudo apt install libfuse2`, Fedora `sudo dnf install fuse fuse-libs`. The AppImage
updates itself in place.

### Debian, Ubuntu and derivatives (`.deb`)

```bash
sudo apt install ./chh-*-linux-amd64.deb
```

### Fedora, RHEL, openSUSE (`.rpm`)

```bash
sudo dnf install ./chh-*-linux-x86_64.rpm      # openSUSE: sudo zypper install ./chh-*-linux-x86_64.rpm
```

The `.deb` and `.rpm` add **chh** to your applications menu and can update themselves (they ask for your password
through `pkexec` when installing an update). Uninstall with `sudo apt remove chh` or `sudo dnf remove chh`.

### Keyring

chh encrypts its database and protects the key with your desktop's keyring (GNOME Keyring or KWallet). Make sure one
is running and unlocked; most desktops do this at login. Without one, chh asks before storing the key with weak
protection. In that case, set a **master password** (Settings → **Security**) to keep your data properly encrypted.

Your data lives in `~/.config/chh`.

## 5. After installing

1. Click **New host**, enter the address, username and a password or key, and connect. The first time, you confirm
   the server's fingerprint.
2. Already use SSH? **Import / export** on the Hosts screen reads `~/.ssh/config` (hosts, keys and port forwards).
3. Optional:
   - **Sync** across your devices and **team vaults**: run your own server ([SELF_HOSTING.md](SELF_HOSTING.md)),
     then Settings → **Sync & account**.
   - **App lock** and **master password**: Settings → **Security**.
   - **SSH certificates** (if your servers trust a certificate authority): see below.

### SSH certificates

If your organization signs SSH keys with a certificate authority, you log in with your key plus its certificate
(usually a file named like `id_ed25519-cert.pub` next to your key) instead of adding your key to every server.

1. Import the key: Keys → **Import**. A `…-cert.pub` file next to it is attached automatically, and so are
   `CertificateFile` entries when you import `~/.ssh/config`.
2. Otherwise add it yourself: select the key on the Keys screen, or choose it in an identity or host editor, then
   **Add certificate…** and paste the certificate or choose the file. chh checks that it belongs to that key.
3. Connect as usual. chh presents the certificate first and falls back to the plain key if a server doesn't trust
   the CA. The Keys screen shows who the certificate is valid for and when it expires (amber a week before, red once
   expired); ask your CA for a new one and use **Replace…**.

Administrators issue one with `ssh-keygen -s ca_key -I alice -n alice -V +52w id_ed25519.pub`, and servers trust
the CA with `TrustedUserCAKeys` in `sshd_config`.

**Coming from cy-ssh?** chh moves your data from the old `cy-ssh` folder automatically on first start. If you
didn't use a master password on macOS or Linux, read
[Upgrading from cy-ssh](PHASE-6.md#upgrading-from-cy-ssh) first.

| | Windows | macOS | Linux |
|---|---|---|---|
| App data | `%APPDATA%\chh` | `~/Library/Application Support/chh` | `~/.config/chh` |
| Logs | `%APPDATA%\chh\logs` | `~/Library/Application Support/chh/logs` | `~/.config/chh/logs` |
