# 0005 — Permission state synced via Discord Gateway events

- Status: Accepted by owner
- Scope: Security / authorization
- Owner: Project owner
- Acceptance evidence: Owner selected "Gateway → BD → evaluar en consulta" during the design
  interview (2026-11-04) after the revocation-window trade-offs were presented.
- Supersedes: none

## Context

Authorization is the product's top priority: each installation serves one guild, and every query
must return only what the requesting user's effective Discord permissions allow. Permissions change
out of band (role changes, channel overwrites, kicks, private thread membership), so query-time
decisions need current permission state. The owner was asked: when an administrator revokes a
user's access at 12:00, how long may that user keep querying the revoked content?

## Decision

The hub persists permission-relevant Discord state (guild members, roles, channel permission
overwrites, thread membership) in PostgreSQL, kept current by the Discord Gateway events the bot
already receives. At query time, the hub evaluates the user's effective permissions per channel
against that stored state. Authorization never calls Discord REST per query.

Missed events — downtime, Gateway reconnect gaps — are repaired by an explicit resynchronization
path rather than by accepting stale authorization reads.

## Alternatives

- Evaluate permissions live via Discord REST on every query: rejected — per-query latency, Discord
  rate limits, and outage coupling make the product fragile; it may still serve specific
  verification flows if a future requirement demands it.
- TTL cache of permission snapshots: rejected — it leaves a minutes-long window in which a revoked
  user keeps reading; unacceptable against the owner's stated priority order (security first).

## Consequences

- Revocation latency is Gateway event latency (seconds), not minutes.
- The bot's event handling becomes part of the security surface: missed, duplicated or
  mis-handled permission events are authorization bugs. Event processing must be idempotent;
  ordering and transactional details belong to the ingestion feature specification.
- The resync path is a security control, not an optimization; it needs its own tests.
- Stored permission state is mutated only by Discord-originated bot events, never by MCP client
  input; the MCP surface is read-only with respect to permission state.

## Verification and adoption

The ingestion and authorization feature specifications must include revocation scenarios (role
removed, member kicked, channel overwrite changed, private thread membership lost) and resync-path
tests, evaluated against an isolated real PostgreSQL database per the persistence guide.
