# Feature specification — Ingestion (Discord → PostgreSQL)

## Goal and source request

- Owner: Project owner
- Source request (verbatim):
    - "El bot tendrá acceso a los canales autorizados y sincronizará sus mensajes con PostgreSQL."
    - "Ingesta histórica inicial y sincronización continua mediante Gateway."
    - "No queremos ejecutar modelos LLM durante la ingesta."
- Expected outcome: an `ingestion` feature that keeps the PostgreSQL message store converged with
  the configured guild's reality: a resumable historical import at first run, continuous Gateway
  synchronization afterwards, and mirroring of edits and deletions. Message content is queryable
  only through later features; this feature exposes no external contract.
- Non-goals:
    - Permission-state synchronization (members, roles, overwrites, thread membership) — separate
      feature specification, required by [ADR 0005](../adr/0005-gateway-synced-permission-state.md).
    - MCP tools, search, or any read path — separate query feature.
    - OAuth2/authorization server — separate authorization feature ([ADR 0006](../adr/0006-discord-sso-dynamic-client-registration.md)).
    - Attachment content download or indexing; edit-history tracking (Discord exposes only current content);
      embeddings/tags/LLM processing at any point of the ingestion path.
- Owning feature and local instructions: `ingestion` (placement per
  [structure](../architecture/structure.md)); a local `AGENTS.md` is added at implementation only if
  feature-specific invariants emerge.
- Relevant accepted ADRs: [0001](../adr/0001-layer-ownership.md), [0003](../adr/0003-postgresql-without-orm.md),
  [0004](../adr/0004-mcp-primary-transport.md), [0005](../adr/0005-gateway-synced-permission-state.md),
  [0007](../adr/0007-mirror-message-lifecycle.md).

## Prerequisites

- A Discord application/bot with the `GUILDS`, `GUILD_MESSAGES` and `MESSAGE_CONTENT` intents
  enabled, member of exactly the configured guild.
