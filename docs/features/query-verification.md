# Query implementation and verification — 2026-11-06

Scope: query ODD T1–T7, implemented in order on `feat/query`, one commit per task. No running-server
client session or composed cross-feature E2E flow was built. The final T7 hash is supplied with the
worker completion receipt (a commit cannot embed its own hash).

## Per-task gate evidence

Each row ran, in order, `npm run format`, `npm run lint`, `npm run arch`, `npm run typecheck`, and
`npm test`, all with exit 0 before committing. Typecheck covers source, tests and migrations.
Counts below are observed Vitest output, not estimates; integration is reported separately.

| Task | Commit                            | Unit files / tests passed | Specification coverage                                                                                                                              |
| ---- | --------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | `82d505f`                         | 58 / 832                  | R2/R4/R6/R9 repository prerequisites: mandatory live ACL scope, unconditional tombstones, keyset, candidates and anchor windows                     |
| T2   | `c54d1f7`                         | 59 / 837                  | R2/R3 shared visibility/content gates and technical-error distinction; individual-tool not-found semantics completed in T5                          |
| T3   | `53dff50`                         | 60 / 851                  | R1/R4 closed published inputs, unsupported identity rejection, bound defaults, decoded cursor validation and tool/filter binding                    |
| T4   | `02f7667`                         | 61 / 855                  | R5 and R2/R3 candidate contract: pre-fusion mandatory accessible IDs, page-level degradation marker, defensive scope rejection and technical errors |
| T5   | `633930f`                         | 62 / 860                  | R7 T1–T5 public application queries, provenance, thread identity, context and not-found outputs                                                     |
| T6   | `d706fd3`                         | 63 / 865                  | R6/R10 real-SQL tombstone/deleted-container exclusion across tools and repository operations; explicit content and response bounds                  |
| T7   | final T7 commit; receipt has hash | 66 / 885                  | R8/R9/R11, all named security tests, MCP adapter, metadata, explicit Nest composition, structural negative fixture                                  |

Final architecture output: `no dependency violations found (161 modules, 762 dependencies cruised)`.
Final `npm run build` also exited 0. An active LSP probe checked 35 paths with zero reported errors:
20 confirmed clean, 15 inconclusive because their server did not confirm a clean re-check; the full
TypeScript compiler checks above are the complete executable type evidence, not that inconclusive probe.

## Files per task

All feature paths below are relative to `src/features/query/`; test paths are repository-relative.
The T7 modifications to earlier-task files are additive hardening and final schema/wiring alignment.

- **T1**: `models/domain/message.ts`, `repositories/message-read.repository.ts`,
  `repositories/postgres-message-read.repository.ts`, `tests/integration/query-message-read.integration.test.ts`,
  `odd/tasks/query.md`.
- **T2**: `models/domain/query.errors.ts`, `queries/query-access.policy.ts`,
  `tests/features/query/query-access.test.ts`.
- **T3**: `models/domain/tool-input.ts`, `models/dtos/tool-schema.dto.ts`, `queries/query-cursor.ts`,
  `tests/features/query/tool-input.test.ts`.
- **T4**: `queries/hybrid-retrieval.contract.ts`, `queries/search-candidates.query.ts`,
  `tests/features/query/search-candidates.test.ts`.
- **T5**: `models/domain/tool-result.ts`, `queries/get-channel-history.query.ts`,
  `queries/get-message-context.query.ts`, `queries/get-thread-messages.query.ts`,
  `queries/list-channels.query.ts`, `queries/message-results.ts`, `queries/search-messages.query.ts`,
  `tests/features/query/retrieval-tools.test.ts`.
- **T6**: `queries/query-payload.policy.ts`; payload integration in all five T5 query files plus
  `models/domain/tool-result.ts`; `src/shared/config/query-config.factory.ts`,
  `tests/features/query/payload-bounds.test.ts`, `tests/integration/query-message-read.integration.test.ts`,
  `tests/integration/query-tool-fixture.ts`.
- **T7**: `index.ts`, `query.module.ts`, `query.tokens.ts`, `mcp/query-tools.adapter.ts`,
  `queries/get-server-metadata.query.ts`, final `models/dtos/tool-schema.dto.ts`;
  `tests/features/query/mcp-adapter.test.ts`, `tests/features/query/query-module.test.ts`,
  `tests/features/query/read-only-structure.test.ts`, `tests/integration/query-security.integration.test.ts`;
  additional pagination assertions in the T4/T5 test files; single-entry response-cap content
  fallback in `queries/query-payload.policy.ts` and its payload-bound tests; named startup errors in
  `src/shared/config/query-config.factory.ts`; `.depcruiser.cjs` and its negative fixture
  `tests/architecture/boundary-rules.test.ts`; `.env.example`, `CONTENTS.md`, `docs/project-context.md`,
  `docs/features/query.md`, this report and `odd/tasks/query.md`.

## Real PostgreSQL evidence (not E2E)

The first exact requested command derived a worktree-specific compose network without PostgreSQL and
timed out at 200 seconds. An early attempt to use the main project's network was abandoned after the
coordinator mandated dedicated project/volume isolation; its result is not claimed as evidence.
All successful runs used **only** the dedicated `query-lane` Compose project, its own
`query-lane-node-modules` volume and a PostgreSQL attached under the `postgres` alias. No `compose down`, shared-volume
removal, shared-table truncation or production cleanup was run.

