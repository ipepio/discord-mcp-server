# Semantic index deployment and operations

## Egress and secrets (R9)

**Message content is sent from this host to the configured embedding provider.** The first supported
provider is OpenAI, using `text-embedding-3-small`. Search query text also leaves the host when the
vector branch is requested. Provider retention, training and processing policies are outside the
hub's control; operators must review their provider agreement before configuring a key. The hub
cannot enforce the provider's retention policy. Setting the key and composing this feature opts into
this egress; there is no local-provider implementation or usage-quota machinery in v1.

Keep `EMBEDDING_API_KEY` in deployment secret configuration, never source control or logs. Pipeline
logs contain only fixed diagnostic text and counts, not message/query text, raw provider errors,
response bodies, authorization headers or keys. Provider errors are sanitized before propagation.

## Configuration and composition

Required settings, validated synchronously by `SemanticIndexModule.register(env)`:

| Variable              | Supported v1 value                                        |
| --------------------- | --------------------------------------------------------- |
| `EMBEDDING_PROVIDER`  | `openai`                                                  |
| `EMBEDDING_MODEL`     | `text-embedding-3-small`                                  |
| `EMBEDDING_BASE_URL`  | unset → `https://api.openai.com/v1` (OpenAI-compatible)   |
| `EMBEDDING_API_KEY`   | non-empty provider secret                                 |
| `EMBEDDING_DIMENSION` | exactly `1536`, matching migration `3_message_embeddings` |
| `FTS_LANGUAGE`        | optional: `spanish` (default), `english`, `simple`        |

Registration fails on dimension/model/provider mismatch before constructing a provider or opening
network connections. Values are not interpolated into migrations. The HNSW index uses cosine distance;
the FTS GIN index matches the default Spanish dictionary. Other dictionaries are correct without a
matching index but may require an operator-reviewed additive index migration for large installations.

As with the sibling feature modules, the deployment composition root imports the explicit dynamic
module using the environment obtained from shared configuration:

```typescript
import { SemanticIndexModule } from "./features/semantic-index/index.js";
import { readProcessEnv } from "./shared/config/config.factory.js";

// Within the application's imports:
SemanticIndexModule.register(readProcessEnv());
```

The baseline health-only `AppModule` intentionally does not activate business features. The final
application composition must include this module once, alongside ingestion and query modules; do not
create multiple worker instances. Consumers inject `HYBRID_RETRIEVAL` and depend only on
`HybridRetrieval`, not provider or SQL types. Every request supplies a fresh, authoritative
`accessibleChannelIds` array containing allowed channel AND thread ids. Missing ACL fails; empty ACL
returns no candidates and does not call the provider. Parent access does not imply thread access.
The result contains candidate ids, container ids, timestamps, RRF scores, branch provenance and a
`vectorAvailable` indicator; the query feature owns content loading and external serialization.

## Schema and lifecycle

Use the pgvector-enabled Compose PostgreSQL image. Apply migrations explicitly before starting the
feature; application startup never migrates:

```sh
docker compose run --rm app sh -c "npm ci && npm run migrate"
```

The embedding store has one row per `(message_id, model)`, a foreign key to the stored message, a
content-revision hash and a `vector(1536)` column. It contains no message text, permission snapshots,
tags, summaries, clusters or other cross-channel artifacts. The feature's narrowly authorized SQL
reads ingestion's stored messages for embeddings and retrieval; ingestion remains the sole owner of
message writes.

Migration `4_embedding_lifecycle` installs a stored-state invalidation trigger. An actual content
change or tombstone physically deletes all vectors for the message in the same transaction; a
no-op or rejected/stale ingestion update does not. The worker's guarded upsert locks the message and
compares its current content revision before writing, so an in-flight provider result cannot restore
an obsolete vector. Query-time vector SQL independently excludes tombstones, stale revisions and
foreign models, even if physical cleanup is delayed or a bad row was inserted manually.

## Progress, lag and outages