- Validated configuration at startup per the shared/config conventions (no scattered `process.env`
  reads): `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `IMPORT_MODE` (`full` | `days`),
  `IMPORT_DAYS` (integer ≥ 1, required and used only when `IMPORT_MODE=days`),
  `INGESTION_CATCH_UP_ENABLED` (`true` | `false`, default `true`),
  `INGESTION_CATCH_UP_INTERVAL_MS` (default `300000`),
  `INGESTION_CATCH_UP_CHANNELS_PER_TICK` (default `5`),
  `INGESTION_CATCH_UP_PAGES_PER_CHANNEL_PER_TICK` (default `20`). Invalid or missing
  configuration fails startup with an explicit error before any network activity.

## Behavior

Each rule states the rule, then a successful example, a rejected/boundary example, and error
behavior where applicable. "Stored" means: persisted in PostgreSQL and visible to later read
features; "excluded" means: never returned by any read path.

- **R1 — Guild isolation.** The hub ingests only the configured guild. The bot leaves or ignores
  any other guild it is added to. No row originating from another guild is ever stored.
    - Example: bot invited to guild A (configured) and guild B → all stored rows carry guild A's id;
      guild B produces no rows.
    - Rejected: a message event arriving for another guild is dropped and counted as an anomaly, not
      stored.
- **R2 — Channel and thread registry (consumed).** Guild structure is owned by the guild-state
  feature; ingestion owns no registry. Ingestion consumes the registry contract: the set of
  registered, non-deleted text-capable channels and threads the bot can view, plus structure-change
  events. When a channel or thread is deleted, ingestion marks all its messages excluded.
    - Example: a forum channel whose posts are threads → the forum channel and each post come from
      the registry; post messages ingest under the post's thread id.
    - Boundary: channels the bot cannot view never appear in the registry; per-user filtering is a
      read-path concern ([ADR 0005](../adr/0005-gateway-synced-permission-state.md)), never an
      ingestion filter.
- **R3 — Historical import.** With `IMPORT_MODE=full`, all retrievable message history of registered
  channels is imported. With `IMPORT_MODE=days`, only messages whose Discord creation timestamp is
  strictly after (import start − `IMPORT_DAYS` days). The import is a resumable background job: it
  tolerates restarts, resumes without duplicating, and continuous synchronization (R4–R6) runs in
  parallel while it works. **Resuming means resuming from stored state, not from zero** (see R14):
  a restart continues each channel at the cursor the previous run left in the ledger, and a channel
  already `complete` is not read at all. Progress is observable in structured logs.
    - Example: `IMPORT_MODE=days, IMPORT_DAYS=90` → a message dated 91 days before import start is
      not stored; one dated 89 days before is.
    - Error: Discord rate limits or 5xx responses cause bounded retries with backoff and resume, not
      import failure; a 4xx (permission removed, channel deleted mid-import) skips the channel with a
      logged reason and continues.
- **R4 — Message creation.** Every message created in a registered, non-deleted channel or thread is
  stored: Discord message id, guild id, channel/thread id, author (id, username, bot/webhook
  provenance), content, creation timestamp, edited timestamp when present, message type, reply
  reference, and attachment metadata. All message types are stored with their type; no filtering at
  ingestion.
    - Example: replying message in #backend → stored with its referenced message id, retrievable
      later by the query feature.
- **R5 — Edit mirroring.** An edit replaces the stored content and edited timestamp. Updates that
  arrive without full fields are reconciled by fetching the message via REST before overwriting.
  An update carrying an edit timestamp older than the stored one does not regress the content.
    - Example: author edits "hola" into "adiós" → subsequent reads (via later features) see "adiós"
      with the new edited timestamp; "hola" is not returned.
- **R6 — Delete mirroring.** `MESSAGE_DELETE` tombstones the message; `MESSAGE_DELETE_BULK`
  tombstones all listed ids. Tombstoned messages are excluded from every read path
  ([ADR 0007](../adr/0007-mirror-message-lifecycle.md)). Channel or thread deletion (R2) excludes
  all their messages.
    - Boundary: tombstone rows physically drop content (owner decision, 2026-11-04): id, author,
      timestamps and `deleted_at` remain; text content and attachment metadata are removed. The
      exclusion from read paths is unconditional.
- **R7 — Idempotency.** The message id is the natural key. Replayed or duplicated Gateway events,
  re-run imports and overlapping REST backfills change nothing observable: applying the same event
  twice yields the same stored state.
    - Example: the same MESSAGE_CREATE delivered twice after a reconnect → exactly one row, unchanged.
- **R8 — Convergence over arrival order.** Stored state converges to the latest Discord state
  regardless of event arrival order: REST backfill never overwrites newer Gateway-derived state, and
  edit/deletion decisions compare Discord-provided timestamps, not processing order.
    - Example: a backfill batch containing a pre-edit version of an already-edited message arrives
      late → the stored content stays the edited version.
- **R9 — Reconnect resynchronization.** After a Gateway disconnect and reconnect, the hub detects
  the missed window (per channel) and backfills it via REST. This is a correctness requirement, not
  an optimization: missing messages after a reconnect is a defect of this feature.
    - Example: hub down for 10 minutes → after reconnect, messages created in that window appear
      stored within the resync run.
    - Bounded by `INGESTION_RESYNC_MAX_PAGES_PER_CHANNEL` pages per channel (five by default): the
      resync owns the gap, not the channel's whole history, which R3's import and R14's catch-up walk
      from the durable ledger. A walk that reaches the bound leaves the channel gap-tracked with its
      cursor (`page-bound`), never completed; a walk that finishes without closing the gap stays a gap
      too.
- **R10 — No semantic processing.** The ingestion path performs no LLM, embedding, tagging or
  derived-content computation. It stores what Discord emitted and nothing else.
- **R11 — Attachment metadata only.** Attachments are stored as metadata (id, filename, content
  type, size, URL). File bytes are never downloaded, stored or indexed in v1.
- **R12 — Sensitive-data boundaries.** Message content and Discord tokens are never written to
  logs. Logs carry ids, channel names and counters, not content
  ([shared guide](../architecture/shared.md)).
- **R13 — Access trigger at runtime.** Whenever the bot's viewability on a text-capable channel or
  thread transitions from **not-viewable to viewable** — the hub could not read the channel a moment
  ago — the hub backfills that channel's history then and there, without a restart and without
  re-walking the channels it already mirrors. The rule is the transition, never the event: a channel
  update that only renames, reorders or retopics the channel starts nothing, and neither does one that
  takes view away. The walk is R3's bounded per-channel walk under R3's own window (`IMPORT_MODE`,
  `IMPORT_DAYS`, measured from the triggered run's start), and R7 keeps a repeated trigger free of
  duplicate rows.
    - Example: the bot is given `View Channel` on `#reservations` → that channel's retrievable history
      appears in the store while `#backend` is untouched; the same update delivered again stores nothing.
    - Boundary: a category, voice or stage channel never starts a walk — nothing is posted in it, so
      guild-state never reports a gain for it — and a private thread is still gated by R2's registry rule
      (a thread the bot was never admitted to is not ingestible).
    - Error: a 4xx while walking the newly-readable channel leaves it reported as a walk that stopped on
      access loss rather than as imported history; continuing is the next trigger's or the next
      reconnect's job, exactly as R3 states for a channel that becomes unreadable mid-import.
    - Ownership: guild-state decides the transition (it owns permission state and owns the overwrite
      change that causes it), this feature owns the walk, and the two meet through a composition-level
      port. Neither feature re-derives the other's facts.
