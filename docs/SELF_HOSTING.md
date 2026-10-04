# Self-hosting the sync server

Sync is optional: chh works fully offline. If you want your hosts, keys, identities, snippets and
forwarding rules on several devices, run your own sync server. It's a small Node.js service with PostgreSQL.

**The server never sees your data.** Everything is encrypted on your devices with a key derived from your
password before upload. If the server or its database is stolen, the attacker gets ciphertext, email
addresses and timestamps, but not hosts, passwords or keys. See [SECURITY.md](SECURITY.md#sync-and-the-server).

## Quick start (Docker Compose)

Requirements: Docker with the Compose plugin, a machine reachable from your devices, and for internet access
a DNS name pointing at it.

```bash
git clone <this repository> chh && cd chh/deploy
cp .env.example .env
# Fill in the two required values:
sed -i "s|^SERVER_SECRET=.*|SERVER_SECRET=$(openssl rand -base64 32)|" .env
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')|" .env
```

### Option A: HTTPS with automatic certificates (recommended for internet access)

Point a DNS record (e.g. `sync.example.com`) at the server, open ports 80 and 443, then:

```bash
echo "DOMAIN=sync.example.com" >> .env
echo "TRUST_PROXY=true" >> .env
docker compose --profile tls up -d
```

Caddy obtains and renews a Let's Encrypt certificate. In chh use `https://sync.example.com`.

### Option B: behind your own reverse proxy, or LAN only

```bash
docker compose up -d        # listens on 127.0.0.1:8080 by default
```

- Behind nginx/Traefik/etc.: proxy `https://your-name` → `http://127.0.0.1:8080`, pass the `Upgrade`/`Connection`
  headers (WebSocket at `/v1/sync/ws`), and set `TRUST_PROXY=true`.
- LAN only: set `BIND_ADDRESS=0.0.0.0` and use `http://192.168.x.y:8080` in the app. The app accepts plain HTTP
  only for private/local addresses (data stays end-to-end encrypted, but sign-in tokens don't).

Check it's running:

```bash
curl -s http://127.0.0.1:8080/healthz      # {"ok":true}
docker compose logs -f server
```

## Connecting the app

Settings → **Sync & account** → *Create account* with your server URL, email and a password (10+ characters).

**Save the recovery key you're shown.** It's the only way to recover your data if you forget your password.
Then sign in on your other devices. Turn on **two-factor authentication** in the same screen if you like.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SERVER_SECRET` | (required) | 32+ random bytes (base64). Encrypts TOTP secrets at rest and derives decoy salts. Keep it stable; changing it disables existing 2FA enrollments |
| `POSTGRES_PASSWORD` | (required) | Database password (Compose) |
| `DATABASE_URL` | set by Compose | `postgres://user:pass@host:5432/db` when running without Compose |
| `ALLOW_REGISTRATION` | `true` | Set `false` once your accounts exist to stop sign-ups |
| `TRUST_PROXY` | `false` | `true` behind a reverse proxy, so rate limits see client IPs |
| `BIND_ADDRESS` / `PORT` | `127.0.0.1` / `8080` | Where Compose publishes the server |
| `LOG_LEVEL` | `info` | `fatal`…`trace`, or `silent` |
| `STORE` | `postgres` | `memory` for development only (data is lost on restart) |

There are no plans, quotas or device limits. Every account gets every feature.

## Operations

- **Backups:** back up the Postgres volume, e.g.
  `docker compose exec db pg_dump -U chh chh | gzip > chh-$(date +%F).sql.gz`. Backups contain only
  ciphertext, but they're still worth protecting.
- **Upgrades:** `git pull && docker compose build && docker compose up -d`. Database migrations run
  automatically at startup (they're serialized, so several replicas can start at once).
- **Scaling:** one instance handles many users. Running several replicas works for HTTP sync, but live WebSocket
  notifications and the 10-minute password-recovery tokens are per instance. Use sticky sessions or a single
  replica.
- **Resource use:** about 60 MB RAM idle. Login and registration each use about 20 MB of temporary memory to
  hash the auth key (Argon2id).
- **Rate limits:** auth endpoints allow 30 requests per minute per IP.

## Running without Docker

```bash
pnpm install --filter @chh/server...
pnpm --filter @chh/server build
DATABASE_URL=postgres://… SERVER_SECRET=$(openssl rand -base64 32) node apps/server/dist/index.js
```

For local development: `STORE=memory SERVER_SECRET=$(openssl rand -base64 32) pnpm --filter @chh/server dev`.

## API (for the curious)

| Endpoint | Purpose |
|---|---|
| `POST /v1/auth/prelogin` | KDF parameters for an email (decoy values for unknown emails) |
| `POST /v1/auth/register`, `/login`, `/refresh`, `/logout` | Accounts and opaque bearer tokens (1 h access, 90-day rotating refresh with reuse detection) |
| `POST /v1/auth/recover/start`, `/finish` | Password reset with the recovery key (zero-knowledge) |
| `GET/DELETE /v1/account`, `POST /v1/account/password`, `/v1/account/totp/*` | Account, password change, TOTP 2FA |
| `GET /v1/devices`, `DELETE /v1/devices/:id` | Devices / remote sign-out |
| `POST /v1/sync/pull`, `/v1/sync/push` | Encrypted items with optimistic concurrency |
| `GET /v1/sync/ws` | WebSocket "vault changed" notifications |
| `GET /healthz`, `/v1/info` | Health and server info |

Schemas live in `packages/shared/src/sync/protocol.ts` and are validated on both ends.