One serial worker scans missing `(message_id, configured model, current revision)` rows in ascending
message-id order. Persisted vector rows are the resumable cursor; there is no volatile high-water
mark to lose, external queue, or transaction spanning a provider call. Each write commits at most
64 messages. Unicode-heavy text is split into chunks of at most 2,000 code points, provider calls
contain at most 64 chunks, and multiple chunks are averaged into one per-message vector. No derived
cross-message representation is stored. Empty/whitespace and tombstoned messages are not embedded.

The idle poll interval is 1 second; non-empty batches continue immediately, so finite import bursts
are drained in bounded batches. Every provider call has a 10-second timeout and at most three attempts
with 250ms/500ms backoff for network errors, 429 or 5xx. Provider outages pause work for 5 seconds;
credentials/invalid payload failures also pause without advancing persisted progress. Storage errors
are sanitized and retried after 5 seconds. Shutdown cancels future polls and awaits active bounded
work before the pool closes. Actual catch-up lag depends on backlog/provider throughput, not just
the poll interval; no finite lag guarantee is possible during a provider outage or sustained overload.
Monitor batch counts, backlog and provider availability operationally. No message contents are logged.

FTS reads the message store independently and remains reachable during imports, embedding lag or
provider outages. Retrieval degrades to FTS with `vectorAvailable: false` when query embedding fails.
RRF uses offset 60; internal candidate over-fetch is capped at 64 and never replaces either SQL ACL
predicate. Both branches filter allowed ids before ranking/fusion, with a second pre-fusion guard.

## Explicit model/dimension re-embedding procedure (R6)

1. Stop application workers and query traffic. Back up the database using the installation's normal
   recovery procedure; retain the old application/configuration and backup as rollback artifacts.
2. Prepare and review an **append-only** migration plus matching provider/configuration validation
   changes. Never edit an applied migration. A dimension change requires removing the dependent HNSW
   index and replacing the vector column type (or building a replacement table/index); existing
   vectors cannot be reinterpreted as another model/dimension.
3. Explicitly clear the derived `message_embeddings` rows under operator-controlled migration
   credentials. Do not delete, truncate or rewrite ingestion messages. This invalidates only
   regenerable embeddings; a `down` migration cannot restore old vectors without the backup.
4. Apply the reviewed migration, update model/dimension settings and deploy matching validation and
   provider support. Current v1 validation deliberately rejects other models/dimensions until those
   reviewed code/schema changes exist. Dimension mismatch must fail before network activity.
5. Start one worker and allow it to rebuild from stored messages. During rebuild, FTS remains usable;
   vector SQL filters by configured model and never mixes old/new model rows. Verify backlog drain,
   model distribution, edit/deletion tests and retrieval invariants before resuming normal traffic.
6. On failure, stop the new worker and restore the compatible schema/application/configuration plus
   backed-up derived vectors, or rebuild using the old pinned model. Do not reuse vectors produced
   by the failed model under the old model name.

## Verification (repository-level, not cross-feature E2E)

Run `npm run format`, `npm run lint`, `npm run arch`, `npm run typecheck`, `npm test`.
Real SQL evidence uses isolated databases created/dropped by the integration harness, never a shared
application database. The embedding provider is always a test double; no external calls occur:

```sh
export POSTGRES_PASSWORD=$(docker exec <postgres-container> printenv POSTGRES_PASSWORD)
docker compose -p discord-mcp-server-semantic run --rm --no-deps \
  -e TEST_DATABASE_URL="postgres://<db-user>:$POSTGRES_PASSWORD@postgres:5432/postgres" \
  app sh -c "npm ci && npm run test:integration"
```

A worktree needs the test PostgreSQL attached to its own Compose network as `postgres` (with operator
approval). Its project name and node_modules volume must remain lane-specific. Integration suites run
serially to bound DDL pressure; each still owns an independently generated database. Missing PostgreSQL
or pgvector is unavailable evidence, never a pass. The semantic suites cover I1–I4, FTS reachability,
outage/restart catch-up, stale provider writes, physical invalidation and query-time tombstone safety.
