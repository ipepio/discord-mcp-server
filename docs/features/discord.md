# Feature specification — Discord transport (Gateway connection and REST access)

## Goal and source request

- Owner: Project owner
- Source request (recorded owner decision 2026-11-04, quoted from
  [project context](../project-context.md)): "Gateway connection ownership: dedicated `discord`
  feature module owning the single Gateway connection and the normalized event-stream contract."
- Expected outcome: a `discord` feature owning **all** Discord protocol access for the Installation —
  the single Gateway connection (discord.js client) with its full lifecycle, and the shared REST call
  sites, rate-limit aware. It exposes exactly two things: (a) the normalized internal event stream
  [ingestion](ingestion.md) and [guild-state](guild-state.md) subscribe to, and (b) typed REST
  operations implemented behind the narrow gateway contracts those features already define. It holds
  no business state: no tables, no migrations, no domain derivation. Transport ownership only —
  connection, protocol, normalization, delivery. Glossary terms per [CONTEXT.md](../../CONTEXT.md).
- Non-goals:
  - Permission state, permission derivation, bootstrap or resync policy — [guild-state](guild-state.md).
  - Message storage, historical import scheduling, edit/delete mirroring — [ingestion](ingestion.md).
  - Embeddings, retrieval and MCP tools — [semantic-index](semantic-index.md) and the query feature.
  - OAuth2 login, sessions and identity — [ADR 0006](../adr/0006-discord-sso-dynamic-client-registration.md);
    the bot token is not a [User](../../CONTEXT.md) identity.
  - Duplicating, deduplicating, reordering or retrying what consumers already handle: idempotency and
    convergence belong to the consumers (guild-state R9/R10, ingestion R7/R8).
  - Anything that writes to Discord (R8).
- Owning feature and local instructions: `discord` (placement per
  [structure](../architecture/structure.md)); a local `AGENTS.md` is added at implementation only if
  feature-specific invariants emerge.
- Relevant accepted ADRs: [0001](../adr/0001-layer-ownership.md),
  [0004](../adr/0004-mcp-primary-transport.md),
  [0005](../adr/0005-gateway-synced-permission-state.md),
  [0007](../adr/0007-mirror-message-lifecycle.md).

## Prerequisites

- A Discord application/bot member of exactly the configured Guild, with the `GUILDS`,
  `GUILD_MESSAGES` and `MESSAGE_CONTENT` intents enabled and the privileged `GUILD_MEMBERS` intent
  enabled. Those four are the Installation's whole intent requirement; this feature validates them
  for every consumer (R9).
