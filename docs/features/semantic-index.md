# Feature specification — Semantic index (embeddings + hybrid retrieval)

## Goal and source request

- Owner: Project owner
- Source request (verbatim, design interview 2026-11-04): owner selected "Meter embeddings en v1"
  and then "api gestionada, sin límite ni logs."
- Expected outcome: message embeddings kept converged with the message store by a decoupled
  pipeline, and a hybrid retrieval contract (FTS + vector) that the query feature consumes under
  the permission invariants of [ADR 0008](../adr/0008-semantic-search-v1-pgvector.md).
- Non-goals: tags, clusters or any cross-channel derived artifact (invariant I3); the MCP query
  tools themselves (query feature specification); a local embedding provider; usage-quota machinery.
- Owning feature and local instructions: `semantic-index`; local `AGENTS.md` at implementation only
  if feature-specific invariants emerge.
- Relevant accepted ADRs: [0001](../adr/0001-layer-ownership.md), [0003](../adr/0003-postgresql-without-orm.md),
  [0005](../adr/0005-gateway-synced-permission-state.md), [0007](../adr/0007-mirror-message-lifecycle.md),
  [0008](../adr/0008-semantic-search-v1-pgvector.md).

## Prerequisites

- The pgvector extension available in the deployment's PostgreSQL.
- Validated configuration at startup: `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`,
  `EMBEDDING_API_KEY`, `EMBEDDING_DIMENSION` (integer; must match the migration's vector column
  type — a mismatch fails startup before any network activity).

## Behavior

"Embedded" means: a vector computed by the configured provider for the message's current content
and stored in PostgreSQL. "Excluded" follows the ingestion specification's definition.

- **R1 — Decoupled pipeline.** Embeddings are computed by a background worker that reads stored
  messages; the ingestion path is unchanged and performs no semantic processing. Messages remain
  fully reachable through FTS before they are embedded.
    - Example: mid-import, a channel already stored but not yet embedded → `search_messages` (FTS
      branch) finds its messages; the vector branch simply omits them until embedded.
- **R2 — Coverage and lag.** Every non-tombstoned message with non-empty text content is embedded
  within a bounded lag after it exists in the store; the pipeline catches up after historical
  import bursts. Attachment-only and system-only messages (no text) are not embedded. Logs carry
  counts and ids, never content.
- **R3 — Edit re-embedding.** When a message's stored content changes (ingestion R5), its vector is
  replaced. A stale vector never survives its message's edit; convergence follows stored content,
  not arrival order.
- **R4 — Deletion.** When a message is tombstoned (ingestion R6), its vector is removed within a
  bounded lag; independently, every vector search excludes tombstoned rows at query time, so
  pipeline lag can never expose deleted content ([ADR 0007](../adr/0007-mirror-message-lifecycle.md)).
- **R5 — Provider isolation.** Embeddings are computed through the provider contract (managed API,
  first implementation OpenAI `text-embedding-3-small`). The API key lives in configuration, never
  in code or logs. Provider calls use bounded batches, timeouts, retries with backoff; a provider
  outage pauses the pipeline and resumes idempotently (cursor: message id + model version). No
  usage-quota machinery exists in v1; no message content is logged anywhere in the pipeline.
- **R6 — Model pinning.** Each vector row records the model that produced it. Query-time query
  embedding uses the same configured model. Changing `EMBEDDING_MODEL` or `EMBEDDING_DIMENSION`
  requires the explicit documented re-embedding procedure; vectors of a foreign model are never
  mixed into one search.
- **R7 — Hybrid retrieval contract (consumed by the query feature).** Candidate sets come from the
  FTS branch and the vector branch (nearest neighbors of the query embedding). The permission
  filter ([ADR 0005](../adr/0005-gateway-synced-permission-state.md)) applies to candidates before
  fusion and before anything leaves the server (invariants I1, I2). Vector-branch over-fetch is
  allowed as a quality measure only (invariant I4). Fusion ranks a combined candidate set; results
  carry provenance (channel, thread, timestamps) like any other read path.

    Optional channel, author and inclusive date filters are SQL predicates in both branches before
    candidate limits and fusion, independently of the mandatory ACL set. Retrieval accepts a validated
    keyset cursor `{ score, messageId }`, ordered by score descending then message id ascending; the
    fixed bounded 64-candidate horizon per branch keeps scores independent of page size for a fixed
    corpus/query. Corpus changes can re-rank results, as documented by query R4. The public injection
    token is `QUERY_HYBRID_RETRIEVAL` (also exported as `HYBRID_RETRIEVAL`); the producer owns both the
    application input contract and its query-facing compatibility projection.

- **R8 — Per-message vectors only.** No tags, clusters, summaries or any precomputed cross-channel
  artifact exist in v1 (invariant I3).
- **R9 — Egress disclosure.** Deployment documentation must state that message content is sent to
  the configured embedding provider, and that the provider's retention policy is outside the hub's
  control ([ADR 0008](../adr/0008-semantic-search-v1-pgvector.md)).

## Contracts and boundaries

- Provider gateway: this feature owns the external HTTP contract to the embedding provider
  (narrow `EmbeddingProvider` contract; discord-style gateway rules apply: timeouts, bounded
  retries, response validation, no raw SDK types in use cases).
- Worker semantics: internal background loop over a `message_id + model` cursor; no external queue
  dependency in v1; idempotent by construction.
- Repository contracts: upsert vectors (batch), delete by message ids, fetch next unembedded
  batch, nearest-neighbor search pre-filtered by model and tombstone state — parameterized SQL
  with pgvector operators ([persistence guide](../architecture/persistence.md)).
- Retrieval contract: the query feature consumes a search/candidates contract owned here; it never
  imports embedding tables or provider types directly.
- Transactions: vector writes commit in small batches; no transaction spans a provider call.
- Compatibility: additive; the embedding table is keyed by message id and model.

## Implementation and proof

- Migrations (append-only): enable pgvector; `message_embeddings` table (message id FK, model,
  embedding `vector(<dimension>)`) with an HNSW index; dimension fixed by migration, changed only
  by the documented re-embedding procedure.
- Tests per rule: R1 structural + FTS-reachability while unembedded; R2 lag/catch-up against real
  PostgreSQL; R3 stale-vector guard; R4 vector removal + query-time exclusion even with pipeline
  "behind"; R5 outage pause/resume (provider test double), key-not-logged scan; R6 startup failure
  on dimension mismatch, foreign-model vectors never fused; R7 invariant tests I1/I2/I4 with
  fixture permissions (user lacking channel access never sees candidates from it, before and after
  fusion); R8 structural (no derived artifacts); R9 documentation check.
- Safe isolated setup: dedicated PostgreSQL with pgvector, explicit test connection; provider
  behind a test double (no external calls in tests); missing pgvector is unavailable evidence,
  never passed.
- Actual verification commands: `npm run format`, `npm run lint`, `npm run arch`,
  `npm run typecheck`, `npm test`, and the isolated in-compose `npm run test:integration` harness.
- Deployment, egress disclosure and explicit re-embedding procedure:
  [semantic index operations](../deployment/semantic-index.md).
- Documentation updates: project-context feature section, CONTENTS, deployment docs (R9).

## Decisions (2026-11-04)

- Fusion method: Reciprocal Rank Fusion as the v1 starting point; revisit with real data in the
  query feature specification.
- Vector index: HNSW by default; IVFFlat remains an alternative if scale measurements justify it.
