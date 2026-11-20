# Project facts

What this repository is and how it currently stands. Everything below describes code that exists in
this tree; an entry marked **open** is a decision not made yet. Do not infer a capability, script or
authorization that is not written here or in the linked specification.

| Field                              | Current value                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Product/domain                     | Discord MCP Server — self-hosted MCP server that mirrors one Discord guild into PostgreSQL and exposes per-user authorized queries                                                                                                                                                                                                                                       |
| Runtime/framework baseline         | Node.js ≥ 22, NestJS 11, TypeScript ESM/NodeNext; discord.js for the Discord integration; dependencies pinned by a committed lockfile                                                                                                                                                                                                                                    |
| Persistence baseline               | PostgreSQL 16 + pgvector through `pg`, no ORM (ADR 0003); PostgreSQL full text search with a configurable dictionary (`spanish` default); embeddings in pgvector ([ADR 0008](adr/0008-semantic-search-v1-pgvector.md)); migrations append-only and applied only by an explicit operator command                                                                          |
| Exposed transports                 | MCP over Streamable HTTP is the only functional external contract ([ADR 0004](adr/0004-mcp-primary-transport.md)); REST/OpenAPI covers the auxiliary `/health` endpoint only                                                                                                                                                                                             |
| Authentication/authorization       | Discord OAuth2 SSO with OAuth 2.1 PKCE and dynamic client registration, hub-issued sessions, Discord tokens kept server-side ([ADR 0006](adr/0006-discord-sso-dynamic-client-registration.md)); effective Discord permissions evaluated per request from Gateway-synced state ([ADR 0005](adr/0005-gateway-synced-permission-state.md))                                  |
| Tool surface versioning            | Additive-only tool evolution; a `/v1` URL namespace arrives with the first breaking change; deprecations are documented in the tool descriptions                                                                                                                                                                                                                         |
| Environment/deployment             | `docker-compose.yml` (application + `pgvector/pgvector:pg16`, database port deliberately unpublished) and a multi-stage `Dockerfile`; image registry and multi-instance topology: **open**                                                                                                                                                                               |
| Existing integrations              | Discord (bot Gateway + OAuth2), one Discord application/bot per installation; an OpenAI-compatible embeddings endpoint, optional for full-text-only operation                                                                                                                                                                                                            |
| Data sensitivity/tenant boundaries | One guild per installation; per-user effective-permission authorization; the Discord message lifecycle is mirrored, deletions are never queryable ([ADR 0007](adr/0007-mirror-message-lifecycle.md)); message content is sent to the configured embedding provider, accepted by the operator through configuration ([ADR 0008](adr/0008-semantic-search-v1-pgvector.md)) |

## Verification commands

These are the scripts `package.json` defines; they are the repository's real checks.

- `npm run format` — Prettier `--write` over `src`, `tests`, `migrations` and the root configuration
  files. Rewrites in place with the conventions baseline (tabs, width 4, double quotes, print width
  120, no trailing commas; YAML at four spaces).
- `npm run lint` — `eslint .` with the flat typescript-eslint configuration, Prettier-compatible.
- `npm run arch` — `depcruise src --config .depcruiser.cjs`. The boundary rules are also proven able to
  fail by the architecture test fixtures; a deliberate violation exits non-zero.
- `npm run typecheck` — `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit`. The
  second configuration extends the first and puts the `tests` tree under the same strict options
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`)
  while emitting nothing.
- `npm run build` — `tsc -p tsconfig.json` into `dist/`.
- `npm test` — `vitest run`: feature unit tests plus architecture boundary fixtures and the
  application composition smoke test that boots the real module graph and asserts `GET /health`
  answers 200 on an ephemeral loopback port.
- `npm run test:integration` — `vitest run --mode integration`, selecting
  `tests/**/*.integration.test.ts`. It requires an explicitly supplied `TEST_DATABASE_URL` pointing at
  a PostgreSQL with pgvector; each suite creates, migrates and drops its own database. Missing
  database access must read as missing integration evidence (`--passWithNoTests` is deliberately not
  used), never as a pass.
- `npm run migrate` / `npm run migrate:undo` — `node-pg-migrate up` / `down` over `migrations/`
  (TypeScript migrations load through the runner's bundled jiti; `0_noop-baseline` is the append-only
  starting point). Requires a reachable PostgreSQL through `DATABASE_URL` and never runs from
  application startup.

## Authorization composition and operations

- `AuthorizationModule.forRoot({ imports: [discord, guildState] })` consumes the same module instances
  as the other features, never a second Discord connection. Required public tokens supplied by those
  imports: `DISCORD_CONFIG_TOKEN`, `DISCORD_EVENT_STREAM_TOKEN`, `GUILD_STATE_STATUS_QUERY_TOKEN`,
  `GUILD_STATE_MEMBERSHIP_STATUS_QUERY_TOKEN`.
- Shared modules supply `APP_CONFIG_TOKEN`, `APP_LOGGER_TOKEN` and `PG_POOL_TOKEN`. All factories use
  explicit injection; stores and the Discord OAuth adapter remain private to the feature.
- Public identity seam: `AuthenticateSessionQuery.execute(token)` returns a discriminated validity
  result with `principal: { userId, sessionId, expiresAt }` and the current-session, membership and
  registry facts. MCP controllers mount `McpAuthenticationGuard` for every HTTP request and take
  identity from `request.authorizationPrincipal`, never from tool input.
- Shared startup configuration requires `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
  `PUBLIC_BASE_URL` and `SESSION_TTL_SECONDS`; `.env.example` documents placeholders only. The issuer
  is an HTTPS origin, with HTTP loopback allowed only under `AUTHORIZATION_LOCAL_DEVELOPMENT=true`.
  The TTL is required, fixed (absolute), and an integer in 300..86400 inclusive; there is no default,
  no refresh and no sliding renewal.
