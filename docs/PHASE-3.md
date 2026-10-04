# Phase 3: port forwarding, snippets, history, themes, split view, Telnet, Mosh, ssh_config

**Status:** complete. 111 unit tests and 16 end-to-end tests pass on Linux (WSL2), including a real Mosh
session. Typecheck is clean.

## What works

| Area | Details |
|---|---|
| **Split view** | Split the focused pane right (⌘D / Ctrl+Shift+D) or down (⌘⇧D / Ctrl+Shift+E), nest freely, drag dividers to resize, cycle focus (⌘] ⌘[ / Ctrl+Shift+] [). Close tab (⌘W / Ctrl+Shift+W) closes just the focused pane when split. Panes are positioned from the layout tree but rendered as a flat list, so splitting or closing never restarts other sessions or loses scrollback. A new pane opens the same host or shell as the focused one |
| **Snippets** | Save commands/scripts with description and tags. `{{name}}` placeholders ask for values before running. Run from the Snippets screen, the terminal side panel (⌘⇧S / Ctrl+Shift+S), or the command palette ("Run snippet: …"). Multi-line scripts run line by line as if typed |
| **History** | Commands typed in any terminal are recorded without shell integration (see below). Searchable History screen, plus live history in the side panel: click inserts, double-click runs. Copy, delete, "save as snippet", clear all. Can be turned off globally (Settings) or per host/group (Record command history). Device-local and never synced |
| **Port forwarding** | Rules manager for **local (-L)**, **remote (-R)** and **dynamic SOCKS4/4a/5 (-D)** forwards. Start/stop, auto-start at launch, live connection count and bytes. Warns when listening on a non-loopback address. Each rule uses its own SSH connection. Clear errors: port in use, permission, server refused (AllowTcpForwarding) |
| **Telnet** | RFC 854 client with option negotiation (NAWS window size, TTYPE `XTERM-256COLOR`, ECHO, SGA, BINARY), IAC escaping and CR-NUL handling. Default port 23. The editor warns that Telnet is unencrypted |
| **Mosh** | Logs in over SSH (all usual auth, host-key checks and prompts), starts `mosh-server new`, then runs the local `mosh-client` in a PTY with `MOSH_KEY`. The server command is configurable per host/group. Clear errors when mosh-client or mosh-server is missing |
| **ssh_config import** | From `~/.ssh/config` or any file. Real OpenSSH semantics: first value wins, `Host` patterns with wildcards and `!negation`, `Match host/originalhost/user/all` (others skipped and reported), `Include` with globs (relative to `~/.ssh`), `%h %p %r %u %d %n` and `~` expansion. Preview with checkboxes ("already added" unticked). Imports HostName/Port/User, **IdentityFile keys** (unencrypted ones into Keys; encrypted ones are listed), and **Local/Remote/DynamicForward** as rules. ProxyJump, ForwardAgent and other options go into the host's notes |
| **ssh_config export** | Save to a file (defaults to `~/.ssh/config.chh`, never silently overwrites your config) or copy to the clipboard. Effective (inherited) user/port, forwards, unique aliases |
| **Themes** | Settings → Terminal: app-wide default color scheme (swatch picker, 12 schemes), font family/size, cursor style/blink. Groups and hosts still override. Changes apply **live** to open terminals |

## How history capture works

There's no shell integration to install. When you start typing, chh remembers where the cursor is (just
after the prompt). When you press Enter it waits briefly for the echo, then reads what the terminal **shows**
from that point to the end of the (possibly wrapped) line. As a result:

- Tab completion and ↑-recalled commands are captured as executed.
- Input that isn't echoed (passwords, `sudo` prompts) is not recorded.
- Full-screen apps (vim, less, top) are ignored because they use the alternate screen.
- Ctrl+C or Ctrl+D abandon the line.

It's a heuristic: unusual prompts that redraw the line (some zsh themes with right prompts) can capture
extra text. History is stored inside the encrypted database.

## New and changed files

