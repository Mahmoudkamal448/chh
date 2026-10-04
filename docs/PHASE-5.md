# Phase 5: jump hosts, proxies, agent forwarding, serial, FIDO2, env vars, multi-host snippets, autocomplete, cloud import

**Status:** complete. 170 unit/integration tests and 25 end-to-end tests pass on Linux (WSL2). Typecheck is clean.

## What works

| Area | Details |
|---|---|
| **Jump hosts** | Ordered chain per host or group (up to 8), each hop with its own login settings, host-key check and prompts. Works for terminals, SFTP, port forwarding, multi-host runs and Mosh bootstrap. Loops are detected. A failure names the jump host that failed |
| **Proxies** | SOCKS5 (optional username/password), SOCKS4/4a, and HTTP CONNECT (optional Basic auth) for the first hop. The proxy password is asked for at connect time and never stored. Can be combined with jump hosts |
| **Agent** | Choose the agent in Settings: automatic (`SSH_AUTH_SOCK` / Windows OpenSSH agent), **Pageant** (Windows), or a custom socket/pipe. **Agent forwarding** per host/group (off by default, with a warning) |
| **Environment variables** | Per host/group, merged down the group tree. Sent as SSH env requests (server must `AcceptEnv`), or typed as an `export` line after login. Also passed to Mosh (`mosh-server -l`) and to multi-host runs |
| **Serial ports** | New *Serial* protocol: device picker, baud, data bits, parity, stop bits, flow control (RTS/CTS, XON/XOFF), Enter mapping (CR/LF/CRLF), local echo. Clear errors for missing devices, permissions and busy ports |
| **FIDO2 / security keys** | Delivered through a per-host **System OpenSSH engine** that runs your installed `ssh` in the terminal (see "FIDO2 spike" below). Keys screen has a guided `ssh-keygen -t ed25519-sk` flow. Identity file per host. Jump hosts map to `-J`, agent forwarding to `-A`, env vars to `SetEnv` |
| **Multi-host snippets** | Snippets → "Run on several hosts…" → pick hosts (search, group/tag filters, select shown). Runs non-interactively in parallel (6 at a time), with `{{variables}}` filled once. A results tab shows per-host status, exit code, streamed stdout/stderr (1 MB cap per host), "only failed" filter, cancel, and "run again on failed" |
| **Autocomplete** | Dimmed ghost completion from history as you type (→ accepts). Ctrl+Space opens a list of history matches and snippets. Commands from the same host rank first. Works in local, SSH, Mosh and Telnet terminals without shell integration |
| **AI suggestions (optional)** | Pluggable provider for any OpenAI-compatible API, including local Ollama/llama.cpp. Off by default, only on explicit request ("Ask AI" in the Ctrl+Space list). The API key is stored sealed. Sends only the current line and the host's OS, plus the last 10 commands if you opt in. HTTPS is required except for localhost |
| **Cloud import** | **AWS EC2** (profiles from `~/.aws`, the SDK default chain, or a one-time access key; multiple regions) and **DigitalOcean** (API token). Preview with checkboxes, choice of public IP, private IP or public DNS, default username, target group. **Re-import updates** hosts (by instance id) instead of duplicating, keeping your settings. Credentials aren't stored |
| **OS detection** | After an SSH shell starts, a read-only probe (`/etc/os-release`, `uname -s`) sets the host's OS. The host list shows a colored monogram badge (original design; not vendor logos). Cloud imports set it too |

## FIDO2 spike (risk R1) and outcome

**Finding:** `ssh2` has no support at all for `sk-ssh-ed25519@openssh.com` / `sk-ecdsa-sha2-nistp256@openssh.com`:
no key parsing, no agent identity handling, no signature format. Agent-based passthrough would need a patch to
ssh2's protocol internals. Without an authenticator to verify against, that would be shipping untested crypto
code.

**Decision (the planned fallback):** a per-host **System OpenSSH engine**. OpenSSH ≥ 8.2 handles security keys
natively (touch and PIN, resident keys), and it also brings post-quantum key exchange (risk R6). The trade-off is
that hosts on this engine use OpenSSH's own `known_hosts` and `~/.ssh/config`, take passwords in the terminal, and
don't support SFTP or chh vault keys (use the agent or an identity file). The E2E test drives a real `ssh`
binary through host-key confirmation and password login against the test server. Only the hardware touch itself
can't be tested here.

## Bugs found and fixed during this phase

- **Proxy handshake could loop forever** (100% CPU, then out of memory): pushing surplus bytes back onto the socket
  while still listening re-delivered them to the same reader. Fixed, and covered by SOCKS5/HTTP proxy tests.
- **A jump host dropping its connection could crash every session** (an unhandled `error` event in the session host
  process). All chain connections now have error handlers.
- **Telnet hosts lost their Port field** after the editor started hiding SSH-only fields (caught by the Phase 3 E2E
  test). Port is shown for Telnet again, with 23 as the placeholder.

## New and changed files

