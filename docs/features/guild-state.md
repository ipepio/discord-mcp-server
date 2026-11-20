# Feature specification — Guild state (permission registry)

## Goal and source request

- Owner: Project owner
- Source request (verbatim, design interview 2026-11-04): owner selected
  "Gateway → BD → evaluar en consulta" after the revocation-window trade-offs were presented
  ([ADR 0005](../adr/0005-gateway-synced-permission-state.md)).
- Expected outcome: a `guild-state` feature holding the authoritative PostgreSQL registry of the
  Guild configured for this Installation and of its permission state — the Guild, its roles, its
  channels and threads with their permission overwrites, the Membership roster with role membership,
  and private-thread membership — kept current from Discord Gateway events plus a REST bootstrap. It
  exposes the effective-permission evaluation use case as its public contract, so that the
  authorization and query features derive access from stored state at query time without calling
  Discord ([ADR 0005](../adr/0005-gateway-synced-permission-state.md)). This feature returns no
  message content and no Discord identity data beyond the ids it needs.
- Non-goals:
    - Message ingestion, historical import, edit/delete mirroring — [ingestion](ingestion.md), which
      consumes this feature's channel/thread registry contract instead of owning one.
    - MCP tools, retrieval and result filtering — query feature specification.
    - OAuth2 login, session issuance and identity — authorization feature
      ([ADR 0006](../adr/0006-discord-sso-dynamic-client-registration.md)).
    - Owning the Gateway connection, its lifecycle or a second Discord connection: the `discord`
      feature owns the single connection and the normalized event stream.
    - Changing anything on Discord (assigning roles, kicks, overwrites, bans). The hub mirrors;
      it never writes permission state to Discord.
- Owning feature and local instructions: `guild-state` (placement per
  [structure](../architecture/structure.md)); a local `AGENTS.md` is added at implementation only if
  feature-specific invariants emerge.
- Relevant accepted ADRs: [0001](../adr/0001-layer-ownership.md),
  [0003](../adr/0003-postgresql-without-orm.md),
  [0005](../adr/0005-gateway-synced-permission-state.md),
  [0007](../adr/0007-mirror-message-lifecycle.md).

## Prerequisites

- A Discord application/bot with the `GUILDS` intent and the privileged `GUILD_MEMBERS` intent
  enabled, member of exactly the configured Guild.
- `GUILD_MEMBERS` is a hard requirement, not an optimization: without it Discord withholds the full
  roster and restricts member-level thread events, so the registry would silently under-report
  Membership and private-thread membership. A missing or disabled intent fails startup with an
  explicit error before any network activity — the same treatment ingestion gives `MESSAGE_CONTENT`.
- Validated configuration at startup per the shared/config conventions (no scattered `process.env`
  reads): `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID`, shared with the `discord` and `ingestion`
  features and parsed once. v1 introduces no additional variable; a reconciliation cadence would add
  one only if an open decision is approved.
- The `discord` feature's normalized event stream is available; this feature never opens a
  connection of its own.

## Behavior

"Registry" means: the tables this feature owns in PostgreSQL. "Authoritative" means: derived only
from Discord-originated data (Gateway events or REST reads), never from client input or operator
edits. "Membership ended" means: the Membership's rows are deleted — unlike a message tombstone
([ADR 0007](../adr/0007-mirror-message-lifecycle.md)), permission state keeps no history, because
authorization only needs current state. "Evaluation" means: the pure derivation this feature exposes
as a use case.

Each rule states the rule, then a successful example, a rejected/boundary example, and error
behavior where applicable.

- **R1 — Guild isolation.** The registry holds exactly one Guild: the one configured for this
  Installation. Every stored row carries that Guild's id. Data from any other Guild is dropped and
  counted as an anomaly, never stored and never evaluated.
    - Example: bot invited to guild A (configured) and guild B → roles, members, channels and
      overwrites from guild B produce no rows; a `GUILD_ROLE_UPDATE` for guild B increments an anomaly
      counter only.
    - Boundary: if the bot is removed from the configured Guild (`GUILD_DELETE` for it), the registry
      can no longer be current. It stops applying state, reports an unavailable status and logs an
      error identifying the Guild id; recovery is operator action (re-invite), not an automatic
      fallback to another Guild.
    - Error: an evaluation targeting a Guild id other than the configured one yields an empty
      permission set, never a grant.