- Validated configuration at startup per the shared/config conventions (no scattered `process.env`
  reads): `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID`, parsed once and shared with the `ingestion` and
  `guild-state` features. v1 adds no variable owned by this feature (`IMPORT_MODE`/`IMPORT_DAYS`
  remain ingestion's).
- Consumers exist that subscribe to the event stream or call the REST contracts: R4/R5 state what
  this feature promises them and what it explicitly does not.

## Behavior

"Connection" means: the single Gateway session this Installation holds with Discord. "Normalized
event" means: an application-typed event this feature publishes on the internal stream, never a raw
payload and never a discord.js object. "Gap" means: any interval in which inbound events may not have
been delivered, whether caused by a disconnect, a failed session resume, a shutdown drain expiry or a
dropped delivery. "Consumer" means: `ingestion`, `guild-state` or a later feature subscribing to the
stream or calling a REST contract.

Each rule states the rule, then a successful example, a rejected/boundary example, and error behavior
where applicable.

- **R1 — Single connection lifecycle.** Exactly one Gateway connection exists per Installation. This
  feature opens it at startup and owns login, session resume and reconnect; no other feature, job or
  test path opens a client, and no code path creates a second concurrent connection — not for
  maintenance, not during a reconnect, not for an administrative read. An unexpected disconnect
  attempts session resume; a resume that Discord rejects is replaced by a fresh identify. The previous
  client is fully destroyed before any re-login is attempted.
  - Example: a 20-second network drop → the client resumes its session, one connection exists
    throughout, and one resync-needed signal is emitted on re-establishment (R5).
  - Boundary: a reconnect loop never escalates into parallel clients; a second `login()` while a
    client is live is a programming error caught in tests, not a supported state. No sharding
    configuration is introduced in v1: one Installation serves one Guild.
  - Error: a login rejection (invalid token, disallowed or disabled intent) fails startup with an
    explicit error naming the cause and no retry loop, before any consumer runs. A connection that
    cannot be recovered is reported as `unavailable` (R11) while reconnects continue with backoff, and
    the feature never degrades into "no connection, no signal, no report".

- **R2 — Source Guild filter.** Every inbound payload is filtered by Guild id **before**
  normalization: only events of the configured Guild are normalized and published. Events of any other
  Guild, and payloads that carry no Guild id at all, are dropped and counted as an anomaly naming the
  Guild id (when present) and the event kind — never normalized, never logged with content.
  - Example: the bot is accidentally invited to guild B → every event from guild B only increments the
    foreign-Guild counter; no consumer ever sees guild B, and no row in any consumer's store carries
    guild B's id.
  - Boundary: an event of the configured Guild about a resource this Installation has not stored (a
    channel created while the hub was down) is still forwarded, so the consumer can run its own resync
    path (guild-state R11) instead of the event being lost at the transport.
  - Error: if the configured Guild is absent from the connection's Guild set (bot removed, or never
    invited), the connection status is `unavailable`, an error naming the Guild id is logged, and the
    stream publishes nothing. Recovery is operator action (re-invite the bot); this feature never
    falls back to another Guild and never invents Guild state.

- **R3 — Event normalization.** Raw Discord events become normalized application events from an
  explicitly enumerated set of kinds; each carries the Guild id, the resource ids and the fields
  consumers need as application types. discord.js objects and raw payloads never cross the stream, and
  absent is never conflated with empty (guild-state R10 states the same distinction for stored state).
  An event kind outside the enumerated set is counted and logged by its raw event name: never silently
  dropped, never mapped to the nearest known kind, never published as an invented kind.
  - Example: a `MESSAGE_CREATE` in a registered channel → one `message-created` event carrying Guild
    id, message id, channel id, author id, Discord timestamps, message type, reply reference, attachment
    metadata and the message's current content. Content rides in memory because ingestion stores it;
    this feature never logs it (R11).
  - Boundary: an unknown kind increments the unknown-kind counter keyed by raw event name, so the gap
    is visible as a counter rather than as silence. A known kind whose payload is missing a required
    id or carries a malformed snowflake is rejected and counted per kind instead of being published
    with fabricated fields.
  - Error: a normalization failure never aborts the connection and never blocks other kinds; it is
    logged with ids, the kind and the failing field path only. Resource-level recovery is the
    consumer's resync (R5, guild-state R11), and the counter is the evidence that it was needed.

- **R4 — Delivery semantics.** Delivery is at-least-once, in the order the connection received the
  events; ordering across a reconnect is not guaranteed. This feature performs no deduplication and
  promises no convergence — consumers own both (guild-state R9/R10, ingestion R7/R8) and are written
  to be replayed safely.
  - Example: after a reconnect Discord replays events this feature already delivered → both deliveries
    reach the consumer, in order; the consumer's second application is a no-op.
  - Boundary: nothing is buffered across a process restart. Events that arrived but were not delivered
    before shutdown are lost and declared as a gap (R6), so consumers converge by resync (R5) rather
    than by expecting a replay log this feature does not keep (R10).
  - Error: a consumer handler that throws is isolated — the failure is logged with ids, counted as a
    delivery failure for that kind, and never stops delivery to other consumers or to the connection.
    The failing delivery is not retried by this feature; the consumer's own error path and resync
    (guild-state R11, ingestion R9) recover it. Independently of the dispatch policy finally chosen
    for O1, a delivery dropped for any reason — including consumer backpressure overflow — is itself
    declared: this feature publishes a `resync-needed` signal naming the affected kinds, so no drop
    is ever silent.

