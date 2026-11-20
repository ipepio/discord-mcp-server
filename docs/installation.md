# Installation

Discord MCP Server is a self-hosted MCP server that mirrors one Discord guild into PostgreSQL and
answers queries over MCP with each user's real Discord permissions. This guide takes you from an empty
machine to a hub your MCP client can use.

- Every setting is read **once at startup** and validated; a missing or malformed value stops the
  process with an error naming the variable (no half-configured state).
- The hub is **read-only towards Discord**: it never sends, edits, deletes or changes roles.
- One installation serves **exactly one guild**.

## Prerequisites

| Requirement                                      | Why                                                                                                      |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Docker with Compose v2                           | runs the application and PostgreSQL                                                                      |
| PostgreSQL 16 **with pgvector**                  | the compose file already uses `pgvector/pgvector:pg16`; a managed database needs the extension available |
| A Discord application (bot + OAuth2)             | identity, Gateway events and history reads                                                               |
| An OpenAI-compatible embeddings endpoint and key | semantic search; without it you can still run full-text only                                             |
| An HTTPS hostname (production)                   | Discord requires HTTPS for OAuth redirects; loopback `http://127.0.0.1` is allowed for local development |

## 1. Create the Discord application

Do this in <https://discord.com/developers/applications> → **New Application**.

### 1.1 OAuth2 credentials

**OAuth2** page:

- **Client ID** → this is `DISCORD_CLIENT_ID`.
- **Client Secret** → **Reset Secret** → **Copy** → this is `DISCORD_CLIENT_SECRET` (shown once).
- **Redirects → Add Redirect** → the hub's callback:
    - local development: `http://127.0.0.1:3000/oauth/discord/callback`
    - production: `https://<your-host>/oauth/discord/callback`
    - the port and path must match `APP_PORT` and the hub's `/oauth/discord/callback` route exactly.

### 1.2 Bot token and privileged intents

**Bot** page:

- **Token** → **Reset Token** → **Copy** → this is `DISCORD_BOT_TOKEN` (shown once).
- **Privileged Gateway Intents** — enable **both**:
    - **MESSAGE CONTENT INTENT** — without it Discord redacts message text (only mentions and command
      inputs survive).
    - **SERVER MEMBERS INTENT** — without it Discord withholds the member roster, and authorization
      fails closed.
    - `GUILDS` and `GUILD_MESSAGES` are part of the standard set; the hub requests exactly
      `GUILDS`, `GUILD_MESSAGES`, `MESSAGE_CONTENT`, `GUILD_MEMBERS`.
- Leave **Requires OAuth2 Code Grant** disabled; enabling it breaks bot invitations.

### 1.3 Installation context

**Installation** page:

- Enable **Guild Install** and keep **User Install** disabled for clarity. A user install puts the app
  on a person's account and gives the hub **no** message access at all.
- Use the **Guild Install** link. The hub needs the bot to be a guild member: only then does the
  Gateway deliver message/member/channel events and only then can history be read.

Invite the bot with the minimum permissions (View Channels + Read Message History):

```text
https://discord.com/oauth2/authorize?client_id=<DISCORD_CLIENT_ID>&permissions=66560&scope=bot&guild_id=<DISCORD_GUILD_ID>&disable_guild_select=true
```

### 1.4 Guild id

Enable Discord's **Developer Mode** (User Settings → Advanced), then right-click the **server** (not a
channel) → **Copy Server ID**. That is `DISCORD_GUILD_ID`.

Confirm the bot is really a member before starting the hub:

```bash
curl -s -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
     -H "User-Agent: DiscordBot (https://github.com/<owner>/discord-mcp-server, 1.0.0)" \
     https://discord.com/api/v10/users/@me/guilds
```

The configured guild must appear in that list.

## 2. Environment variables

Copy `.env.example` to `.env` (`gitignore` already excludes it) and fill it in. Never commit `.env`.

### Required