- **R2 — Guild bootstrap and resumability.** The Guild row (id, name) and the full initial state come
  from a REST bootstrap: Guild, role list, channel list with permission overwrites, and the
  paginated member roster. The bootstrap is a resumable background job: it tolerates restarts, rate
  limits and 5xx responses by bounded retries with backoff, resumes without duplicating rows, and
  reports a completion status. Bootstrap completion is never claimed while any part is pending.
    - Example: bootstrap interrupted after three member pages → on restart it continues with the
      remaining pages; stored rows are unchanged for pages already applied.
    - Boundary: an empty registry (fresh installation) and a registry flagged stale (R11) both take
      the same bootstrap path; a partially applied bootstrap keeps the status `incomplete` and is
      therefore never consumed as authoritative.
    - Error: a 4xx on the Guild read (bot lost access, revoked token) fails the bootstrap loudly with
      the status `unavailable`; the bootstrap does not degrade into an empty-but-"complete" registry.

- **R3 — Role registry.** Every role of the Guild is stored with its Discord id, name, position and
  permission bitfield, including the `@everyone` role. Permission bitfields are stored exactly as
  Discord encodes them and never coerced to a JavaScript `number`, because a bitfield can exceed the
  safe-integer range ([persistence guide](../architecture/persistence.md)). A role update replaces
  the stored role wholesale. Role position is stored for ordering and display only: no v1
  authorization rule depends on it.
    - Example: `@everyone` grants nothing, role `backend` grants `VIEW_CHANNEL|READ_MESSAGE_HISTORY`,
      member M holds `backend` → M's base permissions are the union of both roles' bitfields.
    - Boundary: the `@everyone` role is not listed in a member's role set (Discord omits it), so
      evaluation always folds it in by Guild id; a member with no roles therefore still has the
      `@everyone` base.
    - Deletion: deleting a role removes, in the same transaction, every role-membership row for it and
      every channel overwrite targeting it. A stored overwrite that targets a role id nobody holds
      cannot affect any evaluation, so a deleted role can never grant permissions through a stale
      overwrite.
    - Error: an event for the configured Guild naming an unknown role id triggers a targeted REST read
      of the role list (R11 anomaly path) instead of inventing role data.

- **R4 — Membership registry.** Every member of the configured Guild is stored as a Membership:
  Guild id, User id and the member's role set. A join creates it; a leave, kick or ban ends it
  immediately: the Membership row, its role-membership rows and its private-thread membership rows
  are deleted in one transaction.
    - Example: user U is kicked → the next evaluation for U in any channel returns an empty permission
      set, because no Membership exists.
    - Rejected: `GUILD_MEMBER_ADD` for a foreign Guild is dropped (R1) and creates no Membership.
    - Boundary: the distinction between leave, kick and ban is irrelevant to authorization — all three
      end the Membership. Whether the hub records which one happened is open (O3). Bots and webhooks
      that appear as members are stored like any other member.
    - Error: a `GUILD_MEMBER_REMOVE` for an id with no stored Membership is a no-op, not an error —
      a duplicate or post-resync removal is expected.

- **R5 — Role-membership changes.** A member update carries the member's complete role set, so
  stored role membership is replaced, never merged. Adding or removing a role changes nothing except
  that member's role set: role definitions, overwrites and other members are untouched.
    - Example: member update `["backend"] → ["backend","ops"]` → the two role-membership rows exist;
      the removed-role case leaves exactly one.
    - Boundary: an empty role set is a valid state (member keeps only `@everyone`); it is not
      equivalent to a missing Membership, which is a different stored state.
    - Error: an update naming a role id absent from the registry stores the role id as given; the
      evaluation simply has no permissions to add for it until the role arrives. State converges when
      it does (R10).

- **R6 — Channel and thread registry.** Every channel and thread of the configured Guild is stored
  with its id, Guild id, type, name, position, and — for threads — its parent channel id, which is
  mandatory. Channels and threads form one registry: a thread is a channel with a parent. Deleting a
  channel or thread removes its overwrites and its private-thread membership rows in one transaction
  and emits the structure-change event ingestion consumes (ingestion R2).
    - Example: a forum channel whose posts are threads → the forum channel row and one row per post,
      each post carrying the forum channel as parent.
    - Boundary: an unknown or deleted channel id yields an empty permission set in evaluation rather
      than an error, so a deletion racing a query fails closed.
    - Error: a thread event without a resolvable parent is rejected, logged with its id, and retried
      through the anomaly path (R11); a thread is never stored parentless.