- The callback consumes pending state and produces a short-lived hub code; session insertion happens
  only at successful PKCE token redemption, so a failed PKCE leaves zero sessions and no plaintext hub
  credential is ever stored. Discord tokens never leave the feature's HTTPS adapter stack.
- The OAuth endpoints intentionally have no OpenAPI document ([ADR 0004](adr/0004-mcp-primary-transport.md),
  [ADR 0006](adr/0006-discord-sso-dynamic-client-registration.md)). Rate limits are enforced in-process
  for the four public OAuth endpoints and `/mcp` (defaults: registration 10/hour, authorize and
  callback 20/minute, token 30/minute, MCP 300/minute; validated `RATE_LIMIT_*` variables), keyed by
  client IP under a single-trusted-proxy-hop `X-Forwarded-For` assumption. A multi-instance deployment
  still needs a shared limiter store; see [session refresh deployment](deployment/session-refresh.md).

### Brand configuration

The deployment identity is environment-driven (`HUB_BRAND_NAME`, `HUB_BRAND_MARK_FILE`,
`HUB_UI_LOCALE`): the functional core is brand-agnostic and the browser pages, the MCP server metadata
and the OpenAPI title derive from these settings. `HUB_BRAND_NAME` defaults to `Discord MCP Server`,
`HUB_BRAND_MARK_FILE` replaces the built-in mark with the operator's own inline SVG, and the browser
surface ships `es` by default with `en` available.

## Feature composition

`AppModule.forRoot({ botUserId, env })` is the installation's composition root; the static `AppModule`
export stays auxiliary-only. It reuses one `discord` module instance everywhere (calling `forRoot`
twice opens a second Gateway connection), passes the bot's own user id as composition data, and wires
the remaining features in this order: guild-state (registry), ingestion, authorization, semantic-index
(explicit opt-in) and query.

### Ingestion

`src/features/ingestion/index.ts` exposes `IngestionModule`, its event binding, and the historical
import command/token; no repository implementation or message read path is public.
`IngestionModule.forRoot` consumes the Discord configuration/event/REST tokens and guild-state's public
`GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN`. Composition subscribes guild-state before ingestion and
starts the historical import independently of the Gateway delivery queue, so continuous message
application proceeds while import works. Neither module construction nor subscribing implicitly opens
a connection or starts history work. An incomplete import is resumed by reinvoking it; a restart rereads
from newest and guarded writes make replay a no-op. Reconnect signals backfill per-channel windows,
retain failed gaps and report incomplete runs instead of declaring the mirror current.

### Semantic index

Semantic index is implemented in `src/features/semantic-index` with an explicit opt-in module, pgvector
storage, a decoupled OpenAI-backed worker, stored-state vector invalidation and ACL-first hybrid RRF
retrieval. See [deployment and re-embedding operations](deployment/semantic-index.md) and
[the feature specification](features/semantic-index.md). Its SQL tests use isolated PostgreSQL and
pgvector databases with provider test doubles.

### Query

The query feature implements the framework-free retrieval and status queries (`GetHubStatusQuery`
composes the existing contracts and owns no repository), ACL-scoped PostgreSQL reads, the MCP tool
discovery/call adapter, guild metadata and explicit-token `QueryModule` composition. The executable
schema source is `src/features/query/models/dtos/tool-schema.dto.ts`; see
[query verification and seam wiring](features/query-verification.md) for the evidence behind it.
Payload configuration is validated through `loadQueryConfig`: `QUERY_MAX_MESSAGE_CHARS` defaults to
4000 Unicode characters and `QUERY_MAX_RESPONSE_BYTES` to 262144 bytes; truncation is head-only and
explicit, and oversized pages retain seek cursors.

## Agreed v1 scope

- One installation serves exactly one guild; MCP clients may connect to several installations (one URL
  per guild); the hub identifies its guild in its MCP server metadata. See [CONTEXT.md](../CONTEXT.md).
- Historical import: full history by default, configurable (`IMPORT_MODE=full|days`, `IMPORT_DAYS=N`);
  continuous Gateway sync afterwards.
- v1 MCP tool surface: `search_messages`, `list_channels`, `get_channel_history`,
  `get_thread_messages`, `get_message_context`, plus the `get_recent_activity` novelty digest and the
  `get_hub_status` status tool (seven tools); attachments as metadata only; retrieval only — reasoning
  belongs to the MCP client.
- Semantic search in v1 ([ADR 0008](adr/0008-semantic-search-v1-pgvector.md)): a decoupled embedding
  pipeline over stored messages (managed provider, first implementation OpenAI) and hybrid FTS+vector
  retrieval in the query feature, under four testable ACL invariants.

Planned later phases (not v1): tags; a packaged release process; an internal web panel as another MCP
client.

## Decisions already made

- Gateway connection ownership: a dedicated `discord` feature module owning the single Gateway
  connection and the normalized event-stream contract.
- API versioning: additive-only tool evolution; a `/v1` namespace on the first breaking change.
- Migration runner: node-pg-migrate.

## Open decisions

- Image registry, packaged release pipeline and the multi-instance deployment topology.
- A shared rate-limiter store for more than one application instance.