- **R14 — Durable ledger and bounded catch-up.** The import's progress is **persisted**, not remembered
  by a process: one row per channel in `import_channel_progress` (guild, channel, status, cursor,
  cumulative counters, consecutive attempts, last stop and failure reason, next attempt instant), read
  and written through `ImportProgressRepository`. "What is still outstanding" is therefore derived from
  that table — `status <> 'complete'` — never from an in-memory map, so a restart resumes instead of
  restarting. A bounded background job (the _catch-up_) then closes what the bootstrap run left open,
  with no operator action required: every `INGESTION_CATCH_UP_INTERVAL_MS` (default 5 min) it takes at
  most `INGESTION_CATCH_UP_CHANNELS_PER_TICK` (default 5) outstanding channels, walks each one from its
  stored cursor for at most `INGESTION_CATCH_UP_PAGES_PER_CHANNEL_PER_TICK` (default 20) pages, and
  records the outcome per channel. `INGESTION_CATCH_UP_ENABLED=false` turns the job off entirely.
    - The status vocabulary, unchanged from R3 and now stored: `complete` (nothing left — the only value
      that stops a channel being selected), `partial` (stopped at the page bound, resumable at its
      cursor), `deferred` (a rate limit, 5xx, timeout or invalid payload stopped the walk), `skipped` (a
      4xx: the channel cannot be read, so it is not claimed as imported).
    - The stop reasons a walk reports, and the status each earns: `history-exhausted` and `window-bound`
      → `complete`; `page-bound` → `partial`; `rest-transient-failure` and `rest-payload-invalid` →
      `deferred`; `rest-access-lost` → `skipped`.
    - Backoff: a `deferred` channel increments its consecutive-attempt count and is not retried before
      `min(60s × 2^(attempts−1), 1h)`. Every other outcome resets the count and clears the deadline, so a
      `skipped` channel is re-asked once per tick (the only way a channel whose permission came back is
      recovered in-process) and a `complete` one is never asked again. A channel is never walked twice in
      the same tick.
    - Boundary: the tick logs ids and counts only (R12) — channels considered, completed, deferred,
      skipped, partial and failed. One channel's unexpected failure is counted and left outstanding; it
      never aborts the tick's other channels.
    - Out of scope: R5's live Gateway ingestion, R9's reconnect resync and R13's access trigger are
      untouched — the catch-up only continues walks that have already stopped.

## Contracts and boundaries

- Exposed transport: none. This feature owns no REST endpoint and no MCP tool; it is a background
  consumer of Discord.
- Gateway boundary: the dedicated `discord` feature owns the connection protocol and emits a
  normalized internal event stream; ingestion subscribes to message/channel/thread events. The
  same connection will feed the future guild-state feature (see Decisions).
- REST backfill: channel history pagination happens inside the Discord gateway adapter (bounded
  batches, rate-limit aware, replay-safe by R7). Use cases never see discord.js types.