- **R7 — Permission overwrites.** Each channel's and thread's overwrite set is stored as Discord
  reports it and replaced wholesale on change: per target, the target id, whether the target is a
  role or a member, and the `allow` and `deny` bitfields (exact, as in R3). Creation, change and
  removal of an overwrite are all expressed as replacing that channel's set, so a removed overwrite
  cannot survive as a stale grant; a set reported partially is completed by a targeted REST read
  before applying (R10).
    - Example: `#private` denies `VIEW_CHANNEL` for member U while U's role allows it → U cannot view
      the channel, because the member overwrite is applied after the role stage in the derivation order
      under Contracts and boundaries.
    - Boundary: a permission allowed by one of the member's roles and denied by another is **allowed**
      inside the role stage (deny is applied before allow there); only a later stage — the member
      overwrite — can deny it. An overwrite whose target is neither `@everyone` nor one of the
      evaluated member's roles never participates, so overwrite/role arrival order cannot change a
      result.
    - Error: an overwrite whose target type is neither role nor member is dropped and counted as an
      anomaly, never guessed from the id.

- **R8 — Private-thread membership.** Membership of private threads is stored per thread as
  (`thread id`, `User id`) and is what admits a user to a thread that guild-wide roles alone do not
  open. Membership is added on the corresponding thread-member event and removed on its removal
  counterpart. Absence of a row means no access through private-thread membership: evaluation never
  treats an unknown thread-membership state as granted.
    - Example: private thread T lists user U among its members → U's evaluation for T includes the
      thread-membership contribution, which U's role set alone does not provide; after U is removed
      from T, that contribution is gone.
    - Boundary (observability, stated honestly): Discord only delivers member-level thread-membership
      events to the bot for threads it can observe, and only as the privileged intent permits. The
      registry therefore documents a coverage limit: for a thread the bot cannot observe, changes made
      while the hub was not watching may be absent. Reconciling observable threads via a REST read is
      the proposed remedy; whether that read is complete for every thread state is unresolved and
      recorded as O1. This feature never fabricates membership to hide the gap.
    - Error: a thread-membership change for a thread not present in the registry is deferred through
      the anomaly path (R11) instead of creating an orphan thread row.

- **R9 — Idempotency.** Discord ids are the natural keys: Guild id, role id, (Guild id, User id) per
  Membership, channel/thread id, (channel id, overwrite target id) per overwrite, and (thread id,
  User id) per thread membership. Replayed or duplicated events and re-run bootstraps change nothing
  observable, exactly as ingestion R7 requires of message events.
    - Example: the same `GUILD_ROLE_UPDATE` delivered twice after a reconnect → one role row with one
      state, unchanged by the second delivery.
    - Boundary: a bootstrap re-run over an already converged registry performs writes that may be
      no-ops, and the stored state after the re-run is identical to before it.

- **R10 — Convergence over arrival order.** Stored state converges to Discord's latest state
  regardless of event order because each applied message is a full replacement of the resource it
  describes, never a merge into the previous one. At a bootstrap or resync boundary the REST
  snapshot is authoritative and replaces stored state; afterwards events are authoritative. A
  snapshot never partially overwrites and an event never partially overwrites.
    - Example: a role event carrying the pre-change bitfield lands after the bootstrap snapshot that
      already has the new one → the late event replaces the role wholesale, and a subsequent resync
      restores the snapshot's state; no merged bitfield is ever stored.
    - Boundary (omitted versus empty): a field absent from an event payload is not an empty value.
      Before applying, the missing field is completed by a targeted REST read of that resource (R11);
      an explicitly empty role set or overwrite set is stored as empty. The two states are never
      conflated ([feature patterns](../architecture/features.md)).
    - Boundary: where Discord supplies no version or timestamp for a resource, this feature relies on
      wholesale replacement plus the resync path rather than on inventing an ordering key.

- **R11 — Reconnect resynchronization (security control).** After any detected gap — Gateway
  disconnect and reconnect, or an anomaly such as an unknown resource id for the configured Guild —
  the hub re-reads Guild state via REST and converges the registry. Missing state changes after a
  reconnect is a defect of this feature, not an accepted lag
  ([ADR 0005](../adr/0005-gateway-synced-permission-state.md)). While a resync is in flight the
  registry reports the stale/incomplete status; the authorization feature owns whether reads are
  refused during that window.
    - Example: hub down for 10 minutes and, meanwhile, a member loses a role that allowed
      `VIEW_CHANNEL` → after reconnect the resync run converges role, Membership and overwrite state,
      and evaluation reflects the removal.
    - Boundary: the resync is a full replace-and-converge of the affected resources, not a replay of
      missed events; it is bounded by pagination, rate limits and backoff, and reuses the bootstrap
      path (R2).
    - Error: a resync that cannot complete leaves the status stale and keeps retrying with backoff; it
      never marks the registry current on a partial read.