```
packages/ssh-config/                      NEW: parse.ts, resolve.ts, forwards.ts, import.ts, write.ts (+ 9 tests)
packages/shared/src/model/{forward,snippet,history,ssh-import}.ts   NEW models
packages/shared/src/model/{host,settings,app-settings}.ts          telnet/mosh protocols, moshServer, recordHistory, terminalDefaults, historyEnabled
packages/shared/src/ipc/contract.ts        sessions.openHost; forwards, snippets, history, sshConfig namespaces; forward.update event

apps/desktop/src/session-host/
  transports/telnet.ts                     TelnetProtocol state machine + socket transport
  transports/mosh.ts                       SSH bootstrap of mosh-server + mosh-client in a PTY
  forwards/manager.ts                      local / remote / SOCKS forwarding with counters
  protocol.ts, index.ts                    open-telnet, open-mosh, forward RPCs and status
apps/desktop/src/main/
  db/{forwards-repo,snippets-repo,history-repo}.ts, db/migrations.ts (v2: history table)
  ssh-config-io.ts                         Include/glob loading, staged previews, import, export
  sessions.ts                              openHost (SSH/Telnet/Mosh), startForward/stopForward, status broadcast
  shells.ts                                detectMoshClient (PATH, Homebrew, WSL)
  ipc/handlers.ts, index.ts                new handlers, auto-start forwards
apps/desktop/src/renderer/
  stores/{layout,tabs-store,library-store}.ts            split-pane tree; tabs with panes; snippets + forward status
  features/terminal/{TerminalTabView,TerminalView,SidePanel,history-capture,registry}.tsx/ts
  features/snippets/{SnippetsView,VariablesDialog,run-snippet}.tsx/ts
  features/history/HistoryView.tsx, features/forwards/ForwardsView.tsx
  features/ssh-config/SshImportDialog.tsx, features/settings/ThemePicker.tsx
  features/hosts/{HostEditor,HostsView,SettingsFields}.tsx, features/settings/SettingsDialog.tsx,
  features/home/HomeView.tsx, features/tabs/TabBar.tsx, features/palette/CommandPalette.tsx,
  app/{App.tsx,commands.ts}, lib/keymap.ts
apps/desktop/tests/
  support/ssh-server.ts                    + direct-tcpip, tcpip-forward, guarded mosh-server exec
  support/telnet-server.ts                 NEW
  unit/{layout,telnet,forwards}.test.ts, unit/main/phase3-repos.test.ts
  e2e/phase3.spec.ts                       split view, snippets+history, Telnet, Mosh, forwarding, ssh_config
```

## Run and test

```bash
pnpm install
pnpm dev
pnpm test        # 111 unit tests
pnpm test:e2e    # 16 Playwright tests (the Mosh test is skipped if mosh isn't installed)
```

### Manual checklist

1. Open a terminal, press Ctrl+Shift+D then Ctrl+Shift+E. Drag the dividers. Ctrl+Shift+W closes one pane.
2. Snippets → New snippet `tail -n {{lines}} /var/log/syslog`. In a terminal press Ctrl+Shift+S → ▶ → enter 20.
3. Type a few commands, then open History (or the side panel's History tab) and search.
4. Port forwarding → New rule → Local 15432 → `db.internal:5432` through a host → Start → `psql -h 127.0.0.1 -p 15432`.
   Try Dynamic 1080 and set your browser's SOCKS proxy to `127.0.0.1:1080`.
5. Add a host with Protocol = Mosh (the server needs `mosh-server`) and roam networks or sleep the laptop: the session survives.
6. Hosts → SSH config → Import from ~/.ssh/config…
7. Settings → Terminal → pick a theme: open terminals update instantly.

## Platform differences

| | Windows | macOS | Linux |
|---|---|---|---|
| Mosh client | Through **WSL** (`wsl.exe -e mosh-client`, `MOSH_KEY` passed via `WSLENV`). Without WSL+mosh, Mosh hosts show an install hint | `mosh-client` on PATH or Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`) | `mosh-client` on PATH (`apt/dnf install mosh`) |
| Listening on ports < 1024 | Allowed | Allowed since macOS 10.14 | Needs root/capabilities, otherwise "Not allowed to listen" |
| ssh_config location | `%USERPROFILE%\.ssh\config` | `~/.ssh/config` | `~/.ssh/config` |
| Split/pane shortcuts | Ctrl+Shift+D / E / [ / ] / S | ⌘D / ⌘⇧D / ⌘[ / ⌘] / ⌘⇧S | Ctrl+Shift+D / E / [ / ] / S |

## Design notes and deviations

- **Forwards use one SSH connection per rule** rather than sharing a terminal's connection. Rules start and
  stop independently of tabs and survive closing terminals. The cost is one extra login per rule.
- **No automatic reconnect for forwards yet.** A dropped tunnel shows "connection lost". Press Start again.
- **Mosh bootstrap uses `-s`** (bind to the SSH connection's interface) and asks for a UTF-8 locale, like the
  official `mosh` wrapper. The UDP port range is mosh-server's default (60000–61000).
- **Telnet login isn't automated.** The server's `login:` prompt appears in the terminal, so type your
  credentials there. Saved passwords aren't sent over Telnet, which is unencrypted.
- **Snippets run in one terminal** (the focused pane). Running on several hosts in parallel is Phase 5.
- **History only lives on this device**, inside the encrypted database. It isn't part of the sync design.
- `mosh` was installed on the dev machine for the end-to-end test. CI installs it on Linux, and macOS and
  Windows runners skip that test.