- Commands (application inputs in camelCase, no transport types):
    - `RecordMessageCommand`, `ApplyMessageEditCommand`, `ApplyMessageDeletionCommand` — event
      application (R4–R8).
    - `ImportChannelHistoryCommand` — resumable import per channel (R3).
    - `BackfillChannelAccessCommand` — the one-channel backfill a gained channel access starts (R13),
      wired to guild-state's outbound access-trigger port by the application composition and run as a
      bounded background job (never awaited by the event that caused it).
    - `ExcludeChannelMessagesCommand` — structure-change reaction (R2).
    - `CatchUpOutstandingChannelsCommand` — one bounded catch-up tick over the persisted ledger (R14),
      driven by `IngestionCatchUpWorker`; never awaited by a request or an event path.
- Queries: none in this feature. Import progress is a stored operational fact (R14), readable in the
  ledger table and in structured logs; it is not a v1 use case.
- Repository contracts (owned by this feature; the query feature will define its own read
  repositories over the same tables): upsert message(s), apply edit, tombstone by ids,
  bulk-exclude by channel/thread, and the import ledger (`ImportProgressRepository`: load a Guild's
  rows, upsert per channel, select the outstanding page, drop pruned channels). All parameterized SQL,
  explicit column selection, bounded batches ([persistence guide](../architecture/persistence.md)).
- Transactions: import batches commit in bounded batch transactions; single-event application is a
  single statement. No transaction spans a Discord API call.
- Compatibility: additive; the message/channel/thread schema is the foundation the query feature
  builds on, so column semantics (timestamps as `timestamptz`, snowflake ids as bigint) are stable
  once implemented.

## Implementation and proof

- Minimal affected paths: `ingestion` feature module, Discord gateway adapter, the commands above,
  PostgreSQL repositories, append-only migrations for the guild/channel/thread/message tables
  (migration runner selection is open in project context), configuration entries.
- Tests per rule: R1 negative test (foreign-guild event dropped); R2 bulk exclusion of messages on
  channel/thread deletion; R3 window boundary calculation (unit) + resumable import (integration,
  restart mid-import); R4–R6
  event application against real PostgreSQL including tombstone exclusion from repository reads; R7
  double-apply idempotency (integration); R8 late-backfill regression guard (unit/integration); R9
  reconnect-gap backfill trigger (gateway adapter test with a simulated gap), `resync-walk-is-bounded`
  and `resync-bound-is-configurable` as units; R10/R11 structural
  (no processing dependencies; attachment columns only); R12 log-content scan where applicable; R13
  the five named cases on a real isolated PostgreSQL (granted view backfills; rename-only, revoked and
  not-viewable creates do nothing; a viewable create backfills) plus the transition rule as a unit; R14
  `catchup-advances-outstanding-channel`, `catchup-derives-from-persisted-state`,
  `catchup-respects-tick-bounds`, `catchup-rate-limit-defers-at-cursor`, `catchup-completes-and-stops`
  and `restart-resumes-without-rereading-completed-channels` on real PostgreSQL, plus the catch-up
  configuration validation and the backoff arithmetic as units.
- Safe isolated database setup: dedicated PostgreSQL test database/schema with an explicitly
  supplied test connection; missing database access is reported as unavailable evidence, never
  passed ([testing guide](../architecture/testing.md)).
- Actual verification commands: none exist yet; recorded in project context when implementation is
  authorized.
- Documentation updates: project-context feature section, CONTENTS index, local `AGENTS.md` if
  invariants emerge.

## Decisions (2026-11-04)

- Gateway connection ownership: a dedicated `discord` feature module owns the single Gateway
  connection and exposes a normalized event-stream contract; ingestion and guild-state subscribe
  to it (closes former O1).
- Tombstone content is physically dropped on deletion: id, author, timestamps and `deleted_at`
  remain; text content and attachment metadata are removed (closes former O2; refines
  [ADR 0007](../adr/0007-mirror-message-lifecycle.md)).
- Migration runner: node-pg-migrate (version history, concurrency lock; TypeScript-native).
  Closes former O3.