| Variable                | Where it comes from                                                                                                                                                             | Validation                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | you build it: `postgresql://<user>:<password>@<host>:5432/<database>`. Inside compose use the service name `postgres`; the database port is not published to the host by design | non-empty connection string                                                           |
| `DISCORD_CLIENT_ID`     | Developer Portal → your app → **OAuth2 → Client ID**                                                                                                                            | non-empty                                                                             |
| `DISCORD_CLIENT_SECRET` | **OAuth2 → Client Secret → Reset Secret**                                                                                                                                       | non-empty                                                                             |
| `DISCORD_BOT_TOKEN`     | **Bot → Token → Reset Token**                                                                                                                                                   | non-empty                                                                             |
| `DISCORD_GUILD_ID`      | right-click the server with Developer Mode on → **Copy Server ID**                                                                                                              | positive snowflake (≤ 21 digits)                                                      |
| `PUBLIC_BASE_URL`       | the origin users and clients reach: `https://hub.example.com` in production, `http://127.0.0.1:3000` for local development                                                      | absolute URL; `http` only when `AUTHORIZATION_LOCAL_DEVELOPMENT=true`                 |
| `SESSION_TTL_SECONDS`   | your policy                                                                                                                                                                     | integer 300–86400, fixed (absolute) expiry, no sliding renewal                        |
| `IMPORT_MODE`           | your choice: `full` mirrors the whole retrievable history, `days` mirrors a window                                                                                              | `full` or `days`                                                                      |
| `EMBEDDING_PROVIDER`    | the protocol your endpoint speaks                                                                                                                                               | must be `openai`                                                                      |
| `EMBEDDING_MODEL`       | the model id your provider serves, e.g. `text-embedding-3-small` for OpenAI or `qwen3-embedding` for an OpenAI-compatible gateway                                               | plain identifier; must be `text-embedding-3-small` unless `EMBEDDING_BASE_URL` is set |
| `EMBEDDING_DIMENSION`   | must match the vector column in the migrations                                                                                                                                  | must be `1536`                                                                        |
| `EMBEDDING_API_KEY`     | your embeddings provider's key                                                                                                                                                  | non-empty                                                                             |

### Required only in `IMPORT_MODE=days`

| Variable      | Where it comes from | Validation                                                                                                          |
| ------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `IMPORT_DAYS` | your window         | integer ≥ 1; messages created strictly after `import start − IMPORT_DAYS days` are imported. Ignored in `full` mode |

### Optional

| Variable                                        | Default                     | Notes                                                                                                                                                                    |
| ----------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_PORT`                                      | `3000`                      | integer 1–65535; the compose file publishes `${APP_PORT}` on the host                                                                                                    |
| `LOG_LEVEL`                                     | `info`                      | `debug`, `info`, `warn` or `error`                                                                                                                                       |
| `HUB_BRAND_NAME`                                | `Discord MCP Server`        | shown on the browser pages, the MCP server metadata and the OpenAPI title                                                                                                |
| `HUB_BRAND_MARK_FILE`                           | unset (built-in mark)       | path to an inline `<svg>` file that replaces the built-in mark on the browser pages                                                                                      |
| `HUB_UI_LOCALE`                                 | `es`                        | browser text language: `es` or `en`                                                                                                                                      |
| `AUTHORIZATION_LOCAL_DEVELOPMENT`               | `false`                     | allows an `http://127.0.0.1`, `http://[::1]` or `http://localhost` issuer. Keep `false` in production                                                                    |
| `RATE_LIMIT_REGISTER_PER_HOUR`                  | `10`                        | per client IP and hour on `POST /oauth/register`; integer ≥ 1                                                                                                            |
| `RATE_LIMIT_AUTHORIZE_PER_MINUTE`               | `20`                        | per client IP and minute on `GET /oauth/authorize` and `GET /oauth/discord/callback`; integer ≥ 1                                                                        |
| `RATE_LIMIT_TOKEN_PER_MINUTE`                   | `30`                        | per client IP and minute on `POST /oauth/token`; integer ≥ 1                                                                                                             |
| `RATE_LIMIT_MCP_PER_MINUTE`                     | `300`                       | per client IP and minute on `POST /mcp`; integer ≥ 1, a flood bound only                                                                                                 |
| `EMBEDDING_BASE_URL`                            | `https://api.openai.com/v1` | OpenAI-compatible endpoint root, **without** `/embeddings`. Must not carry credentials, a query or a fragment                                                            |
| `FTS_LANGUAGE`                                  | `spanish`                   | full-text dictionary: `spanish`, `english` or `simple` (no stemming, for mixed-language servers)                                                                         |
| `QUERY_MAX_MESSAGE_CHARS`                       | `4000`                      | per-message content cap; 4000 is Discord's own message ceiling, so real content is never truncated                                                                       |
| `QUERY_MAX_RESPONSE_BYTES`                      | `262144`                    | per-response cap (minimum 2048); an oversized page is shortened with a valid continuation cursor instead of failing                                                      |
| `INGESTION_CATCH_UP_ENABLED`                    | `true`                      | `true` or `false`; `false` means the periodic catch-up never starts and a deferred channel waits for the next restart                                                    |
| `INGESTION_CATCH_UP_INTERVAL_MS`                | `300000`                    | delay between two catch-up ticks, in milliseconds; whole positive number                                                                                                 |
| `INGESTION_CATCH_UP_CHANNELS_PER_TICK`          | `5`                         | how many outstanding channels one tick may walk; whole positive number                                                                                                   |
| `INGESTION_CATCH_UP_PAGES_PER_CHANNEL_PER_TICK` | `20`                        | the page bound one channel's tick walk obeys; whole positive number                                                                                                      |
| `INGESTION_RESYNC_MAX_PAGES_PER_CHANNEL`        | `5`                         | page bound one channel's reconnect resync walk obeys; whole positive number. It bounds the missed window, not the channel: the import and the catch-up own the full walk |