The successful initial isolated command ran `npm ci && npm run test:integration`: **8 files / 146
tests passed**, exit 0. After T6, **8 files / 147 tests passed**, exit 0. Final T7 and final-source rerun:
**9 files / 154 tests passed**, exit 0, with all six security names explicitly present in the real SQL
suite. The authorization, registry and retrieval seams are contractual doubles; only this feature's
message reads and ingestion-owned message tables are real. No semantic table/provider is imported.
The read-only proof hashes message rows and compares registry contractual fixture state, rather than
claiming to snapshot a parallel lane's unavailable embedding tables.

Reproduction (password is obtained from the running service, never recorded here):

```sh
export POSTGRES_PASSWORD="$(docker exec <postgres-container> printenv POSTGRES_PASSWORD)"
# Connect the database once; already-connected is not an error requiring a replacement network.
docker network connect --alias postgres query-lane_hub <postgres-container>
# Dependencies were installed by the initial lane-private-volume npm ci run.
docker compose -p query-lane run --rm --no-deps \
  -v query-lane-node-modules:/srv/app/node_modules \
  -e TEST_DATABASE_URL="postgres://<db-user>:$POSTGRES_PASSWORD@postgres:5432/postgres" \
  app sh -c 'npm run test:integration'
```

Observed T7 create/drop evidence (a later final rerun creates new randomized names):

```text
created isolated database "it_guild_state_query_reads_6295241ffd1b"
created isolated database "it_guild_state_query_security_d72557a043e5"
applied 3 migration(s) into each: 0_noop-baseline, 1_guild_state_registry, 2_ingestion_messages
isolation confirmed before setup: connected to each owned database with the registry schema
dropped isolated database "it_guild_state_query_reads_6295241ffd1b"
dropped isolated database "it_guild_state_query_security_d72557a043e5"
Test Files 9 passed (9)
Tests 154 passed (154)
exit=0
```

No new dependency, ORM, migration, write operation or external client was added.

## Public seams and coordinator merge work

1. **Guild state:** real public-barrel types and tokens are used. The existing
   `ListUserAccessibleChannelsQuery` already runs effective-permission derivation over one snapshot;
   query consumes its VIEW_CHANNEL-filtered entries and their `canReadMessageHistory` fact. It does
   not rederive permissions or call a point evaluator in a per-channel round-trip loop. The coordinator
   approved the additive `name`/`position` entry amendment; until merged, tests use that exact extended
   structural seam. Live IDs omit deleted channels and threads under deleted parents, which is the
   explicit deleted-container SQL predicate source approved by the coordinator.
2. **Hybrid retrieval:** `HybridRetrieval` is a local consumer contract, not an import from the parallel
   semantic lane. `execute` receives query, guildId, accessibleChannelIds, optional channelId/authorId/
   from/to/after and limit; returns candidates with messageId/channelId/parentChannelId/createdAt/rank
   plus `retrieval`. The producer must permission-filter **before fusion**; query independently rejects
   unexpected scope and rereads candidate IDs through its tombstone/ACL-scoped SQL contract. Adapt the
   semantic public seam at application composition if its names differ; never import its implementation.
3. **Identity:** `QuerySessionIdentity` matches authorization's committed `AuthenticatedPrincipal`
   exactly: `{ userId: string, sessionId: string, expiresAt: Date }`. The authenticated transport must
   pass `request.authorizationPrincipal` per request and keep `McpAuthenticationGuard` on **every**
   request including stream continuations; query parses no token and imports no authorization code.
4. **Composition:** `QueryModule.register({ imports, config: loadQueryConfig(startupEnvironment) })`
   wires real use cases, read repository, metadata and MCP adapter behind explicit public tokens. Root
   supplies modules exporting the registry tokens and `QUERY_HYBRID_RETRIEVAL_TOKEN`; the Nest smoke
   test proves every provider resolves and dispatches a real query. Authorization's Streamable HTTP
   owner mounts `QUERY_TOOLS_ADAPTER_TOKEN.handle(envelope, request.authorizationPrincipal)` and calls
   `QUERY_SERVER_METADATA_TOKEN.execute()` per connection. This lane deliberately does not mount an
   unguarded endpoint or fabricate unavailable parallel feature modules in `AppModule`; final merged
   composition is coordinator work, and a running-server client session stays FINAL-phase work.

## Schema and payload decisions

`src/features/query/models/dtos/tool-schema.dto.ts` is the sole tool declaration/validation/discovery
source. Exactly five tools are emitted, all closed; unsupported identity-like and prototype-property
names are rejected before status, permission or message reads. Output schemas document stable errors
without any permission-denied code, context truncation and nonempty thread-page provenance.

The MCP 2025-06-18 tools specification and its versioned TypeScript schema were fetched to confirm
`outputSchema`, `structuredContent`, `isError` and the four approved annotation hints. Text content is
a fixed acknowledgement, with data in `structuredContent` only; this deliberately avoids duplicating
large data while respecting the byte budget. Query payload accounting reserves 1024 bytes for
protocol framing. Irreducible metadata fails with atomic `internal_error`, never silent field loss.
Configuration defaults and the absence of an observed import distribution are recorded honestly in
the normative spec's implementation-resolution section.