```
packages/shared/src/model/{settings,host,app-settings,session,run}.ts   proxy/serial/jump/env/engine settings; serial protocol;
                                                                         externalId; run & cloud models; agent/autocomplete/AI settings
packages/shared/src/ipc/contract.ts       serial.*, run.*, suggest.*, cloud.*; run.status/run.output events
apps/desktop/src/session-host/
  ssh/proxy.ts                             SOCKS4a/5 and HTTP CONNECT client
  ssh/connect.ts                           connectChain (proxy → jumps → target), agent selection/forwarding
  ssh/os-detect.ts                         OS probe + parser
  transports/serial.ts                     serialport transport
  transports/ssh.ts, transports/mosh.ts    env (requests/export), OS detection, mosh -l env
  exec/runner.ts                           multi-host non-interactive runs
  protocol.ts, index.ts                    open-serial, os-detected, exec RPCs, run events
apps/desktop/src/main/
  sessions.ts                              jump-chain resolution, serial/OpenSSH dispatch, OS hints, run queue
  ai.ts                                    OpenAI-compatible provider
  cloud/{providers,import}.ts              AWS EC2, DigitalOcean, staged import/update
  db/{history-repo,hosts-repo}.ts          suggest(); externalId, setOsHint, updateFromCloud
  shells.ts, context.ts, ipc/handlers.ts   detectOpenSsh; wiring
apps/desktop/src/renderer/
  features/hosts/AdvancedFields.tsx        engine, jump hosts, proxy, agent forwarding, env editor, serial fields
  features/run/{RunView,HostMultiPicker}.tsx, stores/runs-store.ts
  features/terminal/{Autocomplete.tsx,history-capture.ts,TerminalView.tsx}
  features/cloud/CloudImportDialog.tsx, features/settings/AiSettings.tsx
  components/OsBadge.tsx, features/keys/KeysView.tsx (security keys card)
apps/desktop/tests/
  support/{proxies,config}.ts, support/ssh-server.ts (env, agent request, scripted exec, OS probe)
  unit/phase5.test.ts, unit/main/phase5-main.test.ts, e2e/phase5.spec.ts
```

## Run and test

```bash
pnpm test        # 170 tests
pnpm test:e2e    # 25 tests (serial needs socat, Mosh needs mosh, the OpenSSH engine test needs ssh)
```

### Manual checklist

1. Edit a host → Advanced connection → add a jump host → connect: you verify both hosts' keys.
2. Set a SOCKS5 proxy (e.g. `ssh -D 1080 somewhere`) on a host and connect.
3. Turn on agent forwarding, connect, run `ssh-add -l` on the server.
4. Add `APP_ENV=staging` under Environment variables, connect, run `echo $APP_ENV` (the server must
   `AcceptEnv APP_ENV`, or use "Type export after login").
5. Plug in a USB-serial adapter: New host → Protocol *Serial* → pick the device.
6. Snippets → server icon on a snippet → select hosts → Run.
7. Type the start of a command you've used before: → completes it. Ctrl+Space lists more.
8. Hosts → Import / export → Import from AWS EC2… / DigitalOcean….
9. Keys → Security keys → open terminal with the `ssh-keygen -t ed25519-sk` command. Then set the host's engine
   to System OpenSSH with that identity file.

## Platform differences

| | Windows | macOS | Linux |
|---|---|---|---|
| Serial device names | `COM3` | `/dev/cu.usbserial-…` (use `cu.`, not `tty.`) | `/dev/ttyUSB0`, `/dev/ttyACM0` (user needs the `dialout` group) |
| Agent | Windows OpenSSH agent service, or **Pageant** | launchd agent (`SSH_AUTH_SOCK`) | `SSH_AUTH_SOCK` |
| System OpenSSH | `C:\Windows\System32\OpenSSH\ssh.exe` (FIDO2 via Windows Hello/WebAuthn on recent builds) | `/usr/bin/ssh` (FIDO2 needs Homebrew OpenSSH: Apple's build lacks it) | `ssh` from your distribution (≥ 8.2 for FIDO2) |
| Autocomplete | All | All | All |

## Design notes and deviations

- **FIDO2 uses the System OpenSSH engine**, not ssh2 (see the spike). Vault keys can't be used with that engine
  (they'd need to be written to disk). Use the agent or an identity file.
- **Proxies in the OpenSSH engine** aren't translated (OpenSSH needs a `ProxyCommand`). Configure them in
  `~/.ssh/config`.
- **Mosh with jump hosts:** the SSH bootstrap goes through the chain, but Mosh's UDP traffic goes directly to
  the target, which must be reachable from this computer.
- **Agent forwarding** is verified at the protocol level (the server receives the forwarding request with the
  configured agent). Relaying agent traffic is ssh2's own, well-tested code: its server API can't open agent
  channels in tests.
- **Autocomplete is screen-based**, like history capture: when the cursor isn't at the end of the input (e.g.
  editing mid-line), no ghost text is shown.
- **Multi-host runs are non-interactive** (no PTY), so commands that need a TTY or a password prompt (e.g.
  `sudo` without `NOPASSWD`) fail rather than hang.
- `socat` was installed on the dev machine for the serial E2E test (CI installs it on Linux).