- **R12 — Revocation latency.** A Discord permission change becomes effective in the registry within
  seconds of the bot receiving the corresponding event: applied state is authoritative immediately,
  and no TTL cache of permission data exists. Evaluation reads stored state per call, so revocation
  latency is Gateway event latency, not minutes
  ([ADR 0005](../adr/0005-gateway-synced-permission-state.md)). Authorization never calls Discord
  REST per query.
    - Example: an administrator removes role `backend` from user U → the next evaluation after the
      member event is applied omits `backend`'s permissions.
    - Boundary: if a future change adds caching, the cache must be invalidated by the same events and
      may never extend the window beyond event latency; a TTL snapshot cache remains rejected.

- **R13 — Read-only public contract.** The effective-permission evaluation is a pure derivation: it
  reads registry state and performs no write, and it accepts no caller-supplied roles, overwrites or
  permission sets. Registry state changes only from Discord-originated Gateway events and REST reads;
  the MCP surface is read-only with respect to permission state
  ([ADR 0005](../adr/0005-gateway-synced-permission-state.md)).
    - Example: evaluating permissions for the same user and channel twice returns the same set and
      leaves every stored row and counter unchanged.
    - Rejected: an input attempting to supply permissions, roles or an overwrite set is rejected by
      the use-case contract's input shape; nothing is stored.

- **R14 — No message content; ids and counts in logs.** This feature stores and logs no message
  content, attachment data, Discord tokens or member display data beyond ids (O2). Logs carry Guild,
  role, channel, thread and User ids plus counts and anomaly reasons, never content
  ([shared guide](../architecture/shared.md)).
    - Example: a role deletion logs the Guild id, role id and the number of removed role-membership
      rows and overwrites.
    - Boundary: anomaly logging for a foreign-Guild event records the Guild id and event kind only.

## Contracts and boundaries

- Exposed transport: none. This feature owns no REST endpoint and no MCP tool. Its public surface is
  the intentional `index.ts` exports below, consumed by the authorization and query features. Other
  features never import this feature's repositories, SQL or tables
  ([structure](../architecture/structure.md)).
- Public use cases (inputs are camelCase application types; no transport or discord.js types):
    - `EvaluateEffectivePermissionsQuery` — input: User id + channel or thread id; output: the
      effective permission set as an exact bitfield with named lookups. Derivation order, fixed here:
        1. base = bitfields of the `@everyone` role unioned with every role in the member's role set;
        2. if the base permissions include `ADMINISTRATOR`, every permission is granted and overwrite
           stages are skipped (administrator bypass);
        3. the target channel's `@everyone` overwrite: remove its `deny` bits, then add its `allow` bits;
        4. the union of the member's role overwrites: remove the union of their `deny` bits, then add
           the union of their `allow` bits;
        5. the member's own overwrite, if present: remove its `deny` bits, then add its `allow` bits.
           A thread is evaluated with its own stored overwrite set over the parent channel's set, so the
           parent's restrictions still apply when a thread carries none. A missing or foreign channel, or a
           User without a Membership, yields an empty set (fail closed).
    - `ListIngestibleChannelsQuery` — the registry contract ingestion consumes: registered,
      non-deleted, text-capable channels and threads the bot itself can view, computed with the same
      evaluation applied to the bot's own Membership. Absence from the registry and lack of bot
      visibility are reported as distinct facts rather than assumed to be the same thing.
    - `GetGuildStateStatusQuery` — bootstrap/resync completeness and staleness, for readiness reporting
      and for the authorization feature's own gating policy.
    - `GetGuildIdentityQuery` — the Installation's Guild id and name, read from the registry; consumed
      by the query feature's server metadata (query R8). Added during the authorization/query
      specification reviews (2026-11-05).
    - `GetMembershipStatusQuery` — input: User id; output: `present` or `absent` for this
      Installation's Guild, meaningful only while the registry status is current (consumers gate on
      `GetGuildStateStatusQuery`); consumed by the authorization feature's login gate and per-request
      check (authorization R6, R8). Added during the authorization/query specification reviews
      (2026-11-05).
    - `ListUserAccessibleChannelsQuery` — input: User id; output: the registry's channel/thread ids
      where that User holds `VIEW_CHANNEL`, each entry carrying the registry `name` (`string | null`)
      and `position` (`number | null`) plus whether `READ_MESSAGE_HISTORY` also holds, computed with the evaluation above in one bounded set read (never a per-channel
      round-trip loop). Consumed by the query feature for `list_channels` and as the mandatory
      accessible-id set parameter of its read repositories (query R2). Added during the
      authorization/query specification reviews (2026-11-05).