- **R5 — Reconnection signaling (resync-needed).** Every transition into a connected state publishes
  exactly one `resync-needed` signal on the stream, including the first connection after process start,
  because the process cannot know what changed while it was not connected. The signal names the
  connection epoch it opens, the number of reconnect attempts it summarizes and the instant of the last
  event delivered before the gap (absent when there was none). It is how guild-state R11 and ingestion
  R9 are triggered; a gap is never masked by a successful resume, and no consumer has to poll the
  connection status to discover one.
  - Example: hub down for 10 minutes → on reconnect one signal; guild-state starts its resync and
    ingestion backfills its window from it. Neither consumer polls.
  - Boundary: many failed attempts before a connection succeeds produce one signal, not one per
    attempt, and the attempt count keeps a pathological loop visible. The signal is published only after
    the connection is usable; a connection that dies immediately still counts, and the next successful
    connection publishes its own signal.
  - Error: if the connection cannot be established at all, no signal is published and the status is
    `unavailable` (R2, R11) — the absence of a signal is never evidence of "no changes".

- **R6 — Clean shutdown.** On a process shutdown signal this feature stops accepting new inbound
  payloads, delivers the events already normalized within a bounded drain window, then closes the
  connection. Events still undelivered when the window expires are counted and logged by kind, and the
  shutdown is recorded as a gap that the next start's `resync-needed` signal covers (R5). Every event
  is therefore either delivered or counted as part of a declared gap: no silent loss.
  - Example: SIGTERM with three pending events → all three delivered inside the window, connection
    closed, no gap recorded, counters flushed to the log.
  - Boundary: a drain that exceeds its window ends deliberately with the undelivered count per kind and
    a gap marker; the window is never extended indefinitely and the drain never truncates silently.
  - Error: a connection that will not close cleanly is logged and shutdown proceeds; the next start's
    resync covers consumers either way.

- **R7 — REST operation ownership.** Every Discord REST call this Installation makes goes through this
  feature's Discord gateway adapter: Guild snapshot, role list, channel list with permission
  overwrites, paginated member roster, channel message history pages and thread-member reads where the
  API allows them. The adapter is the only place discord.js REST types exist; it returns application
  types and validates the external payload before any result leaves the boundary. Each call has an
  explicit timeout, a bounded page/batch size, a bounded pagination limit and bounded retries with
  backoff for identified transient failures; a client error is returned as a named technical failure
  rather than retried.
  - Example: a 12 000-member roster → bounded pages, each page retried independently on a rate-limit
    response, returned as application-typed members; a partially fetched roster is never reported to
    the caller as complete.
  - Boundary: rate-limit awareness stays inside the adapter — it waits within its budget instead of
    failing fast or spawning parallel requests; whether that budget is process-global or per-feature is
    O2. A history read is a read: it never mutates, re-fetches nothing it was not asked for, and pages
    are returned exactly as Discord ordered them.
  - Error: a payload that fails validation (missing required id, unexpected type, unresolvable
    overwrite target) raises a technical error naming the operation and the offending field path —
    never a partially populated result, never a fabricated default, never a silently shortened page.
    Timeout and retry exhaustion surface the same way, so a consumer distinguishes "no data" from
    "could not read".

- **R8 — Read-only over Discord.** The bot never writes anything to Discord: no messages, edits or
  deletions, no reactions, no threads opened, no role or Membership changes, no channel or overwrite
  changes, no direct messages. Every REST operation this feature exposes is a read and every Gateway
  interaction is a receive.
  - Example: a consumer request equivalent to "close this thread" has no operation available, because
    no write exists on the adapter's contract.
  - Boundary: the prohibition is structural — the adapter's public contract contains no write
    operation and its discord.js usage calls no mutating method, so the read-only property survives
    future feature additions rather than relying on reviewer memory (see Implementation and proof).
  - Error: an authorization failure or rate limit on a read is surfaced as a technical failure; it
    never triggers a write, a retry with different permissions, or a downgrade to invented data.

