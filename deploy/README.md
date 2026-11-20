# Deploying to a self-hosted box

Target layout on the box: a directory holding `docker-compose.prod.yml` and the filled `.env`,
for example `/srv/discord-mcp-server/`. Nothing here depends on a specific host or cloud provider.

## One-time preparation

1. Discord application (see [docs/installation.md](../docs/installation.md) §1): both
   privileged intents enabled, **Guild Install** used, redirect
   `https://<PUBLIC_BASE_URL>/oauth/discord/callback` registered, bot invited to the guild
   with View Channels + Read Message History.
2. Publish the image: build from the repo root (`docker build -t <APP_IMAGE> .`) and push it to
   the registry named in `APP_IMAGE` (any OCI registry works; `ghcr.io/<owner>/discord-mcp-server`
   is the placeholder used in `env.production.example`). The box only pulls; pushes happen from the
   operator machine.

## Deploy / upgrade

```bash
cd /srv/discord-mcp-server
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d postgres
docker compose -f docker-compose.prod.yml run --rm app npm run migrate   # explicit step
docker compose -f docker-compose.prod.yml up -d app
```

## Verify

```bash
curl -s http://127.0.0.1:$APP_PORT/health                                   # {"status":"ok"}
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:$APP_PORT/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'            # 401 expected
curl -s http://127.0.0.1:$APP_PORT/.well-known/oauth-authorization-server
docker compose -f docker-compose.prod.yml logs app | grep -E "guild-state|ingestion|semantic-index"
```

Then confirm externally: `https://<PUBLIC_BASE_URL>/health` through your TLS proxy or CDN, and an
MCP client login (Discord SSO → session → `list_channels`).

## Rules

- Rollback = point `APP_IMAGE` at the previous tag or digest, then
  `docker compose -f docker-compose.prod.yml up -d app`.
- Put a TLS-terminating reverse proxy or CDN in front of the published port and let it be the
  single trusted hop: it must set or overwrite `X-Forwarded-For`, because the in-process rate
  limiter keys on the rightmost entry (docs/installation.md §6). Reaching `<host>:<APP_PORT>`
  directly bypasses TLS — restrict it with the host firewall.
- Migrations are append-only and never run at startup; `migrate:undo` reverses one.
- Back up the `postgres-data` volume (nightly `pg_dump` off-box) before going live:
  deletions are mirrored, so the hub database is the only copy of what Discord has deleted.