### Compose only

| Variable                                            | Notes                                                                                                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | the database service. `POSTGRES_PASSWORD` has no default: compose refuses to start until you set it. Keep it identical to the credentials inside `DATABASE_URL` |

## 3. Run it

```bash
cp .env.example .env      # then edit it
docker compose up -d postgres
docker compose run --rm app sh -c "npm ci && npm run migrate"   # schema, explicit step
docker compose up -d app
```

Migrations are **never** applied by application startup: they are an explicit operator step and the
files are append-only. `npm run migrate:undo` reverses the most recent one.

## 4. Verify

The commands below assume the default `APP_PORT=3000`; substitute your value if you changed it.

```bash
curl -s http://127.0.0.1:3000/health                                  # {"status":"ok"}
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3000/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'       # 401: the session guard is mounted
curl -s http://127.0.0.1:3000/.well-known/oauth-authorization-server    # discovery metadata
```

Then check the logs for the bootstrap and import:

```bash
docker compose logs -f app | grep -E "guild-state|ingestion|semantic-index"
```

You should see the permission registry populate, the historical import per channel, and the embedding
worker committing batches.

## 5. Connect an MCP client

Point any MCP client at `<PUBLIC_BASE_URL>/mcp`. The client discovers the authorization server,
registers itself (dynamic client registration), opens the Discord login and receives a hub session.
No per-client operator configuration exists.

The seven tools are `search_messages`, `list_channels`, `get_channel_history`, `get_thread_messages`,
`get_message_context`, `get_recent_activity` and `get_hub_status`. `get_hub_status` answers, in one call,
which Guild this hub serves, whether its registry state is current and how many channels and threads it
mirrors for you — the honest answer to a `list_channels` page that looks shorter than you remember.

### Agent versus human onboarding

Two different actors connect here, and mixing them up is what makes a client retry for ten minutes:

- **The agent** does the machine half. It installs the server by URL (`<PUBLIC_BASE_URL>/mcp`), reads the
  `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_BASE_URL>/.well-known/oauth-protected-resource"`
  header of the first `401`, fetches that metadata document, and finds the authorization server and its
  dynamic registration endpoint there. It must not re-probe the URL, retry in a loop or invent a result.
- **The human** does the Discord half. The agent presents the login link and waits: the person completes
  the Discord browser login in their own browser, and only then does the hub issue a session.

After the login the tools answer, and the server's `initialize` instructions tell the agent how to read:
which brand and Guild it is talking to, that history is recent-first, that `get_recent_activity` answers
"what is new", that it must ask when the request names neither a channel nor a time window, and that a
short `list_channels` page is this hub's mirror scope rather than a pagination defect.

#### When the agent says it cannot see the server

Two causes live in the client, not in the hub, and both look like "the hub has no tools":

- **The server was never loaded in that session.** `instructions` and `tools/list` only exist after a
  successful `initialize`, so a session started before the server was added, or one that never completed
  the OAuth flow, has no tools at all. Reload the client session (or start a new one) and confirm that
  `initialize` answers before asking the agent to use the hub.
