# 0008 — Semantic search in v1: pgvector with a managed embedding API

- Status: Accepted by owner
- Scope: Architecture / retrieval
- Owner: Project owner
- Acceptance evidence: Owner selected "Meter embeddings en v1" and then "api gestionada, sin límite
  ni logs." during the design interview (2026-11-04).
- Supersedes: the original brief's "later phase" sequencing of semantic search ("Más adelante
  podremos evaluar búsqueda semántica y pgvector"), by explicit owner decision.

## Context

The original brief set SQL + FTS as the v1 retrieval baseline and deferred embeddings. During the
ingestion specification review the owner pulled semantic search into v1 and chose a managed
embedding API over a local model. The permission model ([ADR 0005](0005-gateway-synced-permission-state.md))
must remain the sole access authority regardless of retrieval internals; deletions remain
unrecoverable ([ADR 0007](0007-mirror-message-lifecycle.md)).

## Decision

1. v1 includes semantic search: message embeddings stored with pgvector in PostgreSQL.
2. Embeddings are computed by a decoupled background pipeline that reads stored messages. The
   ingestion path performs no semantic processing (the ingestion specification's R10 holds).
3. Provider: managed embedding API behind a narrow provider contract; first implementation is
   OpenAI `text-embedding-3-small`; provider, model and key come from validated configuration.
   No usage-limit or quota machinery in v1; ordinary technical bounds (batch size, retries,
   backoff) still apply per the shared and gateway guides.
4. No message content in logs anywhere in the pipeline (extends the ingestion specification's R12).
5. Vector lifecycle mirrors the message lifecycle: edits re-embed, tombstoned messages' vectors are
   removed, and query-time filters exclude tombstoned rows regardless of pipeline lag.
6. The permission model is unchanged and is expressed as four testable invariants:
   - I1: ACL evaluation happens at query time over rows; nothing about permissions is baked into
     vectors or indices.
   - I2: the permission filter precedes returning anything to the client; filtering after response
     is a security defect.
   - I3: no precomputed cross-channel derived artifact (tags, clusters, summaries) is user-facing
     in v1; vectors are per-message only.
   - I4: over-fetch strategies in vector search exist for result quality only and never substitute
     the permission filter.
7. Hybrid retrieval (FTS + vector, fused) is the query feature's retrieval baseline; messages not
   yet embedded remain fully reachable through FTS.

## Alternatives

- Local embedding model in a container: rejected by the owner for v1 (RAM/operations weight);
  remains a possible future provider behind the same contract.
- Local and managed both configurable from day one: rejected — duplicate configuration and test
  surface in v1.
- Keeping FTS-only: superseded by this owner decision.

## Consequences

- Message content leaves the host to the embedding provider; operators accept this by configuring
  the API key, and deployment documentation must state it plainly. Provider retention/training
  policies are outside the hub's control: they are documented, not enforceable, by the hub.
- Changing model or dimension requires a full re-embedding through an explicit operational
  procedure, not automated in v1.
- Historical import and embedding lag independently; FTS covers the gap.
- Provider outages pause the pipeline without losing work; progress is resumable by message id and
  model version.

## Verification and adoption

The semantic-index feature specification must test invariants I1–I4, edit re-embedding, tombstone
vector removal, lag behavior and outage resume against isolated PostgreSQL with pgvector, with the
provider behind a test double.