- **R9 — Configuration and intent validation.** `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` and the
  required intents are parsed and validated once at startup through the shared configuration path
  ([shared guide](../architecture/shared.md)); no scattered `process.env` reads exist in this feature
  or in its consumers. Required intents: `GUILDS`, `GUILD_MESSAGES`, `MESSAGE_CONTENT`,
  `GUILD_MEMBERS`. A missing, disabled or malformed item fails startup with an explicit error naming
  it, before any network activity — the same treatment ingestion gives `MESSAGE_CONTENT` and
  guild-state gives `GUILD_MEMBERS`.
  - Example: a deployment without the privileged `MESSAGE_CONTENT` intent enabled in the Discord
    developer portal → startup fails naming `MESSAGE_CONTENT`; the fake client records zero connection
    attempts.
  - Boundary: each consuming feature's prerequisite section names the intents it depends on; this
    feature owns their single startup validation, so a missing intent fails once, loudly, instead of
    failing later per consumer with partial data.
  - Error: a `DISCORD_GUILD_ID` that is not a snowflake fails the same way. The hub never falls back
    to "the first Guild the bot belongs to".

- **R10 — No business state.** This feature owns no table, no migration, no repository, no durable
  cursor and no domain derivation. It owns the connection, the protocol, the normalization and the
  delivery; restart safety comes from consumers' idempotency and resync, never from state stored here.
  - Example: restarting the process rebuilds the connection from configuration and publishes the
    `resync-needed` signal; not one row in PostgreSQL changed because of this feature.
  - Boundary: counters and connection status are in-process and reset on restart; this feature's
    contract promises no durable metrics. Where a consumer wants durable proof, it stores it.
  - Error: a requirement that would need durable transport state — a replay log, a persisted cursor, a
    cursor-based replay API for consumers — is a design change for its own decision, not an addition
    slipped in here.

- **R11 — Observability and log safety.** The feature exposes connection status (`disconnected`,
  `connecting`, `connected`, `unavailable`) and counters: events received, normalized per kind, dropped
  as foreign Guild, rejected by payload validation, unknown kind, delivery failures, reconnect count;
  plus the last connect and disconnect instants. Logs and counters carry Guild, channel, message, role,
  thread and User ids, kinds, field paths and counts — never message content, attachment content,
  tokens, authorization headers or full response bodies
  ([shared guide](../architecture/shared.md)).
  - Example: an unknown event kind logs the raw event name and increments the counter keyed by it; a
    rate-limit response logs the route and the wait, not the body.
  - Boundary: message content passes through this feature in memory because ingestion stores it; it is
    excluded from every log line and every error message, including validation failures that quote a
    field (R3). A test scans emitted logs for a fixture content string and a fixture token.
  - Error: when a log call would include content or a credential, the field is replaced by ids — log
    safety never blocks or delays delivery.

## Contracts and boundaries

- Exposed transport: none. This feature owns no REST endpoint and no MCP tool
  ([ADR 0004](../adr/0004-mcp-primary-transport.md)). Its public surface is the intentional `index.ts`
  exports below; no consumer imports its discord.js usage, its client instance or its internals
  ([structure](../architecture/structure.md)).
- Event-stream subscription contract (consumed by `ingestion` and `guild-state`): a consumer registers
  one handler per normalized event kind at composition time and receives application-typed events; it
  cannot pull raw payloads, inspect the connection or subscribe to "all raw events". Subscription is
  resolved in the composition root, not discovered at runtime.
  - Kinds consumed by `guild-state` (its Contracts section): `guild-updated` (the Guild
    snapshot/create/update), `role-created`, `role-updated`, `role-deleted`, `member-added`,
    `member-updated`, `member-removed`, `thread-member-added`, `thread-member-removed`, the channel/
    thread kinds below, and `ban-added`/`ban-removed` once guild-state adopts them (its Contracts
    section keeps them conditional).
  - Kinds consumed by `ingestion` (its R2 and Contracts section): `message-created`,
    `message-updated`, `message-deleted`, `message-bulk-deleted`, and the channel/thread kinds below
    for structure-change reactions.
  - Kinds consumed by both: `channel-created`, `channel-updated`, `channel-deleted`, `thread-created`,
    `thread-updated`, `thread-deleted`.
  - Signaling kind consumed by both: `resync-needed` (R5).
  - Raw Discord event names appear in this specification only for recognition inside R3; the stream
    speaks normalized kinds.