- **The client declares only `authorization_code` in its own OAuth client metadata.** Such a client
  registers, logs in and works, but never refreshes its access token, so the session it already holds is
  the only one it can use. The hub accepts `refresh_token` as well; a client that never asks for it keeps
  the short session, and the fix is that client's configuration, not a hub setting.

Neither case is the hub declining to serve: if `initialize` succeeds, the tools are there and
`get_hub_status` states the rest.

## 6. Operational notes worth knowing before production

- **Message content leaves the host** to the configured embeddings endpoint. That is a deliberate
  decision recorded in ADR 0008; the provider's retention policy is outside the hub's control.
- **Granting the bot access is picked up while it runs.** When the bot's `View Channel` permission on a
  text channel goes from denied to allowed, the hub backfills that channel's history as a bounded
  background job, using the same `IMPORT_MODE`/`IMPORT_DAYS` window as the startup import and touching
  no other channel. Nothing needs restarting: a rename starts nothing, taking the permission away starts
  nothing, and live messages keep arriving through the Gateway throughout. If a channel was granted
  while the hub was down, the next connection's resync covers it.
- **The historical import resumes on its own.** Progress is stored in the `import_channel_progress`
  table: a channel that stopped on a Discord rate limit, a 5xx or a page bound is picked up again by a
  bounded background job — by default five channels every five minutes, twenty pages each — with no
  restart and no operator action. A channel already marked `complete` is never read again, so restarting
  the hub no longer re-walks history it already holds. A reconnect reads only the window it missed: each
  resync walk is bounded to `INGESTION_RESYNC_MAX_PAGES_PER_CHANNEL` pages per channel (five by default),
  and a channel the bound stopped stays gap-tracked at its cursor rather than being reported as current.
  Rate-limited channels back off from one minute up to an hour; a channel whose permission is gone is
  recorded as `skipped` and re-checked once per tick.
  The four settings are in [Optional](#optional), and `INGESTION_CATCH_UP_ENABLED=false` turns the job
  off. **Migrations remain an explicit step**: `npm run migrate` is still what creates the ledger table,
  and the job only ever sees channels the import already knows about.
- **Deletions are mirrored**, not archived: a message deleted in Discord stops being retrievable.
- **Authorization is per user and per request** from Gateway-synced state; there is no TTL cache. If
  the registry is stale (reconnect resync in flight) every MCP request is refused until it converges.
- **OAuth endpoints and `/mcp` are rate limited** in-process, fixed-window per client IP:
  registration 10/hour, `authorize` and the Discord callback 20/minute, token 30/minute, `/mcp`
  300/minute (all configurable; see [Optional](#optional)). A refused request answers `429` with a
  `Retry-After` header and a `{"error":"too_many_requests"}` body, and logs only the outcome code
  and address. The limiter assumes **exactly one trusted reverse-proxy hop**: it uses the rightmost
  `X-Forwarded-For` entry and the socket peer when the header is absent. Never publish the app port
  directly, and make the proxy set or overwrite `X-Forwarded-For`.
- **The limiter state is per process.** With more than one application instance the bound is only
  per instance; replace it with a shared store before scaling horizontally (see
  [session-refresh deployment](deployment/session-refresh.md)).

## 7. Troubleshooting

| Symptom                                                   | Cause and fix                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Configured Discord Guild is absent from this connection` | the bot is not a member of `DISCORD_GUILD_ID`. Check the invite list API call in §1.4                                                            |
| The bot never appears in the server                       | you used a **User Install** link. Use the Guild Install link in §1.3                                                                             |
| Messages are stored with empty `content`                  | `MESSAGE_CONTENT` is disabled in the portal, or the bot joined before the intent was enabled: enable the intent, then kick and re-invite the bot |
| `Invalid OAuth2 redirect_uri` during login                | the redirect registered on the Discord app does not exactly match `<PUBLIC_BASE_URL>/oauth/discord/callback`                                     |
| `EADDRINUSE` or a different app answering on the port     | another process owns `APP_PORT`; change it (and the Discord redirect) or stop the other process                                                  |
| `could not connect to postgres`                           | `DATABASE_URL` host must be `postgres` inside compose; run migrations in the same network                                                        |
| `403 Missing Access` calling the Discord API by hand      | Discord REST requires a `User-Agent` header                                                                                                      |
| `non-member user` denied at login                         | the Discord account is not a member of the configured guild; membership is the access gate                                                       |
