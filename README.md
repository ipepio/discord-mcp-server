# Discord MCP Server

A **self-hosted MCP server** that mirrors one Discord guild into PostgreSQL and answers queries with
each user's **real Discord permissions**. Any MCP-compatible client can connect; the client reasons,
the hub retrieves.

- **One installation, one guild, one bot.** Cross-guild work is a client pointed at several hubs.
- **Authorization is the product.** Effective permissions are evaluated per request from
  Gateway-synced state, never from tool arguments and never from the model's judgement.
- **Read-only towards Discord.** The bot never sends, edits, deletes or changes roles. Deletions in
  Discord are mirrored: what Discord deletes, the hub forgets.
- **Retrieval, not reasoning.** Seven tools return structured data; summaries and answers belong to
  the client.

## Quick start

```bash
cp .env.example .env                     # fill in the values described below
docker compose up -d postgres
docker compose run --rm app sh -c "npm ci && npm run migrate"
docker compose up -d app
curl -s http://127.0.0.1:3000/health     # {"status":"ok"}
```

The examples use the default `APP_PORT=3000`, which `docker compose` publishes on the host; substitute
your own value if you changed it.

Then connect any MCP client to `http://127.0.0.1:3000/mcp` (or `<PUBLIC_BASE_URL>/mcp` in production).
The client discovers the authorization server, registers itself and opens the Discord login.

Full instructions — creating the Discord application, which checkboxes matter, and where every
environment variable comes from — are in **[docs/installation.md](docs/installation.md)**.

## What a client can ask for

| Tool                  | Purpose                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `search_messages`     | hybrid search (full text + embeddings), optionally narrowed by channel, author or date range |
| `list_channels`       | the channels and threads the caller may see                                                  |
| `get_channel_history` | chronological messages of one channel, keyset-paginated                                      |
| `get_thread_messages` | messages of one thread, keyset-paginated                                                     |
| `get_message_context` | one message plus its surrounding window                                                      |
| `get_recent_activity` | what is new in one call: recent messages grouped by channel, with per-channel cursors        |
| `get_hub_status`      | the guild this hub serves, whether its registry is current and how many entries it mirrors   |

Attachments are exposed as metadata only; file bytes are never downloaded.

## How it is built

Six features, each owning its language and its data:

```text
discord         single Gateway connection + REST reads (no business state)
guild-state     authoritative permission registry + effective-permission evaluation
ingestion       historical import, continuous sync, edit/delete mirroring
authorization   OAuth 2.1 server, Discord SSO, hub sessions, transport guard
semantic-index  embedding pipeline + hybrid retrieval contract
query           the seven MCP tools and their ACL-scoped reads
```

The conventions for placement, dependencies and verification live in
[AGENTS.md](AGENTS.md) and [docs/architecture/](docs/architecture/structure.md). Significant decisions
are recorded as [ADRs](docs/adr/README.md):

| ADR  | Decision                                                             |
| ---- | -------------------------------------------------------------------- |
| 0001 | Feature-based NestJS shell; framework-free domain                    |
| 0002 | REST + OpenAPI for exposed HTTP APIs (auxiliary endpoints)           |
| 0003 | PostgreSQL through `pg`, no ORM                                      |
| 0004 | MCP over Streamable HTTP is the only functional external contract    |
| 0005 | Permission state synced by Gateway events, evaluated per query       |
| 0006 | Discord SSO with dynamic client registration and hub-issued sessions |
| 0007 | The hub mirrors the Discord message lifecycle (no archive)           |
| 0008 | Semantic search in v1: pgvector with a managed embedding endpoint    |
| 0009 | Refresh token rotation with reuse detection                          |

## Security model in one paragraph

A session proves _who_ is calling. Every read then evaluates that user's effective permissions
(roles, channel overwrites, thread membership, administrator bypass) against stored registry state and
filters rows before anything leaves the server. An inaccessible channel, thread or message is
indistinguishable from one that does not exist. If the registry is not current — during a reconnect
resync — requests are refused rather than answered from stale state.

## Verification

```bash
npm run format && npm run lint && npm run arch && npm run typecheck && npm test
```

Unit and architecture gates run without external services. Repository-level integration tests need a
reachable PostgreSQL with pgvector and an explicit `TEST_DATABASE_URL`; without it they report
unavailable evidence instead of passing silently. See [docs/architecture/testing.md](docs/architecture/testing.md).

## Design

Product and UI directions live under [design/](design/); the login landing is
[design/discord-hub-login/](design/discord-hub-login/design.json) and draws a neutral built-in
wordmark that any installation can replace through `HUB_BRAND_MARK_FILE`.

## Inventory

[CONTENTS.md](CONTENTS.md) indexes every guide, specification and decision record.