- REST operations implemented behind consumer-owned contracts (this feature supplies the discord.js
  call sites; the contract interfaces stay with the feature that needs them):
  - `GuildStateGateway`, owned by [guild-state](guild-state.md): Guild snapshot, role list, channel
    list with permission overwrites, paginated member roster, thread-member reads where the API allows
    them.
  - Ingestion's history-backfill read, owned by [ingestion](ingestion.md): channel message history
    pages with bounded cursors, returned as application-typed messages.
  - Every operation is rate-limit aware, batched, timed out, bounded in retries with backoff, and
    validated before returning (R7). No discord.js type, raw payload or REST response object crosses
    either contract.
- Explicitly **not** owned here: business state of any kind (tables, migrations, repositories,
  cursors), permission derivation (guild-state), message storage and lifecycle mirroring (ingestion),
  resync policy — scope, cadence, ordering and status reporting (guild-state R11, ingestion R9), and
  consumer idempotency or convergence. This feature reports gaps; it does not repair them.
- Configuration: `shared/config` owns parsing and validation; this feature declares the token, Guild id
  and intent requirements (R9) and reads them once. No consumer re-reads them from the environment.
- Composition and cycle avoidance: this feature imports only the *types* of the consumer-owned gateway
  contracts, and consumers import only this feature's public event types; instances are wired in the
  application composition module, so no feature imports another's module, controller or adapter
  ([structure](../architecture/structure.md), [shared](../architecture/shared.md)). The Nest module
  provides resolved instances with explicit tokens or factories, never arrays of constructors.
- Transactions and consistency: none. This feature issues no SQL and therefore owns no transaction
  boundary; a Discord REST call never sits inside a consumer's transaction, and a consumer must not
  hold one across a call to these contracts.
- Retry/idempotency: REST reads are safe to repeat by construction; retries are bounded with backoff
  and only for identified transient failures (R7). Gateway delivery is at-least-once with no
  deduplication (R4).
- Compatibility: additive. The normalized event kinds and the connection-status contract are a
  cross-feature contract other features and their tests depend on; adding a kind is additive, while
  renaming, removing or changing the shape of a kind is a breaking change needing an explicit decision,
  not a rename in passing.

## Implementation and proof

- Minimal affected paths: `src/features/discord/` — `discord.module.ts` (composition), the raw
  connection lifecycle adapter in `gateways/`, the Discord REST adapter and its rate-limit/retry
  handling in `gateways/`, normalized event types in `models/domain/`, raw→normalized mappers in
  `models/mappers/`, the event-stream contract and implementation, a connection-status query, and
  `index.ts` as the intentional surface; plus the shared configuration entries and the application
  module wiring. No `repositories/` directory, no migrations, no controllers.