- Event-stream subscription: the `discord` feature emits normalized events; this feature subscribes
  to Guild snapshot/create/update, role create/update/delete, member add/update/remove, channel and
  thread create/update/delete, thread-member updates and (when used) ban add/remove. Raw Discord
  event names appear here only for recognition; use cases see normalized application events.
- Commands (event application and reconciliation, named for their intent):
    - `ApplyGuildBootstrapCommand` — initial full state from REST (R2).
    - `ResyncGuildStateCommand` — post-reconnect / anomaly convergence (R11) via the bootstrap path.
    - `UpsertRoleCommand`, `DeleteRoleCommand` — role registry and its cascade (R3).
    - `ApplyMemberUpdateCommand` — join and member updates, including role-set replacement (R4, R5).
    - `EndMembershipCommand` — leave, kick or ban (R4).
    - `UpsertChannelCommand`, `DeleteChannelCommand` — channels and threads, including their cascade
      (R6). `UpsertChannelCommand` also owns the channel-access trigger: it compares the bot's own
      `view-channel` decision across the overwrite replacement it applies (the same five-stage
      derivation, run twice: once before the write, once after) and reports `ingestibilityGained` on
      its outcome when the pair is not-viewable → viewable on a text-capable channel
      (`odd/tasks/ingestion-channel-access-trigger.md` S1–S3). It never walks history itself.
    - `ReplaceChannelOverwritesCommand` — overwrite set replacement (R7).
    - `ApplyThreadMembershipChangeCommand` — private-thread membership added or removed (R8).
- Outbound port: `ChannelsIngestibilityGained` (`onGained(channelId)`), satisfied by the composition
  and bound at application start. It exists so a gained channel access leaves this feature as one id
  and nothing else: the consumer walks history, and this feature neither imports it nor re-derives what
  it decides. An unbound port is a no-op — a registry that cannot say who is listening still stores
  the row.
- Gateway boundary: REST guild-state reads (Guild, roles, channels with overwrites, paginated
  members, and thread-member reconciliation where available) sit behind a narrow `GuildStateGateway`
  contract owned here; the discord.js call sites live in the Discord gateway adapter, as ingestion
  does for its backfill, so use cases never see discord.js types. Timeouts, bounded retries with
  backoff for transient failures, pagination limits and response validation apply
  ([shared guide](../architecture/shared.md)).
- Repository contracts (owned here; parameterized SQL, explicit column selection, bounded batches per
  the [persistence guide](../architecture/persistence.md)): upsert Guild; upsert roles (batch);
  delete role and its dependents; upsert memberships (batch); replace role set for one Membership;
  delete Membership and its dependents; upsert channels/threads (batch); delete channel and its
  dependents; replace a channel's overwrite set; upsert/delete thread memberships; and the read
  projections the evaluation needs (role bitfields, a member's role set, a channel's overwrite set).
- Transactions and consistency: each applied event is one transaction covering its own writes and
  cascade (for example role deletion: role row, role-membership rows, overwrites). Bootstrap and
  resync commit in bounded batch transactions. No transaction spans a Discord REST call. Evaluation
  reads its inputs in one consistent snapshot (a single read transaction or one joined query) so a
  concurrently applied event cannot produce a torn permission result.
- Retry/idempotency: all event application is replay-safe by R9; REST reads are safe to repeat by
  construction; retries are bounded with backoff.
- Compatibility: additive. Snowflake ids are stored as `bigint`, permission bitfields exactly, and
  instants, where stored, as `timestamptz`, so column semantics are stable once implemented — the
  authorization and query features build on this schema. Destructive schema changes require explicit
  approval.

## Implementation and proof

- Minimal affected paths: the `guild-state` feature module (commands, queries, repository contracts
  and PostgreSQL implementations, `GuildStateGateway` contract), the Discord gateway adapter's
  guild-state REST reads and normalized event emission, append-only migrations for the guild, role,
  membership, role-membership, channel/thread, overwrite and thread-membership tables, and the
  index/factory wiring in the feature module.
