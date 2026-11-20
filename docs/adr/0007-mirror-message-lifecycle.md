# 0007 — The hub mirrors the Discord message lifecycle

- Status: Accepted by owner
- Scope: Business / data lifecycle and privacy
- Owner: Project owner
- Acceptance evidence: Owner selected "Espejo: el hub olvida con Discord" during the design
  interview (2026-11-04).
- Supersedes: none

## Context

Messages are ingested continuously. After ingestion, authors edit or delete messages on Discord.
The owner was asked whether the hub should keep serving deleted content. The hub's security
posture (top owner priority) treats user deletion intent as authoritative; an archive that
outlives Discord would contradict it.

## Decision

The hub is a mirror, not an archive. Edits update the stored content. Deletions tombstone the
message: the row is excluded from every query path and is never returned again. Tombstones are
kept for synchronization idempotency; a tombstone's stored content is physically dropped (owner
decision, 2026-11-04): id, author, timestamps and `deleted_at` remain, text and attachment
metadata are removed.
Channel and thread deletion cascade accordingly. Deleted content is by design unrecoverable
through the hub once Discord deletes it.

## Alternatives

- Archive mode (deleted messages stay queryable): rejected — best information preservation but the
  worst privacy posture, and it contradicts the owner's security-first priority order.
- Operator-configurable policy: rejected for v1 — extra configuration and test surface for a case
  the owner has no current need for; revisit only on a demonstrated requirement.

## Consequences

- Users who delete messages on Discord are respected by the hub immediately after the deletion
  event is processed (latency bounded by Gateway event handling per [ADR 0005](0005-gateway-synced-permission-state.md)).
- Historical research on deleted conversations is impossible by design; this is intended.
- Ingestion must handle edit and delete events idempotently and out-of-order arrivals safely.

## Verification and adoption

The ingestion feature specification must test edit propagation, deletion tombstoning, cascade on
channel/thread deletion, and that no query path (search, history, thread, single message) can
return a tombstoned message.