- Tests per rule with discord.js behind test fakes: the client and the REST layer are replaced by a
  test double exposing the same seams (emit a raw event, simulate a resume rejection, a disconnect, a
  rate-limit response, a 5xx, a malformed payload, a shutdown signal). No test contacts Discord and no
  test needs a database.
  - R1: one client instance across reconnects; a second `login()` while live fails; a login rejection
    fails startup with no retry loop.
  - R2: a foreign-Guild event is dropped and counted with no published event; a configured-Guild event
    for an unknown resource is still published; a missing configured Guild yields `unavailable` and no
    published event.
  - R3: one mapping test per kind, field by field, including an absent optional field versus an empty
    value; an unknown raw kind increments its counter and publishes nothing; a malformed payload is
    rejected, counted and publishes nothing.
  - R4: duplicate published events reach a recording handler twice and in order; a throwing handler
    does not stop other handlers nor the connection; nothing survives a restart.
  - R5: exactly one `resync-needed` per successful connection — first connect, resume success, failed
    resume, and a loop of failed attempts summarized into one signal with its attempt count; no signal
    while disconnected.
  - R6: drain delivers the pending events inside the window; expiry emits the undelivered count per
    kind and marks a gap that the next start's signal reflects; the connection is closed.
  - R7: timeout propagation; bounded retry with backoff on 429 and 5xx; no retry on a client error;
    pagination and batch bounds; a payload failing validation raises a technical error naming the field
    path; a partially fetched roster is never reported as complete.
  - R8: structural test — the adapter's discord.js usage calls no mutating method and the public
    contract exposes no write operation.
  - R9: startup failure per item (token, Guild id, each of the four intents), each asserted before any
    connection attempt (the fake records zero calls).
  - R10: structural test — no repository, migration or feature-owned table; a restart resets status and
    counters and persists nothing.
  - R11: counter coverage per scenario above (foreign Guild, unknown kind, rejected payload, delivery
    failure, reconnect); a log scan asserts the fixture message content and the fixture token appear in
    no emitted log line.
- No PostgreSQL integration tests apply to this feature: it owns no table and issues no SQL. Database
  evidence lives with guild-state and ingestion against an isolated PostgreSQL database
  ([testing guide](../architecture/testing.md)).
- Actual verification commands: none exist yet; recorded in
  [project context](../project-context.md) when implementation is authorized.
- Documentation updates at implementation: project-context feature section, `CONTENTS.md` entry, a local
  `AGENTS.md` only if invariants emerge, and the sibling cross-references if a contract name changes.

## Decisions (2026-11-04)

- Connection ownership: a dedicated `discord` feature owns the single Gateway connection and the
  normalized event-stream contract; ingestion and guild-state subscribe and open no connection of their
  own (recorded in [project context](../project-context.md); closes ingestion's former O1).
- Intents: `GUILDS`, `GUILD_MESSAGES`, `MESSAGE_CONTENT`, `GUILD_MEMBERS`; a missing or disabled intent
  is a startup failure with an explicit error, before any network activity (R9).
- Guild filter at the source: only the configured Guild's events are normalized and published; foreign
  Guilds are dropped and counted (R2), which is what makes the siblings' R1 enforceable at the
  transport.
- Read-only bot: this feature never writes anything to Discord (R8).
- No business state: no tables, no migrations, no domain derivation in this feature (R10).
- REST ownership: the shared Discord REST call sites live here behind the consumers' own narrow gateway
  contracts; use cases never see discord.js types ([shared guide](../architecture/shared.md)).

## Open decisions

- **O1 — Backpressure for slow event-stream consumers.** Question: when a consumer's handler is slower
  than the inbound event rate, does this feature (a) buffer in a bounded queue and drop-and-count on
  overflow, (b) apply backpressure that delays delivery to that consumer, or (c) drop per kind and
  immediately publish an additional `resync-needed` so the consumer repairs rather than silently
  missing state? Consequence: every drop is a gap; if a drop is not surfaced as a signal, guild-state
  (R11) and ingestion (R9) can only repair it by luck, and a silent correctness hole appears in a
  security-relevant path ([ADR 0005](../adr/0005-gateway-synced-permission-state.md)). Owner: Project
  owner. Resolution trigger: before implementing the dispatch queue, with measured evidence from a
  deliberately slow subscriber test.
- **O2 — REST rate-limit budget scope.** Question: is the Discord REST rate-limit budget managed
  globally for the process (one budget shared by bootstrap, resync and backfill) or per consumer
  feature? Consequence: independent budgets multiply requests against the single bot token and invite
  429 storms; one global budget serializes a long historical backfill behind a permission resync unless
  a priority rule is defined, and delaying the resync delays a security control. Owner: Project owner.
  Resolution trigger: before implementing the REST adapter's rate-limit handling, once ingestion's
  backfill and guild-state's resync can be measured together.