- Tests per rule, against an isolated real PostgreSQL database: R1 foreign-Guild event dropped and
  no rows written; R2 resumable bootstrap (interrupt mid-pagination, restart, no duplicates, status
  never `complete` while partial); R3 role delete cascade (role-membership rows, overwrites) and
  `@everyone` folding for a role-less member; R4 kick/leave/ban ends Membership and its dependents in
  one transaction; R5 role-set replacement (including the empty set) leaving other state untouched;
  R6 thread-with-parent storage and channel delete cascade; R7 overwrite set replacement, allow
  winning over deny inside the role stage while the member overwrite denies, and no effect from
  unknown targets; R8 thread membership adds
  and removes access, and missing rows never grant; R9 double-apply idempotency; R10 late-out-of-order
  replacement plus resync convergence; R11 reconnect gap convergence; R12 evaluation reflects a
  revocation immediately and repeated evaluation writes nothing; R13 evaluation is read-only and
  rejects caller-supplied permission input; R14 no-content/no-display-data log and column scan.
- Named ADR 0005 revocation tests, required by
  [ADR 0005](../adr/0005-gateway-synced-permission-state.md) "Verification and adoption" and implemented
  here as integration tests over real PostgreSQL plus the evaluation use case:
    - `revocation-role-removed` — the role's permissions disappear from the next evaluation, including
      its overwrites.
    - `revocation-member-kicked` — every channel evaluation for that User returns an empty set.
    - `revocation-channel-overwrite-changed` — a new `deny` for the User's role takes effect on the
      next evaluation, and a removed `deny` stops applying.
    - `revocation-private-thread-membership-lost` — the User loses access to the thread through
      thread membership once the removal is applied.
    - `resync-after-reconnect` — the same four changes made while the hub is not listening are all
      reflected after the resync run, with the status returning to current only when it completes.
- Safe isolated database setup: a dedicated PostgreSQL test database/schema with an explicitly
  supplied test connection, isolation confirmed before setup or cleanup; missing database access is
  reported as unavailable evidence, never passed, and no shared or production data is truncated
  ([testing guide](../architecture/testing.md)).
- Actual verification commands: none exist yet; recorded in
  [project context](../project-context.md) when implementation is authorized.
- Documentation updates at implementation: project-context feature section, `CONTENTS.md` entry, a
  local `AGENTS.md` only if invariants emerge, and the ingestion cross-reference if this feature's
  contract names change.

## Decisions (2026-11-04)

- Event source: subscription to the normalized event stream of the dedicated `discord` feature,
  which owns the single Gateway connection; this feature opens no connection.
- Registry ownership: the channel/thread registry belongs to this feature. Ingestion consumes its
  contract and owns no registry commands or repositories (reflected in
  [ingestion](ingestion.md) R2).
- Evaluation ownership: the effective-permission derivation is a public use case of this feature —
  data layer plus pure derivation — consumed later by the authorization and query features.
- Initial state: full REST bootstrap; no per-query Discord REST calls
  ([ADR 0005](../adr/0005-gateway-synced-permission-state.md)).

## Open decisions

- **O1 — Private-thread membership coverage.** Discord delivers member-level thread events to the bot
  only for threads it can observe, subject to the privileged intent. Question: which REST
  reconciliation (scope, cadence, and behavior for threads the bot cannot observe) closes the gap,
  and does an unobservable private thread fail closed for every user or keep the last known
  membership? Consequence: an unrecorded revocation keeps a user reading a private thread, which is a
  security gap and must be decided, not assumed. Owner: Project owner. Resolution trigger: before
  implementing R8 reconciliation; implementation evidence about what the API returns for unobservable
  threads is recorded with the decision.
- **O2 — Member display data.** Question: does the registry store guild nicknames/usernames for later
  attribution and display, or stay id-only? Consequence: storing them widens the stored personal-data
  surface and the log-exclusion rule (R14) without serving v1 authorization. Owner: Project owner.
  Resolution trigger: when the query feature's result presentation needs a display name.
- **O3 — Ban-list reconciliation.** Question: is a periodic REST read of the Guild ban list worth its
  cost in v1, given that a ban also ends the Membership (R4) and a resync (R11) refreshes the roster?
  Consequence: without it, a ban that happens during downtime is covered only by the resync path, and
  the registry never knows leave vs kick vs ban. Owner: Project owner. Resolution trigger: before
  adding a reconciliation schedule or a `banned` derivation.
