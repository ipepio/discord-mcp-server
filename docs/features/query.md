# Feature specification — Query (MCP retrieval tools)

## Goal and source request

- Owner: Project owner
- Source request (verbatim, owner brief):
    - "No se debe confiar en el LLM para filtrar información sensible."
    - "No deben poder suplantarse usuarios indicando arbitrariamente otro `discord_user_id` en los
      argumentos de una herramienta."
- Source request (verbatim, owner brief 2026-11-12, agent-facing behavior of this surface):
    - "tenemos que trabajar sobre el mcp y como se comporta. tengo varias dudas, si hay algo que tienes
      dudas de como responder, lanza subagentes para investigar y jugzgar, vale? ahí va. 1 - Ayer le
      pedí al harness que configurara el mcp y le pasé la url, 10 minutos estuvo dandóle vueltas,
      podemos hacer algo para que sepan como configurarse? 2 - Ahora que lo tengo instalado, el bot ve
      todos los canales dónde tengo acceso, también a los que el bot no tiene permiso. Ve su
      existencia, pero no el contenido (de los que tiene acceso) y si le pido novedades, mira todos
      los canales aunque no tenga acceso, cosa que es redundante. 3 - Le pedí que había visto y se
      puso a mirar desde el inicio del server de discord, no se si podemos mejorar un poco estas
      instrucciones, como lo gestioanrías? hay otros mcps de discord similares de los cuales nos
      podamos inspirar?"
- Source request (recorded decisions, quoted from [project context](../project-context.md)): "v1 MCP
  tool surface: `search_messages`, `list_channels`, `get_channel_history`, `get_thread_messages`,
  `get_message_context`; attachments as metadata only; retrieval only (reasoning belongs to the MCP
  client)." and "the hub identifies its guild in its MCP server metadata."
- Expected outcome: a `query` feature that owns the product's only functional external contract — the
  seven tools — the five v1 MCP tools, the digest R14 adds and the status tool R17 adds — the whole of
  the surface defined by
  [ADR 0004](../adr/0004-mcp-primary-transport.md). It answers with exactly the data the Requesting
  User's Discord permissions allow, evaluated at query time over stored state, and with nothing else:
  no reasoning, no summarization, no mutation. It consumes the effective-permission evaluation and
  registry identity contracts of [guild-state](guild-state.md), the hybrid retrieval contract of
  [semantic-index](semantic-index.md) and the identity seam of the authorization feature, and it owns
  its own read repositories over the message tables [ingestion](ingestion.md) writes. Glossary terms
  per [CONTEXT.md](../../CONTEXT.md).
- Non-goals:
    - Any LLM call, ranking explanation, summarization, tagging or answer synthesis. The hub retrieves;
      the MCP client reasons (ADR 0004, [ADR 0008](../adr/0008-semantic-search-v1-pgvector.md) invariant
      I3).
    - Any mutation: message writes, edit or delete mirroring, permission-state changes, embedding
      pipeline control. Ingestion and guild-state own those; this surface is read-only (R9).
    - Message storage, the message schema or migrations — [ingestion](ingestion.md); the permission
      registry and its derivation — [guild-state](guild-state.md); embeddings and fusion —
      [semantic-index](semantic-index.md).
    - Authentication, session issuance, OAuth2/OIDC metadata and the Discord login flow — authorization
      feature ([ADR 0006](../adr/0006-discord-sso-dynamic-client-registration.md)). This feature
      consumes the resolved identity; it never parses a token.
    - An HTTP/REST product API, an OpenAPI document or auxiliary endpoints: health/readiness belong to
      deployment, not here (ADR 0004).
    - Attachment bytes, attachment download or indexing (ingestion R11).
- Owning feature and local instructions: `query` (placement per
  [structure](../architecture/structure.md)); a local `AGENTS.md` is added at implementation only if
  feature-specific invariants emerge.
- Relevant accepted ADRs: [0001](../adr/0001-layer-ownership.md),
  [0003](../adr/0003-postgresql-without-orm.md), [0004](../adr/0004-mcp-primary-transport.md),
  [0005](../adr/0005-gateway-synced-permission-state.md),
  [0006](../adr/0006-discord-sso-dynamic-client-registration.md),
  [0007](../adr/0007-mirror-message-lifecycle.md),
  [0008](../adr/0008-semantic-search-v1-pgvector.md).

## Prerequisites

- The MCP authorization flow of the authorization feature is implemented and mounted in front of this
  feature's tools: the token, session and Discord-login surfaces are that feature's, not this one's
  ([ADR 0006](../adr/0006-discord-sso-dynamic-client-registration.md)). This specification consumes
  its identity seam (Contracts) and treats its specification as pending: until that specification
  exists, the seam below is the requirement it must satisfy.
- The `guild-state` registry is populated and its public contracts are importable: the
  effective-permission evaluation, the registry status, and the registry identity (Guild, channel and
  thread ids and names). A registry that is not current is a refusal condition, not an empty result
  (R11).
- The `semantic-index` hybrid retrieval contract is available for `search_messages`, with pgvector
  present and `EMBEDDING_MODEL`/`EMBEDDING_DIMENSION` valid at startup (semantic-index R6). The
  retrieval contract is consumed as a contract: neither this feature nor its tests import the
  embedding table or the provider.
- The ingestion-owned message tables exist with the column semantics ingestion froze (snowflake ids as
  `bigint`, instants as `timestamptz`, tombstones with content physically dropped). This feature reads
  those tables through its own repositories and writes nothing.
- Validated configuration at startup per the shared/config conventions (no scattered `process.env`
  reads). v1 introduces no variable owned by this feature: page bounds and the tool list are contract,
  not configuration. O1 later made the per-message content cap and the per-response byte cap validated
  settings (`QUERY_MAX_MESSAGE_CHARS`, `QUERY_MAX_RESPONSE_BYTES`).
- The bot's own User id is available to the composition root from validated startup configuration, the
  same value ingestion uses, because R12 and R14 need the bot-access axis. It never arrives from a tool
  argument (R1).
- The configured brand name (`HUB_BRAND_NAME`, shared brand configuration) is available to the
  metadata use case, because R15 composes it into the connection instructions instead of a hardcoded
  product name.
- guild-state's ingestible-channels contract (`ListIngestibleChannelsQuery`) is importable and its
  result distinguishes bot-viewable channels from channels the bot cannot view; R12 and R14 consume it
  as a contract and never re-derive bot access from Discord or from a registry table.

## Behavior

"Requester" means: the Requesting User — the [User](../../CONTEXT.md) whose identity the authenticated
session resolved, and the only identity any tool ever evaluates. "Accessible" means: the Requester's
effective permission set for that channel or thread, obtained from guild-state's evaluation at query
time, contains the permission bits the tool requires (R2). "Excluded" follows the ingestion
specification's definition: never returned by any read path. "Listing tool" means: `search_messages`,
`list_channels`, `get_channel_history`, `get_thread_messages` or `get_recent_activity`. "Not-found
semantics" means: the same observable tool result as an id that was never issued. "Mirrored" means:
stored by ingestion and still retrievable, which requires the bot to be able to view the channel or
thread it belongs to — the bot-access axis guild-state's ingestible-channels contract reports (R12).
"Intersection" means: the Requester's `VIEW_CHANNEL` entries **and** the bot-viewable entries, the two
sets intersected (R12). "Recent-first" means: `createdAt DESC, messageId DESC` with the cursor walking
backward in time (R13). "Digest" means: the grouped multi-channel result of R14. Each rule states the
rule, then a successful example, a rejected/boundary example, and error behavior where applicable.

- **R1 — Identity comes from the session, never from the arguments.** The Requester's Discord User id
  arrives resolved from the authenticated session established by the authorization feature. No tool
  input carries a principal User id, a principal User name, an "acting as" field or any equivalent, and every input schema
  is a closed object (`additionalProperties: false`): a call that supplies identity-bearing arguments
  is rejected as invalid input before any permission evaluation, any registry read or any message read.
  Silently ignoring such a field is not acceptable — the rejection is what makes impersonation
  impossible rather than merely ineffective.

    Documented retrieval filters such as `authorId` are permitted because they select results, never the
    principal whose permissions are evaluated; identity-bearing arguments remain forbidden at every depth.

    - Example: an MCP client holding a session for User U calls `get_channel_history` with
      `{ channelId, pageSize }`; results are filtered by U's evaluation, and U's id never appears in the
      request payload.
    - Rejected: a call carrying `discord_user_id` (or `userId`, `asUser`, a bearer token or any
      unrecognized field) returns `invalid_input` naming the unsupported field; no read repository is
      called and zero rows are returned. This is the owner requirement implemented: "No deben poder
      suplantarse usuarios indicando arbitrariamente otro `discord_user_id` en los argumentos de una
      herramienta."
    - Boundary: an invocation whose session resolves no User id is an authentication failure at the
      transport boundary, never an empty result. An empty result would be indistinguishable from "no
      permissions" and would mask a wiring defect behind plausible-looking data — and the owner rule is
      that the LLM is never the filter: "No se debe confiar en el LLM para filtrar información sensible."
    - Error: identity is read from the session only — never from tool arguments, client headers,
      environment, configuration or a previous call's output. A compromised MCP client can therefore not
      choose whose permissions are evaluated.

- **R2 — Permission enforcement precedes every response.** Every tool evaluates the Requester's
  effective permissions at query time, over stored rows, through guild-state's
  `EvaluateEffectivePermissionsQuery`, and applies the result before anything leaves the server:
  filtering is a query-time predicate over rows ([ADR 0008](../adr/0008-semantic-search-v1-pgvector.md)
  invariant I1), it completes before the response is produced (I2), and over-fetch used by retrieval
  is a quality measure that never substitutes it (I4). The accessible channel/thread id set is a
  mandatory parameter of every read repository operation in this feature, so a repository call that
  is not permission-scoped cannot be constructed.
    - Permission map, fixed here and identical across tools: **visibility** — `list_channels` returns a
      channel or thread only when the Requester holds `VIEW_CHANNEL` on it **and** the bot can view it
      (R12 amends the second half; the Requester's `VIEW_CHANNEL` half is unchanged); **content** —
      `search_messages`, `get_channel_history`, `get_thread_messages` and `get_message_context` return a
      message only when the Requester holds `VIEW_CHANNEL` **and** `READ_MESSAGE_HISTORY` on the channel
      or thread that holds it. A thread is evaluated as a thread, with its parent channel's restrictions
      still applying (guild-state R7 and its derivation order).
    - Example: U holds `VIEW_CHANNEL` but not `READ_MESSAGE_HISTORY` in `#backend` → `list_channels`
      includes `#backend`; `get_channel_history` for `#backend` returns an empty page (R3), never an
      error that would confirm content exists there.
    - Boundary: `ADMINISTRATOR` bypass, `@everyone` folding, overwrite ordering and fail-closed
      behavior for an unknown channel or a User without a Membership are guild-state's derivation. This
      feature never re-derives, caches, stores or second-guesses a permission set, and it accepts no
      caller-supplied permission, role or visibility field.
    - Error: an evaluation failure (technical error from the evaluation or the registry read) returns
      `internal_error` and zero rows. It is never rendered as an empty page: "we could not decide" and
      "you may not see it" are different facts, and only the second one is an empty result.

- **R3 — No existence leaks (security rule).** A channel, thread or message the Requester cannot access
  is observably indistinguishable from one that does not exist: the tool returns an empty result set
  with not-found semantics — same result shape, same `isError` flag, same message text, same absence
  of provenance — and never a permission-denied, forbidden or "no access" outcome that confirms
  existence. This applies to every read path, before and after hybrid fusion.
    - Example: U calls `get_message_context` for a message id in `#private` → the response is
      indistinguishable from the response for a fabricated id: an empty `data` array, no
      `anchorMessageId`, no error, identical tool-result shape and text.
    - Boundary: `search_messages` returns zero results from channels the Requester cannot read, including
      when a candidate would have scored highest — filtering happens before fusion, so a high score never
      becomes a leak ([ADR 0008](../adr/0008-semantic-search-v1-pgvector.md) invariants I2, I4). Server-side
      logs and counters may name the ids that were filtered out ([shared guide](../architecture/shared.md));
      no such id, count or reason reaches the client.
    - Error: the rule forbids a distinguishable object-level denial, so no tool defines a
      forbidden/permission error code. Session-level failures are a different case: an invalid, expired or
      absent session is an authentication error at the transport boundary, because it reveals nothing
      about stored data.
    - Boundary (stated honestly): the rule governs the response contract — payload shape, error flag,
      message text and provenance. Equalizing response _timing_ against an existence probe is not claimed
      in v1.

- **R4 — Bounded, stable pagination on every listing tool.** Each listing tool returns one bounded page
  and an opaque cursor for the next one: keyset (seek) pagination with a stable total order ending in
  the message or channel id as unique tie-breaker, `pageSize` an integer in 1..100 defaulting to 20, and
  at most `pageSize + 1` rows fetched to decide `hasNext` — no total count, no unbounded query, no
  `OFFSET` scan ([persistence guide](../architecture/persistence.md), [REST collection
  baseline](../architecture/rest.md)). Cursor pagination is the documented exception the REST guide
  permits: a mirror's message stream and a fused ranking have no stable page number, and MCP tools carry
  no REST query parameters. All tools that paginate use this one format; page-number and cursor formats
  are never mixed. The cursor is self-describing, opaque to the client, validated on decode, and carries
  no identity and no permission data — a forged cursor can therefore never widen access (R1, R2). v1
  keeps no server-side traversal state.
    - Ordering per tool (R7 states each): message listings **recent-first** by
      `(createdAt DESC, messageId DESC)` for the two traversals (R13); `list_channels` ascending by
      `(position, channelId)`; `search_messages` by fused rank with `messageId` ascending as
      tie-breaker; the `get_message_context` window keeps its ascending `(createdAt, messageId)`
      order, and `get_recent_activity` group ordering is R14's own. History (superseded 2026-11-12):
      until the owner's D2 decision every message listing was "ascending by `(createdAt, messageId)`",
      which made an unanchored history call start at the channel's first stored message — the owner's
      observed "puse a mirar desde el inicio del server de discord". The keyset, page bound, cursor
      format and probe rules below are unchanged by that flip.
    - Example: `#backend` has 55 accessible messages; `pageSize: 20` → page 1 returns 20 with
      `hasNext: true` and `nextCursor`, page 2 returns 20, page 3 returns 15 with `hasNext: false` and
      `nextCursor: null`.
    - Boundary: under concurrent inserts the keyset order guarantees no repeated row and no skipped row
      for the key-ordered tools — a message created after the cursor's key appears only on a later page,
      and a tombstoned row between pages shortens a page instead of shifting it. A cursor is bound to the
      tool, the filter set and (for `search_messages`) the query text that produced it; presenting it with
      different filters is `invalid_input`, never a silently different result set. For `search_messages`
      the corpus can re-rank between pages, so a paged traversal may skip or repeat a row when the corpus
      changes mid-traversal; what is guaranteed and tested is the ordering key, the page bound, and that
      every returned row was accessible at query time. `get_message_context` is not a listing tool: it
      returns one window bounded by `windowSize` (R7 T5) and carries no cursor.
    - Error: `pageSize` outside 1..100, a non-integer, or a cursor that fails validation (malformed
      encoding, unknown tool tag, filter mismatch) returns `invalid_input` naming the offending field; no
      message read is issued and zero rows are returned.

The hybrid producer applies documented channel, author and inclusive date filters as SQL predicates
in both branches before candidate limits and fusion, separately from the mandatory ACL set. It owns
the shared contract and supports validated score/message-id keyset pagination over a fixed bounded
candidate horizon; corpus changes retain the re-ranking caveat in R4.

- **R5 — Search goes through the hybrid retrieval contract.** `search_messages` obtains candidates
  exclusively from semantic-index's hybrid retrieval contract: this feature never queries embedding
  tables, never computes or stores an embedding, and never re-implements fusion. FTS reachability before
  embedding is inherited — a stored message without a vector is still found when its text matches —
  and the query embedding uses the configured model (semantic-index R6). Over-fetch inside that contract
  is quality only and never the permission filter (invariant I4); the permission filter runs before
  fusion (R2, R3). The configured model and dimension must match the migration or startup already failed
  (semantic-index R6); vectors of a foreign model are never fused into one result set.
    - Example: during a historical import, a channel's messages are stored but not yet embedded →
      `search_messages` returns the ones whose text matches the FTS branch, with `retrieval: "hybrid"`
      because both branches ran.
    - Boundary: when the query embedding cannot be obtained (embedding provider outage or rejected call),
      the search degrades to the full-text branch and says so in the response (`retrieval:
"full-text-only"`), because messages not yet embedded must stay fully reachable through FTS
      ([ADR 0008](../adr/0008-semantic-search-v1-pgvector.md) decision 7). Degrading never widens access —
      the permission filter and every other rule are unchanged — and the marker is a page-level fact, not
      a per-message claim about which branch matched (the retrieval contract does not promise one).
    - Error: a technical failure of the retrieval contract itself (database or SQL error, corrupt index)
      returns `internal_error` and zero rows; a partial page is never returned. A provider failure is not
      an error case — it is the documented FTS-only degradation above.

- **R6 — Tombstones and deleted channels are excluded from every read path.** No tool can return a
  tombstoned message or a message of a deleted channel or thread; the exclusion is a query-time
  predicate of every read repository operation in this feature, unconditional on any pipeline's lag, and
  it cannot be switched off by a tool, a cursor or a configuration flag
  ([ADR 0007](../adr/0007-mirror-message-lifecycle.md);
  [ADR 0008](../adr/0008-semantic-search-v1-pgvector.md) decision 5; ingestion R6; semantic-index R4).
    - Example: a message deleted on Discord one second ago, with the tombstone applied and its vector not
      yet removed → absent from `search_messages` in both branches, from `get_channel_history`, from
      `get_thread_messages`, and from the `get_message_context` window around a neighbouring message.
    - Boundary: tombstones keep the id, author and timestamps and drop text and attachment metadata
      (ingestion R6), so returning one would leak a deleted message's author and instants even with empty
      content; the predicate is therefore `deleted_at IS NULL` on every message read, not a
      content-emptiness check. An anchor message that is tombstoned yields the not-found result of R3 — an
      empty window — never a partial window centred on a hidden row. Omitted rows leave no placeholder and
      no gap count: a deleted message is not acknowledged.
    - Error: a read repository operation that can return a tombstoned row, or a message whose channel or
      thread is deleted, is a defect of this feature; the per-path tests in Implementation and proof cover
      each tool and each repository operation, not one shared sample.

- **R7 — Per-tool behavior (one contract per tool).** The names, inputs and outputs below are the
  external contract; T1–T5 add only what each tool does with them. Every message result carries the same
  provenance fields (Contracts) so a client can attribute and locate what it received, and every message
  result additionally obeys R2, R3, R6 and R10. Two amendments keep the existing tool numbers stable:
  T2's entry set is narrowed by R12 (which segments count as listed), and T3's and T4's default order is
  replaced by R13 (recent-first with a backward cursor). R14 adds a sixth tool whose full contract is
  stated there rather than duplicated here.

    - **T1 — `search_messages`.** Input: `query` (string, 1..1000 characters — see O2 for the empty-query
      case), and optional filters `channelId` (a channel **or** thread id; a separate `threadId` field is
      deliberately not offered, since threads are channels in the registry — guild-state R6),
      `authorId`, `from` and `to` (inclusive `timestamptz` bounds on `createdAt`), `pageSize`, `cursor`.
      Filters are an allowlist, never a free-form expression, and are combined with `AND`. Output: a page
      of message results ordered by fused rank (ties broken by `messageId` ascending) plus the page
      metadata and the `retrieval` marker of R5.
        - Example: `{ query: "deploy fallido", channelId: "#backend's id", from: "2026-10-01T00:00:00Z" }` →
          matching messages the Requester may read, best fused match first, with their channel and thread
          provenance.
        - Boundary: a filter naming a channel the Requester cannot read is not an error; it yields zero
          results (R3). An empty `query` is `invalid_input` unless O2 is resolved otherwise. A `from` later
          than `to` is `invalid_input`; a `from`/`to` pair that excludes everything is a valid empty page.
        - Error: a `query` over 1000 characters, an unknown filter field, a malformed id or date returns
          `invalid_input` naming the field; no retrieval call is made.
    - **T2 — `list_channels`.** Input: `pageSize` and `cursor` only — no filters, because the result _is_
      the Requester's visibility (R2). Output: a page of registry entries ordered by `(position,
channelId)` ascending, each with `channelId`, `name`, `kind` (`channel` | `thread`),
      `parentChannelId` (null for a channel, mandatory for a thread) and `position`.
        - Example: U may view 12 of the Guild's 30 channels and 3 of its threads → the tool pages through
          exactly those 15 entries and never mentions the other 18, not even as a count (R3).
        - Boundary: threads are listed as entries carrying their `parentChannelId`, and a listed thread does
          not imply that its parent channel is also listed: every entry carries its own evaluation result and
          the tool never explains a missing parent — an inaccessible parent is indistinguishable from a
          deleted one (R3, R6). Entries carry no message counts, last activity or any other
          message-derived field: this tool reads the registry, not messages.
        - Error: `pageSize` or `cursor` invalid → `invalid_input`; registry status not current → R11
          refusal; zero accessible entries → a valid empty page, not an error.
        - History (superseded 2026-11-12): the example above enumerates the Requester's visibility alone,
          which is what the tool did until the owner's D1 decision. R12 narrows the entry set to the
          intersection with the bot-access axis; the input, entry shape and ordering here are unchanged.
    - **T3 — `get_channel_history`.** Input: `channelId` (required, channel or thread id), optional `from`
      and `to` (inclusive bounds on `createdAt`), `pageSize`, `cursor`. Output: a page of message results
      in **recent-first** `(createdAt DESC, messageId DESC)` order (R13), with page metadata.
        - Example: `{ channelId: "#backend", from: "2026-11-01T00:00:00Z" }` with `pageSize: 20` returns the
          newest messages of the range first and continues backward toward `from` as the cursor is used.
        - Boundary: a `channelId` the Requester cannot read, an unknown id and a deleted channel all return
          the same empty page (R3, R6). Recent-first is deliberate: "what happened lately" is the question an
          agent asks first, ignoring it forced a full traversal from the channel's beginning.
        - Error: `channelId` missing or malformed → `invalid_input`; `from` after `to` → `invalid_input`;
          per-page bound (R10) may shorten a page below `pageSize` with `hasNext: true`.
        - History (superseded 2026-11-12): this tool was "ascending `(createdAt, messageId)` order" and its
          example paged _forward_ through November. The owner's D2 decision replaces the default direction
          and cursor continuation; R13 states the cursor semantics precisely.
    - **T4 — `get_thread_messages`.** Input: `threadId` (required), `pageSize`, `cursor`. Output: a page of
      message results in **recent-first** `(createdAt DESC, messageId DESC)` order (R13), with page
      metadata; thread provenance is on every message and on the page.
        - Example: a forum post thread with 240 messages → the newest 20 first, each message carrying
          `threadId` and `parentChannelId`, with the cursor walking back toward the thread's first message.
        - Boundary: a `threadId` that names a channel rather than a thread, a thread the Requester cannot
          read, an unknown id and a deleted thread all return the same empty page (R3, R6) — the tool never
          explains which case applied. No filters beyond the thread itself are offered, matching the v1
          surface; time bounds stay a `get_channel_history` capability, and R13 records that keeping this
          parameter surface unchanged is deliberate rather than an omission.
        - Error: `threadId` missing or malformed → `invalid_input`; R10 page shortening as in T3.
        - History (superseded 2026-11-12): this tool was "ascending `(createdAt, messageId)` order". R13
          applies the same recent-first default here, because a thread is where "the latest replies" is
          asked about most often.
    - **T5 — `get_message_context`.** Input: `messageId` (required), `windowSize` (integer 1..100, default
      20), and nothing else. Output: the anchor message plus up to `floor((windowSize - 1) / 2)` older and
      `ceil((windowSize - 1) / 2)` newer accessible messages of the same channel or thread, ordered by
      `(createdAt, messageId)` ascending, with `anchorMessageId` echoed and one page of results; no cursor
      (R4).
        - Example: `{ messageId: "<id>", windowSize: 10 }` → the anchor plus 4 older and 5 newer messages,
          with provenance locating each one.
        - Boundary: an anchor the Requester cannot read, a fabricated id and a tombstoned anchor all return
          the same empty result with no `anchorMessageId` (R3, R6). The window never crosses a channel or
          thread boundary, and tombstones and deleted channels inside the window simply do not appear.
        - Error: `messageId` missing or malformed, or `windowSize` outside 1..100 → `invalid_input` naming
          the bound; no message read is issued.

- **R8 — Server metadata identifies the Guild.** The MCP server metadata this Installation advertises
  (server name and description, and the description surfaced to clients at connection time) includes the
  Guild's name as stored in guild-state's registry, so a client connected to several Installations — one
  per Guild — can tell them apart and ask the user which one to use. The identity is read per connection
  from guild-state's public contract; this feature stores nothing (R9).
    - Example: an operator self-hosts two Installations, for guild A and guild B → a client lists two
      servers whose metadata names A and B, and the user picks the right one before any tool runs.
    - Boundary: while the registry is `incomplete` or `unavailable` (a fresh installation before its
      bootstrap finishes, or the bot removed), the metadata states the Guild is not yet identified rather
      than inventing a name, and the connection still succeeds; tools then refuse under R11. A Guild rename
      is reflected on the next connection because the name is read at connection time, never cached in
      this feature.
    - Error: a failure reading the Guild identity never blocks the MCP connection and never fabricates a
      value; the metadata falls back to the unidentified-Guild wording and the failure is logged with the
      Guild id only.

- **R9 — Read-only surface.** No MCP tool mutates anything: no message is created, edited or deleted, no
  tombstone is written, no permission or registry row changes, no embedding is computed or enqueued, no
  cursor or traversal state is persisted, and no Discord API is called. Permission state is mutated only
  by Discord-originated events ([ADR 0005](../adr/0005-gateway-synced-permission-state.md)); message
  state only by ingestion. The property is structural: this feature's public surface contains no
  command, every repository operation it owns is a read, and no tool handler can reach a write path.
    - Example: calling all seven tools, twice each, leaves every row, tombstone, registry row, embedding and
      pipeline cursor unchanged; identical calls return identical results modulo concurrent Discord
      changes.
    - Rejected: a client asking a tool to "delete this message" or "edit that one" has no such input and
      no such tool; the closest call is a read, and if the request carries an unknown field it is
      `invalid_input` (R1) with nothing written.
    - Error: read-only is enforced by construction, not by review — a repository operation that writes, an
      embedding call or a Discord gateway dependency appearing in this feature is a defect found by the
      structural tests in Implementation and proof.

- **R10 — Bounded payloads.** Every tool result is bounded three ways, because a single huge message or
  a page of stored content must not become an unbounded response: by the page bound of R4 (`pageSize`
  1..100 plus the one-row probe); by a per-message content cap, applied to `content` with
  `truncated: true` and the stored `contentLength` reported so the client knows how much it is missing;
  and by a per-response size cap, which shortens a page below the requested `pageSize` while keeping
  pagination correct (`hasNext: true`, valid `nextCursor`) instead of failing or exceeding the cap.
  Truncation is always explicit — a silently shortened field or a silently dropped attachment is a
  defect. Attachments are metadata only (id, filename, content type, size, URL) and attachment bytes are
  never read or returned (ingestion R11).
    - Example: a page of 20 messages, one of them 40 000 characters → the page is returned with that
      message marked `truncated: true`, its `contentLength` reported, every other field intact, and the
      remaining messages still reachable through `nextCursor`.
    - Boundary: the per-message cap value, the per-response size cap and the truncation shape are O1 —
      deliberately open, because truncation is irreversible in v1 (no tool returns full content) and the
      numbers have product consequences. What is not open: the truncation is flagged, the stored length is
      reported, and no tool silently drops a field, an attachment or a message.
    - Error: content that cannot be serialized within the cap is truncated (never an error); a response
      that cannot be built inside the cap even after truncation still pages by shortening, and a
      persistent failure to build a valid page is `internal_error` with zero rows.

- **R11 — Registry status gating (fail closed).** Before evaluating permissions, each tool reads
  guild-state's status with `GetGuildStateStatusQuery`. If the registry reports `stale`, `incomplete` or
  `unavailable`, the tool refuses: it returns a retryable `state_unavailable` error naming the status
  and zero rows, and never evaluates permissions against state the hub knows is not current — a resync
  window could otherwise keep serving content revoked while the hub was not listening
  ([ADR 0005](../adr/0005-gateway-synced-permission-state.md), guild-state R11). This mirrors the
  gating policy of the authorization feature; that specification owns the shared statement of the
  policy, and this rule is this feature's obligation under it. The refusal is a server-state fact, not
  an object-level denial, so it discloses nothing about stored data (R3).
    - Example: a resync is in flight after a Gateway reconnect → all six gated tools return
      `state_unavailable`; the moment the status returns to current they serve normally, with no restart.
      R17's `get_hub_status` is the one tool this rule does not gate, because its answer _is_ the status.
    - Boundary: the status read and the permission evaluation happen within one request, so a status
      change mid-request does not retroactively alter a response; the next request reflects it. Gating is
      all-or-nothing per request: there is no partial answer computed from partly current state.
    - Error: a failure of the status read itself is treated as not-current — the same `state_unavailable`
      refusal. The feature never assumes the registry is current because the read failed, and never
      degrades to unfiltered results.

- **R12 — `list_channels` lists only what the hub actually mirrors (owner decision D1, 2026-11-12).**
  Input, entry shape and ordering are T2's and unchanged. What changes is _which_ channels and threads
  qualify: an entry is listed only when it is in the **intersection** of the Requester's viewable
  entries — guild-state's `ListUserAccessibleChannelsQuery`, the same evaluation R2 already consumes —
  and the bot's own viewable entries — guild-state's `ListIngestibleChannelsQuery`, the contract
  ingestion enumerates from. Both axes are read from the registry per call, from one status-gated
  request (R11), and neither is cached. There is no readability field, no `ingested` flag and no
  `botCanView` boolean: a non-ingested channel simply does not appear, exactly as a channel the
  Requester cannot see does not appear (R3).
    - Owner requirement (verbatim): "ahora mismo el bot como POC solo tiene acceso a un canal, pero
      debería de devolverte TODO lo que un usuario puede ver Y el bot está en el canal. En un futuro el
      bot estará en todos los canales y el usuario solo debería de ver solo lo del user".
    - Example: the Guild has 30 channels, U may view 12 of them and the bot currently views 1 → the tool
      pages through exactly that 1 entry, and the other 29 are absent, not even as a count (R3). When the
      bot is later invited to every channel, the same call returns all 12 of U's channels with no tool
      change, because the axis is evaluated per call.
    - Boundary (both absences look the same): a channel the Requester can view but the bot cannot, and a
      channel the bot can view but the Requester cannot, produce the same observable fact — an entry that
      is simply not in the page, with no error, flag, count or ordering anomaly distinguishing them (R3).
    - Boundary (bot access, not stored rows, is the second axis): a channel the bot can view that has zero
      mirrored messages so far — a backfill that has not reached it, or a channel created a minute ago —
      is still listed, because the axis is the bot's registry-evaluated visibility. Requiring stored rows
      would make the list flap during every import and would hide a channel the agent may legitimately ask
      history about. Non-text-capable registry rows (categories, voice, stage, directory) are never
      mirrored by ingestion and therefore leave the list even when the Requester can view them.
    - Boundary (bot identity): the bot User id comes from validated startup configuration, never from a
      tool argument (R1), and is passed to the contract as input; this feature never derives bot access
      itself, never reads registry tables and never calls Discord (R9).
    - Error: `pageSize`/`cursor` invalid → `invalid_input`; registry status not current → R11 refusal; a
      failure of either axis → `internal_error` with zero rows. Falling back to a single-axis list is
      forbidden: it would answer a different question than the one the owner fixed, silently.
    - History (superseded 2026-11-12): T2's entry set was the Requester's visibility alone — `list_channels`
      "returns a channel or thread only when the Requester holds `VIEW_CHANNEL` on it" — which the owner
      observed as "el bot ve todos los canales dónde tengo acceso, también a los que el bot no tiene
      permiso. Ve su existencia, pero no el contenido". The 2026-11-04 decision wording "the result _is_
      the Requester's visibility (R2)" is replaced by the intersection above.

- **R13 — Recent-first default for channel and thread history (owner decision D2, 2026-11-12).** For
  `get_channel_history` (T3) and `get_thread_messages` (T4), a call that supplies **no cursor** returns
  the most recent messages of its filter window, ordered `(createdAt DESC, messageId DESC)`, and every
  `nextCursor` continues **backward** toward the past. `from`/`to` keep their meaning as inclusive
  `timestamptz` bounds on `createdAt` and are applied as the same predicates; what changes is the
  direction the traversal walks inside them. A full traversal therefore begins at the recent end of the
  range (or at "now" when no `to` is given) and ends at `from` (or at the oldest stored message).
    - Owner requirement (verbatim): "Recientes primero".
    - Cursor semantics (precise, and the whole mechanism R4 already fixes): a cursor keeps the existing
      self-describing envelope — base64url of `{ version: 1, tool, binding, key }` — where `key` is the
      `{ createdAt, messageId }` of the **last row returned on the page** and `binding` is the hash of the
      tool plus the exact filter set (`channelId`/`threadId`, `from`, `to`). Continuation selects rows
      with `(created_instant, message_id) < (key.createdAt, key.messageId)` and returns them in
      `created_instant DESC, message_id DESC` order with `LIMIT pageSize + 1`. Because the key is a
      position in the same total order, no direction token is added to the cursor: the tool's default
      direction decides the comparison. `hasNext: true` means at least one older row exists inside the
      filter set; the final page returns `hasNext: false` and `nextCursor: null`. O5 records the one
      compatibility question this leaves open.
    - Example: `#backend` holds messages from 2026-10-01 to 2026-11-10; `get_channel_history { channelId }`
      with `pageSize: 20` returns the 20 newest first, and its cursor continues into 2026-11-09 downward.
    - Example (explicit range): `{ channelId, from: "2026-11-01T00:00:00Z", to: "2026-11-07T23:59:59Z" }`
      returns the newest messages at or below `to` first, then walks back to `from`.
    - Boundary: `from` alone gives the newest end of `[from, now]`; `to` alone gives `to` backwards; neither
      gives "now" backwards. `from` later than `to` stays `invalid_input`. An empty range is a valid empty
      page with `hasNext: false` (R3), not an error.
    - Boundary (threads, explicit decision): `get_thread_messages` keeps its parameter surface exactly
      `{ threadId, pageSize, cursor }`. Adding `from`/`to` there is a separate additive change the owner
      did not request, so it is not part of this decision even though the ordering flip applies to both
      tools.
    - Unchanged by this rule: `get_message_context` still returns its window in ascending
      `(createdAt, messageId)` order (a window is read around an anchor, not traversed), and
      `search_messages` still orders by fused rank. Neither tool's default direction changes.
    - Error: an invalid or tampered cursor is `invalid_input` with zero reads (unchanged); a cursor minted
      for another tool or another filter set is `invalid_input` through the binding (unchanged).
    - History (superseded 2026-11-12): both tools were "ascending `(createdAt, messageId)`" and the 2026-11-04
      decision recorded "message listing order is ascending by `(createdAt, messageId)`; newest-first
      presentation is the MCP client's concern". The owner's observed consequence was "Le pedí que había
      visto y se puso a mirar desde el inicio del server de discord"; the page bound, keyset guarantees,
      tombstone and ACL predicates, and the cursor envelope are unchanged.

- **R14 — `get_recent_activity`: one-call multi-channel novelty digest (owner decision D3, 2026-11-12).**
  A sixth tool (additive under Contracts) that answers "what is new" without the agent enumerating
  channels or guessing a window: one call returns recent messages **grouped by channel**, with
  per-channel counts and per-channel backward cursors. It obeys R1, R2, R3, R6, R9, R10 and R11 exactly
  like the other five, and it is read-only in the same structural sense.
    - Owner requirement (verbatim): "mira los últimos mensajes (podría ser desde el último mensaje que
      envió el usuario)"; the ambiguity obligation is "Si la pregunta es ambigua, se debe de responder, si
      no se especifica el canal o la categoría ni ventana de tiempo que se pregunte"; the owner's examples
      are "Ej: hazme resumen delos últimos 15 días, hace un resumen de todo. Dime que novedades hay en
      dev-general, mira los últimos mensajes (podría ser desde el último mensaje que envió el usuario)".
    - Input (closed object, `additionalProperties: false`, no identity field — R1): `channelId?` (a channel
      or thread id, scoping the digest to that one container), `since?` (RFC3339 instant, inclusive lower
      bound), `sinceByMyLastMessage?` (boolean anchor mode), `pageSize?` (integer 1..100, default 20, the
      **per-group** page bound), `cursor?`. `since` together with `sinceByMyLastMessage` is `invalid_input`
      naming the conflicting field. O4 resolved by omission (Implementation resolutions 2026-11-12): no
      `categoryId` input exists, so an unsupported `categoryId` field is plain `invalid_input`.
    - Effective window (precise): `[since, now]`, inclusive at both ends, where `now` is the query-time
      instant taken from the injected clock. The response reports which rule decided the lower bound as
      `window.anchor`: `"since"` (explicit), `"my-last-message"` (anchor mode) or `"default-24h"` (neither
      given, lower bound = `now - 24h`).
    - Anchor mode (`sinceByMyLastMessage: true`): the lower bound is the `createdAt` of the newest message
      the **Requester** authored — in the scoped container when `channelId` is given, and the maximum over
      the whole mirrored set when it is not (the owner's "desde el último mensaje que envió el usuario").
      The bound is inclusive, so the Requester's own anchor message appears in the digest; that is the
      contract, and a client that wants strictly-newer content passes an explicit `since` instead. O7
      records what happens when no such message exists.
    - Scope set (the same intersection R12 fixed): the Requester's `VIEW_CHANNEL` entries with
      `READ_MESSAGE_HISTORY` (the content gate of R2) **and** the bot-viewable entries; `channelId`
      narrows it to one container (O4 resolved by omission: no category scope). Containers outside the intersection are never mentioned, not even as an empty
      group (R3), and an empty scope is a valid empty digest, never an error.
    - Output shape (the digest envelope, recorded in Contracts):
      `{ data: activityGroup[], window: { since: instant | null, anchor } }`, where each `activityGroup` is
      `{ channelId, channelName, parentChannelId, messageCount, returnedCount, messages,
pagination: { pageSize, hasNext, nextCursor } }`. `messageCount` is the number of messages the call
      can still reach inside the window for that container after the R2/R6 predicates — the window total on
      a fresh call, and what the presented cursor can still reach on a continuation (the cursor semantics
      below), which keeps `hasNext` exact; `returnedCount` is `messages.length`;
      `hasNext` is true exactly when `messageCount > returnedCount`. Groups are ordered by their newest
      returned message descending with `channelId` ascending as tie-breaker; the messages inside a group
      follow R13's recent-first order and its cursor continuation, so paging a group behaves exactly like
      `get_channel_history` on that container.
    - Bounded work: the digest issues a bounded number of statements independent of the number of scoped
      containers (one grouped count over the scope set and one partitioned page read), never a query loop
      per container. R10's byte cap applies: the response is shortened from the least recently active
      group's oldest end by dropping whole messages, and a group shortened to zero messages stays present
      with `messages: []`, its `messageCount`, `hasNext: true` and a valid `nextCursor` — never silently
      dropped, so the agent still learns there is activity and can ask for it (explicit, not silent).
    - Example: U can read 12 channels and the bot mirrors 1 of them → `get_recent_activity {}` returns one
      group for that channel; when the bot is invited to the rest, the same call returns the channels that
      had activity in the last 24 hours.
    - Boundary (ambiguity is instruction text, not tool behavior): the tool never asks a question. When the
      person named no channel/category and no window, the hub still answers with the 24-hour default; it is
      R15's instruction text that tells the agent to ask first. The hub keeps **no per-user read state**: no
      read markers, no last-seen cursor, no per-user novelty table — novelty is time/anchor based only, and
      user scoping comes from permissions (R2) automatically, as the owner confirmed.
    - Boundary (scoped call with an unreadable or unknown id): the digest returns `data: []` with its
      `window` reported, indistinguishable from a container that had no messages in the window (R3, R6).
    - Error: `pageSize`/`cursor` invalid, a malformed instant, or `since` with `sinceByMyLastMessage` →
      `invalid_input` naming the field (an unsupported `categoryId` field is `invalid_input` too, O4's
      omission); registry status not current → R11;
      a technical failure of the read → `internal_error` with zero rows (never a partial digest). A group's
      cursor is bound to this tool, that group's `channelId` and the window SELECTION the client restates
      (`since` / `sinceByMyLastMessage`; a relative window's resolved bound is recomputed at query time, and
      the absolute key position keeps the continuation free of repeats and skips) (R4's binding), so
      continuing a group requires naming that `channelId` and the same window; O8 records the alternative
      representation.

- **R15 — Connect-time instructions and tool descriptions teach the agent (owner decision D4, 2026-11-12).**
  The `initialize` result's `instructions` field stops being a restatement of `serverInfo.description` and
  becomes a short, stable onboarding text, composed per connection from the brand name and the Guild
  identity (R8, never cached) in six required blocks, in the owner's product language:
    - Identity: the configured brand name (never a hardcoded product name) and the Guild name and Guild
      id, so a client connected to several Installations can tell them apart and say which one it is
      talking to. When the registry is `incomplete` or `unavailable`, R8's unidentified-Guild wording is
      used, the connection still succeeds, and tools refuse under R11.
    - First connect: the surface is OAuth-protected; the client discovers the authorization server from
      the protected-resource metadata that the 401 of R16 advertises, and the **human** must complete the
      Discord browser login. The agent is told to surface that login/link to the person and wait for
      them, instead of retrying the request, re-probing the URL or inventing a result.
    - Novelty: use `get_recent_activity` to answer "what is new"; when the person named neither a
      channel/category nor a time window, **ask** before calling, quoting the owner's examples as the
      shapes of a well-formed request (a summary of N days, everything, one channel's news, since the
      person's own last message). The text states that the hub tracks no per-user read state, so
      "novelty" is always a time or anchor window the agent must agree with the person.
    - History: history is recent-first; page backward with the cursor; use `from`/`to` for an explicit
      range; `get_message_context` for the discussion around one message; `search_messages` to find a
      topic. `list_channels` returns only what both the person and the bot can see (R12).
    - Mirror scope (added by this amendment; required in every locale, O10): the hub mirrors only part of
      the Guild, so `list_channels` lists a subset **on purpose** and a short page is not a pagination
      defect. The block names `get_hub_status` as the one call that reports the mirror scope and the
      registry status, so the agent verifies before it concludes that something is missing. Required
      wording in the configured locale; both variants carry the same three facts — a subset on purpose,
      not a pagination defect, verify with `get_hub_status`:

        ```text
        en  Mirror scope: this hub mirrors only part of the Guild — the channels and threads that both the
            person and the bot can see. `list_channels` lists a subset on purpose, so a short list is not a
            pagination defect: call `get_hub_status` for the mirror scope (visibleAndMirroredChannelCount)
            and the registry status before concluding that something is missing.
        es  Alcance del espejo: este hub replica solo una parte del Guild — los canales e hilos que la
            persona y el bot pueden ver. `list_channels` lista un subconjunto a propósito, así que una lista
            corta no es un fallo de paginación: llama a `get_hub_status` para ver el alcance del espejo
            (visibleAndMirroredChannelCount) y el estado del registro antes de concluir que falta algo.
        ```

    - Honesty: results are limited by the person's Discord permissions and by what the bot mirrors; a
      missing channel is not reported as "does not exist"; no tool mutates anything (R9).
    - The five existing tool descriptions are rewritten in the same spirit so a client that never shows
      `instructions` still learns the default order, the intersection and the ambiguity rule; the required
      text is listed in Contracts. Descriptions carry no per-user data, no channel id and no message
      content, and instruction text never carries the Requester's identity, their permission set or their
      channel list (R1, R3).
    - Example: two Installations (guild A and guild B) → each `initialize` result names its own brand and
      Guild, states the Discord login is the human's step and describes recent-first history.
    - Boundary: the text is a contract, not a marketing string — a required fact missing from it is a
      defect found by the named test (Implementation and proof), and it is generated from the declared
      metadata module rather than duplicated per transport.
    - Error: a failure composing the text never blocks the connection; the identity half falls back to R8's
      unnamed-Guild wording and the failure is logged with the Guild id only (R8's error behavior, reused).
    - History (superseded 2026-11-12): `instructions` used to be exactly the `serverInfo` description —
      `instructions: description` in `src/features/query/queries/get-server-metadata.query.ts` — which the
      owner experienced as an agent that had no idea how to configure itself or where to start reading.
    - History (superseded by this amendment): "in five required blocks" — the mirror-scope block is the
      sixth. It was added after a real client compared a short `list_channels` page with an older, longer
      one and reported a pagination defect ("Solo 2 canales — algo falla en la paginación. Comparo con la
      lista anterior.", `odd/tasks/mcp-client-resilience.md` L1, S3). The five blocks above keep every fact
      they required, and no other description is reworded by it.

- **R16 — Unauthenticated MCP requests advertise the protected-resource metadata (owner decision D4,
  verify-and-fix, 2026-11-12).** A request to the `/mcp` surface without a valid bearer credential
  answers HTTP `401` with
  `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_BASE_URL>/.well-known/oauth-protected-resource"`,
  executes no tool, and returns no tool result — the MCP authorization specification's protected-resource
  metadata discovery (modelcontextprotocol.io, 2025-06-18, basic/authorization). The metadata document
  itself is reachable without a credential and names the authorization server, so a client bootstraps
  discovery with no operator help: this is the machine-readable half of R15's first-connect block.
    - Owner requirement: the owner's "10 minutos estuvo dandóle vueltas" on configuring a client is the
      behavior this rule and R15 exist to remove.
    - Ownership: the guard is the authorization feature's and it emits this header today
      (`mcp-authentication.guard.ts`), with tests asserting it. This rule records the agent-visible
      contract this feature is mounted behind and makes its verification this feature's obligation; if a
      verify-and-fix pass finds the header, the absolute metadata URL or the 401-before-dispatch ordering
      missing or regressed, the fix lands in the owning feature, never by widening this feature's surface.
    - Example: a fresh client calls `/mcp` with no `Authorization` header → `401`, the header above, and an
      anonymous read of the metadata document that names the authorization server; the client then runs
      dynamic registration and sends the human to the Discord login (R15).
    - Boundary: absent, malformed, expired and revoked credentials all produce the same `401` shape — the
      same status, the same challenge with `resource_metadata` — so no session state is revealed; the
      _class_ of the failure is named by the authorization feature's R17 (a missing credential carries no
      `error` parameter, an expired or invalid one carries `error="invalid_token"`, a technical failure
      carries `temporarily_unavailable` and `Retry-After`), and still reveals nothing about stored data. A
      request with a valid bearer proceeds to R1 and R11 and never sees this response. `401` is a transport
      outcome, never one of the tool error codes (R3's stated distinction).
    - Error: the rule adds no new error code. A failure to build the metadata document is an
      `internal_error` of the authorization feature's surface, not a 200 with a broken body.

- **R17 — `get_hub_status`: one call answers "is this hub healthy, and is this count the truth?" (owner
  decision "3 · Tool de estado", 2026-11-12).** A seventh tool (additive under Contracts) whose input is
  the empty closed object — `{}` and nothing else — and whose whole result is one status object:
  `{ guild: { name, id }, registry: { status }, mirror: { visibleAndMirroredChannelCount } }`. That is a
  fourth documented envelope: no `data` array and no pagination, because the answer is one fact, not a page.
  `registry.status` is guild-state's own vocabulary — `current` | `incomplete` | `stale` | `unavailable`
  (guild-state `GUILD_REGISTRY_STATUSES`, R11) — and `guild` is the identity R8 already reads.
  `mirror.visibleAndMirroredChannelCount` is the size of the intersection R12 defines: the containers this
  Requester can view **and** the bot can view, counted as `list_channels` lists them (channels and threads,
  never messages), from the same two contracts and with the bot's User id from validated configuration.
    - Owner requirement (verbatim, with the report that produced it): "lo que quiero mejorar es esto",
      after the client concluded "Solo 2 canales — algo falla en la paginación. Comparo con la lista
      anterior." and "El hub ahora solo devuelve 2 canales (antes 129)."
    - Why it exists: that comparison was a false positive — the 2 channels are correct — and nothing in the
      surface let the client tell a mirror scope from a broken page. The count is exactly what the caller
      could already obtain by paging `list_channels` to exhaustion (R12), so stating it discloses nothing
      the caller cannot enumerate (R3), and one call replaces the enumeration.
    - R11 does not gate it: its answer _is_ the status, so a `stale`/`incomplete`/`unavailable` registry is
      reported instead of refused. While the status is not current it reads no channel list, so it never returns
      a count computed from state the hub cannot attest; O12's resolution (Implementation resolutions,
      2026-11-12) widens `mirror` to `null` in that case.
    - Never in the response: a channel id, a channel name, a parent id, a message, a byte of content, and no
      count of containers the caller cannot enumerate. The object carries no per-container field at all, so
      it cannot confirm the existence of a container `list_channels` would not list (R3).
    - Example (healthy hub, mirror scope 2): `{}` → `{ guild: { name: "Example Guild", id: "<Guild id>" },
registry: { status: "current" }, mirror: { visibleAndMirroredChannelCount: 2 } }`. A client that saw
      2 today and 129 before can now tell that 2 is the truth for this person and this bot, instead of
      reporting a pagination defect.
    - Boundary (a stale registry answers instead of refusing): a resync in flight → the tool answers with
      `registry.status: "stale"` while every gated tool refuses under R11, so the agent learns to retry
      rather than to conclude that channels vanished. `incomplete` and `unavailable` behave the same, and so
      does a registry that holds no Guild row yet — O11's resolution (Implementation resolutions,
      2026-11-12) reports that case as `guild: { name: null, id: null }`.
    - Boundary (an honest zero): `visibleAndMirroredChannelCount: 0` is a valid answer, and by R3 it never
      says which axis emptied the intersection — a person who may view nothing and a bot invited to nothing
      are the same zero, and the tool never explains which one applied.
    - Error: a technical failure reading either consumed contract — the status read, or the two evaluation
      contracts a count is computed from — is `internal_error` with no partial object. A failing status read
      is `internal_error` here too rather than `state_unavailable`: R11's tools may degrade to "not current"
      because refusal is their safe answer, while this tool cannot report a status it failed to read. An
      unsupported argument field is `invalid_input` (R1's closed object) with zero reads.
    - History: the tool is new in this amendment. R11's example was corrected in the same edit from "all six
      tools" to "the six gated tools", because the exempt seventh tool would otherwise make it false.

## Contracts and boundaries

- **Exposed transport: MCP over Streamable HTTP only.** This feature provides exactly the seven tools of
  R7, R14 and R17 and no REST endpoint, no OpenAPI document and no auxiliary route
  ([ADR 0004](../adr/0004-mcp-primary-transport.md), which defers the tool-documentation approach to
  this specification — closed here): this specification is the normative human-readable contract for
  each tool, and the machine-readable MCP artifacts (the `tools/list` entries and each tool's input and
  output JSON Schema) are produced at implementation and must match this specification field by field.
  They are generated from the same declared schema module the adapter validates with, so a drift between
  prose and schema is a reviewable defect in one place, not two independent documents. No OpenAPI
  document describes the MCP surface, and consumers rely on MCP discovery (`tools/list`) plus these
  schemas. (Superseded by this amendment: this bullet said "exactly the six tools of R7 and R14"; R17
  adds the seventh tool.)
- **Tool list and per-tool contract.** Shared envelope for every successful tool result: `{ data: [...],
pagination: {...} }` for the five listing tools, `{ data: [...], anchorMessageId? }` for
  `get_message_context`; `search_messages` adds `retrieval`. The digest of R14 uses a third documented
  envelope — `{ data: activityGroup[], window: { since, anchor } }` with per-group pagination — because a
  grouped response has no single page and therefore no single cursor. R17's `get_hub_status` uses a fourth:
  the status object itself, with no `data` array and no pagination, because a single status is neither a
  page nor a group. Shared message result (provenance in
  every tool, field names camelCase, snowflake ids as strings because they exceed the safe-integer range
  — [persistence guide](../architecture/persistence.md)):

    ```text
    message result
      messageId        string   Discord message id (snowflake)
      guildId          string   the Installation's Guild id
      channelId        string   channel or thread holding the message
      channelName      string   from guild-state's registry (provenance only, never authorization)
      parentChannelId  string | null   set when channelId is a thread
      authorId         string   Discord User id of the author
      authorDisplayName string | null  only when the stored message row carries one (ingestion R4)
      createdAt        string   ISO 8601 instant from Discord
      editedAt         string | null
      messageType      string   as stored by ingestion (no filtering by type)
      replyToMessageId string | null
      content          string   bounded and explicitly truncatable (R10)
      contentLength    integer  stored length of content, so truncation is measurable
      truncated        boolean  true only when the cap of R10 applied
      attachments      array of { attachmentId, filename, contentType, sizeBytes, url }  (metadata only)
    ```

    Per tool:

    ```text
    search_messages
      input   { query: string(1..1000), channelId?: string, authorId?: string,
                from?: instant, to?: instant, pageSize?: integer(1..100, default 20), cursor?: string }
              closed object; no User identity field of any kind (R1)
      output  { data: message[],
                pagination: { pageSize: integer, hasNext: boolean, nextCursor: string | null },
                retrieval: "hybrid" | "full-text-only" }
      order   fused rank descending, messageId ascending tie-breaker
    list_channels
      input   { pageSize?: integer(1..100, default 20), cursor?: string }
              entries = Requester-visible ∧ bot-viewable (R12); no readability/ingested field
      output  { data: { channelId, name, kind: "channel" | "thread", parentChannelId: string | null,
                        position: integer }[],
                pagination: { pageSize, hasNext, nextCursor } }
      order   position ascending, channelId ascending
    get_channel_history
      input   { channelId: string, from?: instant, to?: instant,
                pageSize?: integer(1..100, default 20), cursor?: string }
      output  { data: message[], pagination: { pageSize, hasNext, nextCursor } }
      order   createdAt descending, messageId descending (R13; cursor walks backward)
    get_thread_messages
      input   { threadId: string, pageSize?: integer(1..100, default 20), cursor?: string }
      output  { data: message[], pagination: { pageSize, hasNext, nextCursor } }
      order   createdAt descending, messageId descending (R13; cursor walks backward)
    get_message_context
      input   { messageId: string, windowSize?: integer(1..100, default 20) }
      output  { data: message[], anchorMessageId?: string }   (no cursor: R4)
      order   createdAt ascending, messageId ascending
    get_recent_activity
      input   { channelId?: string, since?: instant,
                sinceByMyLastMessage?: boolean,
                pageSize?: integer(1..100, default 20, per group), cursor?: string }
              closed object; one window per call
              (since XOR sinceByMyLastMessage; neither → last 24h); channel-scoped per O4's resolution
      output  { data: { channelId, channelName, parentChannelId,
                        messageCount: integer, returnedCount: integer, messages: message[],
                        pagination: { pageSize, hasNext, nextCursor } }[],
                window: { since: instant | null,
                          anchor: "since" | "my-last-message" | "default-24h" } }
      order   groups by newest returned message descending, channelId ascending;
              messages inside a group recent-first, same cursor as get_channel_history (R14)
    get_hub_status
      input   {}   (closed object with no members at all: no identity, no filter, no page — R1)
      output  { guild: { name: string | null, id: string | null },          (O11 resolved: both null while
                                                                             the registry holds no Guild row)
                registry: { status: "current" | "incomplete" | "stale" | "unavailable" },
                mirror: { visibleAndMirroredChannelCount: integer | null } }  (O12 resolved: null, never 0,
                                                                             while the status is not current)
              no data array and no pagination: one status, not a page (R17)
              the count is exactly what paging list_channels would enumerate (R12); the object carries no
              channel id, no channel name and no count of containers the caller cannot enumerate (R3)
      gate    not gated by R11: it reports a non-current registry status instead of refusing (R17)
    ```

- **Required tool descriptions (normative text, R15).** Each description is the published `description`
  of its `tools/list` entry; an implementation may not drop a clause without an owner decision. The
  mirror-scope sentences of `list_channels` and `get_hub_status` are required text in every locale variant
  (R15), not examples.

    ```text
    search_messages
      Find messages by topic across the channels this person can read and the hub actually mirrors.
      Best match first. Use it to locate a discussion, then get_message_context to read around a hit.
      Read only.
    list_channels
      List the channels and threads this person can read AND the hub actually mirrors. Only channels
      from this list can return messages; a channel that is missing is missing for a reason this tool
      will not reveal. A short list is this hub's mirror scope, not a pagination defect — get_hub_status
      reports how many entries that is. Read only.
    get_channel_history
      Read one channel or thread newest first, paging back in time with the cursor. Pass from/to for an
      explicit range. Read only.
    get_thread_messages
      Read one thread newest first, paging back in time with the cursor. Read only.
    get_message_context
      Read a bounded window of messages around one message, oldest to newest. Read only.
    get_recent_activity
      Get what is new in one call: recent messages grouped by channel, with per-channel counts and
      cursors. Defaults to the last 24 hours, or starts after this person's own last message.
      If the person named neither a channel/category nor a time window, ask them before calling.
      Read only.
    get_hub_status
      Report this hub's status in one call: the Guild it serves, whether its registry state is current,
      and how many channels and threads the hub mirrors for this person. A short list_channels page is
      the mirror scope, not a pagination defect. Read only.
    ```

    (Superseded by this amendment: `list_channels` and `get_hub_status` gained the mirror-scope text, and
    `get_hub_status` gained an entry. The five other descriptions keep every clause they had.)

- **Tool result errors (stable codes, part of the contract).** `invalid_input` (rejected request or
  arguments: unknown field, malformed id or instant, out-of-bound `pageSize`/`windowSize`, tampered or
  misfiled cursor, mutually exclusive window or scope arguments of R14, empty query while O2 was open),
  `state_unavailable` (registry not current or its status unreadable; retryable, R11), `internal_error`
  (evaluation, retrieval or persistence technical
  failure; zero rows). Authentication and session failures are the authorization feature's surface and
  the transport's, not a tool error code. There is deliberately **no** forbidden/permission code: an
  object-level denial is an empty result (R3). Codes are stable once published
  ([feature patterns](../architecture/features.md)).
- **Identity seam consumed from the authorization feature.** Per invocation the authorization feature
  supplies the resolved Discord User id of the Requesting User, together with its validity facts (the
  session is authenticated and current). This feature resolves no identity itself, parses no token, and
  imports no type that could carry a request or session token into a use case; the composition root
  passes the resolved identity into the use case input. This specification states the seam because
  [ADR 0006](../adr/0006-discord-sso-dynamic-client-registration.md) leaves session format and lifetime
  to the authorization feature specification; if that specification shapes the seam differently, this
  section is the part to align, and the rules R1–R3 do not change.
- **Permission, status and identity contracts consumed from guild-state**
  ([guild-state](guild-state.md) Contracts): `EvaluateEffectivePermissionsQuery` for the Requester's
  bitfield on a channel or thread, `GetGuildStateStatusQuery` for the R11 gate, and the registry's
  channel/thread identity — ids, names, kind, parent, position — used for `list_channels` and for
  result provenance, plus the Guild name for R8. Two shape requirements are recorded here because this
  feature depends on them: the evaluation is consumed over a bounded channel/thread id set per request
  (never as a per-channel round-trip loop, and never by reading guild-state's tables), and the Guild
  identity is consumed alongside the status read. guild-state owns those contract statements; this
  feature owns only their consumption, and importing a guild-state repository, table or SQL is
  forbidden ([structure](../architecture/structure.md)).
- **Bot-access contract consumed from guild-state.** `ListIngestibleChannelsQuery` — the registry
  contract ingestion enumerates from, stated in [guild-state](guild-state.md) Contracts as "registered,
  non-deleted, text-capable channels and threads the bot itself can view" — is consumed by R12 and R14 to
  build the intersection, with the bot's User id supplied by the composition root from validated
  configuration. Its result keeps the two absences apart (`botCannotViewChannelIds` versus the channels it
  lists), which is what lets this feature answer "not mirrored" without confirming existence to the
  client (R3) and log the distinction server-side only. This feature adds no second bot-visibility rule and
  reads no registry table to obtain it.
- **Brand contract consumed from shared configuration.** The product name in R15's instruction text and in
  the R8 server metadata is the configured `HUB_BRAND_NAME`, not a hardcoded string.
- **Retrieval contract consumed from semantic-index** ([semantic-index](semantic-index.md) R7): hybrid
  candidate retrieval for one query text plus the caller's filter set, with permission filtering applied
  before fusion, and with each result carrying channel/thread and timestamp provenance. The contract
  owns over-fetch and fusion; this feature owns the tool-level filters, ordering exposure, bounds and
  pagination. Neither this feature nor its tests import the embedding table, pgvector operators or the
  provider.
- **Read repository contracts owned here, over the message tables.** Seven intent-named queries, one per
  tool — `SearchMessagesQuery`, `ListChannelsQuery`, `GetChannelHistoryQuery`,
  `GetThreadMessagesQuery`, `GetMessageContextQuery`, `GetRecentActivityQuery`, `GetHubStatusQuery` — each
  with `execute(input)` and camelCase application inputs; `GetHubStatusQuery` composes the consumed
  contracts (status, both evaluation axes) and owns no repository. `ListChannelsQuery` answers
  from guild-state's registry identity
  contract and the ingestible contract with no message read (R12); `GetRecentActivityQuery` composes the
  intersection with one grouped window count over the scope set plus one partitioned page read, never a
  per-container loop (R14); the others read the ingestion-owned message tables through this feature's own
  repositories, while every write on those tables stays ingestion's: read a channel/thread message page
  by keyset; read a message window around an anchor; read message rows by id set for a given candidate
  page; and the provenance lookups a page needs. Every operation takes the accessible channel/thread id
  set as a mandatory parameter, includes the tombstone and deleted-channel exclusion (R6), selects
  explicit columns (never `SELECT *`), uses `LIMIT pageSize + 1`, and defines its ordering with a unique
  tie-breaker ([persistence guide](../architecture/persistence.md)). No operation is unbounded and none
  performs a per-row or per-container query loop. Write methods do not exist in these contracts (R9).
- **Composition wiring.** The authorization feature authenticates the MCP request and mounts the
  transport; this feature supplies the tool handlers and the resolution behind them. The MCP transport
  adapter is thin: it validates the protocol envelope, maps the tool arguments onto the use case input,
  maps results and named application errors onto tool results, and contains no SQL and no business rule
  ([ADR 0001](../adr/0001-layer-ownership.md)). The feature module wires the seven queries, their
  repositories and the consumed contracts through explicit tokens and factories; no feature imports
  another feature's module, controller or adapter, and instances are resolved in the application
  composition module ([shared guide](../architecture/shared.md)).
- **Transactions and consistency.** Every tool is read-only, so no tool opens a write transaction. A page
  read is a single statement (or one consistent read where provenance and page must agree); the guard
  from guild-state R13 applies unchanged — no transaction is held open across an external call, and the
  query-time embedding performed for `search_messages` happens inside the retrieval contract's own
  boundaries, never inside one of this feature's transactions.
- **Retry/idempotency.** Reads are idempotent by construction: repeating a call has no side effect and
  returns the same result unless Discord-originated state changed in between. `state_unavailable` is
  retryable by the client; `invalid_input` is not. This feature retries nothing on the client's behalf
  except inside the consumed contracts.
- **Compatibility and versioning.** Additive-only tool evolution ([project context](../project-context.md)):
  adding an optional input field, a result field or a new tool is compatible — which is how
  `get_recent_activity` and its optional parameters enter the surface — and clients must tolerate
  unknown result fields. Renaming or removing a tool, an input field or an error code, changing an
  ordering key, or adding a required input is breaking and needs an explicit owner decision plus the
  `/v1` namespace the project context defines — not a passing rename. Bounds (`pageSize` 1..100,
  `windowSize` 1..100, `query` 1..1000 characters) are contract values; widening them is additive,
  narrowing them is breaking for clients that rely on them. Two 2026-11-12 changes are owner-decided but
  observable: R12 narrows the `list_channels` entry set and R13 flips the default traversal direction;
  the delivery vehicle for both (in place versus `/v1`) is O6, deliberately not assumed here.

## Implementation and proof

- Minimal affected paths: `src/features/query/` — `query.module.ts` (composition and tool-handler
  wiring), `queries/` (the use cases and their input types, plus `get-recent-activity.query.ts` for R14,
  `get-hub-status.query.ts` for R17 and the instruction composition of R15 alongside
  `get-server-metadata.query.ts`), the MCP tool adapter in a
  transport-adapter folder named for its transport (the structure map's `controllers/` is described as
  REST adapters, and ADR 0004 removes REST from this feature), `models/domain/` (application result
  types such as the message result, page metadata and the activity group), `models/dtos/` (the tool
  input/output schemas that are also the published MCP JSON Schemas, including R15's description text),
  `models/mappers/` (argument → input, domain → tool result), `repositories/` (contract plus `postgres-`
  implementation, including R14's grouped count and partitioned page read), and `index.ts` as the
  intentional surface. No commands, no write repositories, no migrations of this feature's own, no gateway
  to Discord, no HTTP controller. Wired in the application module beside the authorization transport that
  mounts it. R16's header lives in the authorization feature's guard; only its verification is here.
- Tests per rule, against an isolated real PostgreSQL database with ACL fixtures
  ([testing guide](../architecture/testing.md)) — guild-state, semantic-index and the authorization seam
  behind their contracts as test doubles where appropriate, and the message tables plus this feature's
  read repositories real, because SQL correctness and the tombstone predicate are exactly what a mock
  cannot prove:
    - R1: `identity-from-session` — the same tool call under two sessions with different permissions
      returns each session's own result set; a call carrying `discord_user_id`/`userId` returns
      `invalid_input` with zero repository calls recorded (negative test); the tool schemas are closed
      objects and expose no identity field (structural).
    - R2: `acl-content-vs-visibility` — a fixture User holding `VIEW_CHANNEL` without
      `READ_MESSAGE_HISTORY` is listed in `list_channels` and gets an empty history page; a User holding
      neither sees neither; `ADMINISTRATOR` and thread-with-parent cases are exercised through the
      evaluation double, not re-derived here; an evaluation throw yields `internal_error`, never an empty
      page.
    - R3: `acl-no-existence-signal` — for each tool, a channel/thread/message the Requester cannot access
      and a fabricated id produce identical results (deep-equal payload, error flag and message text);
      `acl-before-fusion` — a semantic-index double returns candidates from an inaccessible channel and
      none of them appear, before and after fusion (invariants I2, I4); logs/counters record the filtered
      ids while the client payload contains none.
    - R4: `pagination-keyset-stability` — page through a channel while inserting newer messages between
      pages: no repeated row, no skipped row, page sizes obey the bound, `hasNext` and the one-row probe
      are correct; `pagination-cursor-binding` — a cursor presented to another tool, or with different
      filters/query text, is `invalid_input`; a tampered cursor is `invalid_input` with zero reads;
      `search-pagination` documents and asserts the re-ranking boundary (ordering key and page bound hold;
      skips/repeats under concurrent writes do not violate the ACL).
    - R5: `search-hybrid-degradation` — the retrieval double fails on query embedding → results come from
      the FTS branch with `retrieval: "full-text-only"`; a stored-but-unembedded message is found (FTS
      reachability); a retrieval technical error is `internal_error` with zero rows.
    - R6: `tombstone-never-returned` — parameterized over all seven tools and over every read repository
      operation: a tombstoned message, a message whose channel was deleted and a thread message whose
      parent was deleted are absent, including as the `get_message_context` anchor and inside its window.
    - R7: one contract test per tool covering required/optional fields, default `pageSize`/`windowSize`,
      ordering assertion per key, provenance completeness, filter allowlist rejection of unknown fields,
      and the mutual-exclusion-free `channelId`-accepts-a-thread-id behavior of T1.
    - R8: `metadata-identifies-guild` — two fixtures yield server metadata naming each Guild; the
      `incomplete`/`unavailable` status produces the unidentified-Guild wording with a successful
      connection; a Guild rename appears on the next connection.
    - R9: structural test — this feature's public surface exposes no command, its repositories expose no
      write method, no embedding provider or Discord gateway dependency is importable from it, and calling
      every tool twice leaves a row-count-and-hash snapshot of the message, registry and embedding tables
      unchanged.
    - R10: `payload-bounds` — an oversized message returns `truncated: true` with `contentLength`;
      a page whose serialized size exceeds the cap returns fewer rows with `hasNext: true` and a usable
      `nextCursor`; no field is dropped silently; attachment bytes are never read (structural).
    - R11: `registry-not-current-refusal` — for `stale`, `incomplete`, `unavailable` and an unreadable
      status, every gated tool returns `state_unavailable` with zero rows and no repository read; after the
      status returns to current they serve the same fixtures normally. The digest (R14) is included in the
      every-tool sweeps of R2, R3, R6 and R11 rather than given a private copy of them; R17's
      `get_hub_status` is excluded from the R11 sweep because it is the one tool that reports a non-current
      status instead of refusing, and every other sweep states explicitly whether it includes it.
    - R12: `list-channels-ingestible-only` — a channel the Requester can view whose bot-access evaluation
      says the bot cannot view it is absent; a channel the bot can view that the Requester cannot is
      absent; the two absent entries produce deep-equal payloads (no flag, count or ordering difference);
      a bot-viewable channel with zero stored messages is listed; a category or voice entry the Requester
      can view is absent; a failure of either axis is `internal_error` with zero rows; `(position,
channelId)` ordering and R4 pagination over the intersection are unchanged.
    - R13: `history-newest-first-default` — with no `from`, no `to` and no cursor, both history tools return
      the newest messages of the container first, asserted on the returned order and on the keyset key
      carried by `nextCursor`; `history-backward-pagination` — page through a container: each page is
      strictly older than the previous one, no row repeats or is skipped under concurrent inserts, and the
      final page reports `hasNext: false` with `nextCursor: null`; `history-from-to-still-respected` — an
      explicit `from`/`to` range returns only rows inside it, starting from the `to` end, and an empty range
      is a valid empty page; the thread tool gets the same two assertions. The previous ascending
      assertions in the existing R4/R7 tests are the only ones intentionally changed, and they are updated
      in the same commit as the rule.
    - R14: `activity-default-24h-window` (no window argument → `window.anchor: "default-24h"` and only the
      last 24 hours by the injected clock), `activity-since-window` (explicit `since`, inclusive),
      `activity-my-last-message-anchor` (scoped: the Requester's newest message in that container; guild
      wide: the maximum across the mirrored set; the anchor message itself is included),
      `activity-intersection-filtering` (a channel the Requester cannot read, and one the bot cannot view,
      never appear, not even as an empty group), `activity-grouped-shape` (`messageCount` versus
      `returnedCount`, per-group `hasNext`/`nextCursor` continuing one group exactly like history, group
      ordering, statement count independent of group count, and the R10 byte-cap shortening of a group to
      `messages: []` with counts and a usable cursor), and the argument conflicts (`since` with
      `sinceByMyLastMessage`, `channelId` with `categoryId`) as `invalid_input` with zero reads.
    - R15: `instructions-teach-agent` — the `initialize` result's `instructions` contains the configured
      brand, the Guild name from the registry, the human-completes-the-Discord-login sentence, the
      ask-when-ambiguous sentence and the recent-first history guidance, contains no user id, no channel id
      and no message content, and uses R8's unidentified-Guild wording while the registry is not current
      without failing the connection; the seven published descriptions equal the required text of Contracts.
      R15's mirror-scope block is asserted by `instructions-flag-short-list`: in each configured locale the
      `instructions` state that the hub mirrors only part of the Guild, that `list_channels` lists a subset
      on purpose and that a short list is not a pagination defect, and name `get_hub_status` as the call
      that reports the mirror scope; the `list_channels` description carries the same fact.
    - R16: `unauthenticated-resource-metadata` — a `/mcp` request with no, malformed or expired credential
      returns `401`, `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_BASE_URL>/.well-known/oauth-protected-resource"`,
      no tool result and no repository read; the metadata document is readable without a credential and
      names the authorization server. A pass in the owning feature's own test does not replace this one,
      which asserts the product surface an agent meets.
    - R17: `hub-status-reports-mirror-scope` — with a fixture Guild, a Requester and a bot whose intersection
      is exactly 2 containers, `get_hub_status {}` returns the Guild identity, `registry.status: "current"`
      and `visibleAndMirroredChannelCount: 2`, and 2 equals the number of entries paging `list_channels`
      returns; a `stale`/`incomplete`/`unavailable` registry answers with that status and zero reads of
      either axis instead of `state_unavailable`; an unreadable status and a failure of either axis are
      `internal_error`; an argument field is `invalid_input` with zero reads.
      `hub-status-never-leaks-identities` — a serialized scan of the result contains no channel id, no
      channel name, no parent id, no message id, no message content and no count of containers outside the
      intersection; it holds for a Requester who can see nothing and for a bot invited to nothing (both
      answer `0`, indistinguishable by R3), and the three sweeps of R2, R3 and R6 declare it inside or
      outside their scope rather than silently skipping it.
- Named security tests required by the owner rules and ADRs, kept as explicit test names:
  `impersonation-argument-rejected` (R1), `acl-no-existence-signal` (R3),
  `acl-before-fusion` (R2/R3, invariants I2/I4), `tombstone-never-returned` (R6),
  `pagination-keyset-stability` (R4), `registry-not-current-refusal` (R11), plus the agent-facing set added
  2026-11-12: `list-channels-ingestible-only` (R12), `history-newest-first-default` (R13),
  `activity-my-last-message-anchor` (R14), `instructions-teach-agent` (R15),
  `unauthenticated-resource-metadata` (R16), plus the client-resilience set added with R17:
  `instructions-flag-short-list` (R15's mirror-scope block), `hub-status-reports-mirror-scope` (R17) and
  `hub-status-never-leaks-identities` (R17).
- Safe isolated database setup: a dedicated PostgreSQL test database/schema with an explicitly supplied
  test connection, isolation confirmed before setup or cleanup; missing database access or missing
  pgvector is reported as unavailable evidence, never passed, and no shared or production data is
  truncated ([testing guide](../architecture/testing.md)). Fixtures create their own Guild, channels,
  threads, messages, tombstones and permission rows, and are removed by the test that created them.
- Actual verification commands: none exist yet; recorded in
  [project context](../project-context.md) when implementation is authorized.
- Documentation updates at implementation: the project-context feature section and v1 tool surface,
  `CONTENTS.md`, the published MCP tool schemas, the short "agent versus human onboarding" paragraph near
  the existing connect-a-client section of [installation](../installation.md) (R15/R16), and the sibling
  cross-references if a consumed contract name changes (guild-state's evaluation/status/identity/ingestible
  shape, semantic-index's retrieval contract).

## Decisions (2026-11-04)

- Tool set: exactly the five v1 tools of the project context — `search_messages`, `list_channels`,
  `get_channel_history`, `get_thread_messages`, `get_message_context` — retrieval only, no reasoning and
  no summarization.
- Contract documentation approach (closing the question
  [ADR 0004](../adr/0004-mcp-primary-transport.md) defers to the first feature specification): this
  specification is the normative per-tool contract, and implementation produces the machine-readable MCP
  tool list and JSON Schemas from one declared schema module that must match it. No OpenAPI document for
  the MCP surface.
- Identity: the Requesting User comes from the authenticated session only; no tool input carries
  identity and a caller-supplied user id is rejected as invalid input (R1) — the owner's impersonation
  requirement.
- Permission gate map: `VIEW_CHANNEL` for visibility (`list_channels`), `VIEW_CHANNEL` +
  `READ_MESSAGE_HISTORY` for content reads, one mapping shared by all four content tools (R2).
- No existence leaks: object-level denial is an empty result with not-found semantics, never a forbidden
  error; a permission error code does not exist in the surface (R3).
- Pagination: cursor/keyset for the four listing tools, `pageSize` 1..100 default 20, one format across
  tools, self-describing cursors, no server-side traversal state; documented as the exception to the
  [REST collection baseline](../architecture/rest.md) because message streams and fused rankings have no
  stable page number (R4).
- Message listing order is ascending by `(createdAt, messageId)`; newest-first presentation is the MCP
  client's concern.
- `search_messages` filters by a single `channelId` that accepts a channel or thread id; a separate
  `threadId` filter is not offered because threads are channels in the registry (guild-state R6).
- Search goes through semantic-index's hybrid contract; a query-embedding failure degrades to the
  full-text branch with an explicit `retrieval: "full-text-only"` marker, because unembedded messages
  must stay reachable (ADR 0008 decision 7).
- Read repository ownership: this feature owns read repositories over the ingestion-owned message tables;
  ingestion keeps every write, and Guild/channel/thread names for `list_channels` and provenance come
  from guild-state's contracts rather than from this feature reading registry tables.
- Read-only surface: no tool mutates, no Discord call, no persisted traversal state (R9).
- Server metadata names the Guild read from guild-state at connection time, so multi-Installation clients
  can distinguish and ask (R8).
- Registry status gating: `stale`/`incomplete`/`unavailable` refuse every tool with `state_unavailable`,
  mirroring the authorization feature's policy rather than defining a second one (R11).

## Implementation resolutions (2026-11-06)

Coordinator approval under the owner's standing directives, subject to owner veto at lane verification:

- O1: validated `QUERY_MAX_MESSAGE_CHARS` default 4000 Unicode characters and
  `QUERY_MAX_RESPONSE_BYTES` default 262144 bytes; head-only truncation with `truncated` and stored
  `contentLength`. No imported-message length distribution was available; these are explicit approved
  defaults, not measured distribution evidence. Oversized listing pages shorten with a valid cursor;
  context windows retain the anchor, shorten from the farthest edge and expose `windowTruncated: true`.
  An irreducible single entry whose intact metadata cannot fit returns atomic `internal_error`.
- O2: query text remains required and nonempty; no filter-only search.
- O3: the declared schema module publishes readOnlyHint=true, destructiveHint=false,
  idempotentHint=true and openWorldHint=false. The hints and `outputSchema`/`structuredContent`
  were checked against the [MCP 2025-06-18 tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
  and its versioned schema. Results use structuredContent with a fixed text acknowledgement (rather
  than duplicating the serialized payload), retaining room for protocol framing inside the byte cap.
- Thread pages additionally carry `threadId` and `parentChannelId` only when nonempty; an empty page
  never acknowledges an inaccessible/unknown container. Message provenance uses channelId plus parentChannelId.
- The authorization principal seam is `{ userId: string, sessionId: string, expiresAt: Date }`, supplied
  per invocation by McpAuthenticationGuard, which establishes session authentication and currency;
  no authorization implementation is imported by this lane.
- Registry accessible entries are additively extended with `name` and `position` by the coordinator;
  that live evaluated set is also the deleted-container exclusion source. The batched accessible-list
  query uses guild-state's effective evaluation over one snapshot; no per-channel evaluation loop is added.

See [verification and composition](query-verification.md) for concrete evidence and merge seams.

## Original open-decision record (resolved above)

- **O1 — Payload cap and truncation policy.** Question: what are the per-message `content` cap and the
  per-response size cap (bytes or characters), and what is the truncation shape — head-only with a
  marker, or head and tail — given that v1 has no tool that returns the untruncated content?
  Consequence: truncation is irreversible, so a tight cap silently degrades the product's only reading
  surface on long Discord messages while a loose cap defeats R10's bound; the answer also decides
  whether the values are fixed contract or validated configuration. Owner: Project owner. Resolution
  trigger: before implementing R10, with the observed length distribution of real messages from a first
  import; implementation evidence about long-message frequency is recorded with the decision.
- **O2 — `search_messages` with no query text (filter-only browse).** Question: does an empty or omitted
  `query` with only filters run as a filter-only browse, or is it rejected as `invalid_input` as specified
  in T1? Consequence: accepting it turns search into a second filtered browsing surface whose ordering is
  no longer a fused rank (it would inherit R4's key ordering and `(createdAt, messageId)` order) and it
  must keep every permission and tombstone guarantee; rejecting it keeps one ordering model but forces
  clients to page channel history per channel to browse. Owner: Project owner. Resolution trigger: before
  implementing T1's input validation, once a client prototype shows whether browsing without text is
  actually needed.
- **O3 — Tool annotations and description wording.** Question: which MCP annotation hints each tool
  declares (read-only, destructive, idempotent, open-world) and what description text each tool exposes,
  given that the whole surface is read-only (R9) but clients use annotations to decide auto-approval?
  Consequence: annotations and descriptions are client-facing behavior, and a wrong hint changes a
  client's trust decisions; descriptions are also where the project context requires deprecations to be
  documented. Tool names are not open — the v1 surface fixes them. Owner: Project owner. Resolution
  trigger: at implementation, once the annotation set of the MCP protocol revision the hub targets is
  confirmed from the specification rather than assumed.

## Decisions (2026-11-12) — agent-facing behavior of the MCP surface

Recorded after the owner's 2026-11-12 brief ("tenemos que trabajar sobre el mcp y como se comporta…"),
which asked three questions — how an agent can be taught to configure itself, why the listing and novelty
behavior ignores the bot's own access, and why a first reading starts at the beginning of the server — and
answered them with four decisions. Each is quoted verbatim in its rule.

- **D1 → R12, `list_channels` scope.** The tool lists the intersection of "what the Requester can view" and
  "what the bot can access", so a channel the hub does not mirror never appears: "ahora mismo el bot como
  POC solo tiene acceso a un canal, pero debería de devolverte TODO lo que un usuario puede ver Y el bot
  está en el canal. En un futuro el bot estará en todos los canales y el usuario solo debería de ver solo
  lo del user". No readability or `ingested` flag is added; guild-state's existing ingestible-channels
  query is reused rather than a second bot-visibility rule being invented.
- **D2 → R13, default ordering.** "Recientes primero": an unanchored history call returns the most recent
  messages and the cursor walks backward; `from`/`to` stay inclusive bounds and are still respected. The
  same default applies to `get_thread_messages` while its parameter surface stays unchanged, and
  `get_message_context` and `search_messages` are untouched.
- **D3 → R14 + R15, novelty digest and the ambiguity contract.** A new single-call tool
  `get_recent_activity` returns messages grouped by channel with per-channel counts and per-channel
  backward cursors, scoped by channel (and, pending O4, by category), windowed by `since` or by the
  person's own last message, defaulting to 24 hours. The "ask when the request names neither a channel nor
  a window" rule is instruction text, not tool behavior: "Si la pregunta es ambigua, se debe de responder,
  si no se especifica el canal o la categoría ni ventana de tiempo que se pregunte". The hub keeps no
  per-user read state; user scoping comes from permissions automatically.
- **D4 → R15 + R16, self-configuration at connect time.** The `initialize` instructions and the six tool
  descriptions teach the agent the Guild identity, the human-completed Discord login, the novelty flow and
  the recent-first history, and the unauthenticated `/mcp` response advertises the protected-resource
  metadata so discovery needs no operator help — the answer to "10 minutos estuvo dandóle vueltas".
- **D5 → R15 + R17, mirror scope and hub status.** "lo que quiero mejorar es esto" (owner, verbatim, over
  a session in which a client compared 2 `list_channels` entries with an older 129 and concluded "algo
  falla en la paginación"). The surface must therefore say, in the connect-time text and in the
  `list_channels` description, that the hub mirrors only part of the Guild and that a short list is not a
  pagination defect (R15's mirror-scope block), and one tool must answer "is this hub healthy, and is 2
  the truth?" with the Guild identity, the registry status and the count of containers the caller could
  already enumerate (R17's `get_hub_status`). Recorded in `odd/tasks/mcp-client-resilience.md` as decisions
  "2 · Texto anti-falso-positivo" and "3 · Tool de estado" (L2).

## Open decisions (2026-11-12) — continuing the O-numbering above

- **O4 — Category scope: what the registry actually guarantees.** Question: may `get_recent_activity`
  accept `categoryId` and resolve it as "the scoped containers whose registry `parentChannelId` is that
  category"? The registry does store the linkage — `channel.parent_channel_id` is written from Discord's
  `parent_id` for every channel, `RegistryChannel.parentChannelId` documents it as "a category parent when
  Discord named one (R6, R7)", and `guild-category` is a stored channel type — but no public contract
  exposes a distinct `categoryId` field, so a consumer derives it from a non-thread entry's
  `parentChannelId`, and it is unresolved whether every non-thread parent is in fact a category, how a
  deleted or unregistered category row should behave, and whether a `categoryId` the Requester cannot view
  must be a valid empty digest (as R3 requires) or is simply unsupported. Consequence: guessing here turns
  a scope filter into a permission-adjacent surface with a green test on an assumed mapping; rejecting it
  keeps the digest channel-scoped and forces the agent to resolve categories from `list_channels`.
  Preferred fallback if the evidence stays thin: omit `categoryId` and record the omission in R14.
  Owner: Project owner. Resolution trigger: before implementing R14's category scope, with the registry
  evidence recorded alongside the decision.
- **O5 — Cursor compatibility across the ordering flip.** Question: must a cursor minted under the previous
  ascending contract be rejected as `invalid_input` (by adding an ordering/direction token to the cursor
  binding or bumping its `version`) now that continuation compares with `<` instead of `>`? Consequence:
  the current binding does not include the direction, so a pre-change cursor can silently continue into
  the wrong half of a channel — a wrong answer rather than an error. The rule as written only fixes the
  semantics for cursors minted under this contract and the tests only mint within it. Owner: Project
  owner. Resolution trigger: before implementing R13, and in the same commit that changes the comparison.
- **O6 — Delivery vehicle for the two observable narrowing changes.** Question: do R12's entry-set
  narrowing and R13's ordering flip ship in place, or under the `/v1` namespace the compatibility rule
  requires for breaking changes? Consequence: this is self-hosted and Installation-local, so an in-place
  change reaches few clients — but it is exactly the "changing an ordering key" case that rule names, and
  the owner's D1/D2 approval did not name a vehicle. Owner: Project owner. Resolution trigger: before
  merging either change, at the same gate the compatibility rule already uses.
- **O7 — Anchor mode with no anchor message.** Question: when `sinceByMyLastMessage` is set and the
  Requester has no stored message in the scoped container (or none at all in the mirrored set), should the
  digest return a valid empty response with `window: { since: null, anchor: "my-last-message" }` (as
  specified, and as the fail-explicit reading suggests), fall back to the 24-hour window, or answer with an
  `invalid_input`/refusal the agent can translate into a question? Consequence: an empty answer to "what is
  new since my last message" is correct but surprising for a person who never posted; a silent 24-hour
  fallback answers a question nobody asked. Owner: Project owner. Resolution trigger: before implementing
  R14's anchor mode, once an agent prototype shows how often the case occurs.
- **O8 — Per-group cursor self-sufficiency.** Question: must a group's cursor carry its `channelId` and the
  effective window, so it can be presented without restating them, or stay bound (as specified) to a
  follow-up call that names the same `channelId` and window? Consequence: a bound cursor is simpler and
  inherits R4's "a cursor cannot widen access" property unchanged, but makes one page of a digest a
  two-field continuation for the agent, which is exactly the kind of friction R15 is trying to remove.
  Owner: Project owner. Resolution trigger: before implementing R14's cursor, together with O5's
  representation question.
- **O9 — Expressing "everything" in `get_recent_activity`.** Question: the owner's example "hace un
  resumen de todo" names an unbounded digest, but R14's window is always bounded below (`since`, an
  anchor, or the 24-hour default). How should "everything" be expressed — a `since` lower bound at the
  platform epoch (or the earliest mirrored instant) taught in R15, or an explicit sentinel (`allTime`)?
  Consequence: a sentinel adds contract surface for a request shape that `since` already expresses;
  epoch-style `since` works today, but no text currently tells an agent that "everything" maps to it.
  Owner: Project owner. Resolution trigger: before implementing R14's window, with the R15 example
  text. Preferred fallback if left unresolved: no new parameter — R15's novelty block teaches that
  "everything" is `since` at the epoch boundary, which the window semantics already support.
- **O10 — Language of the R15 onboarding text and tool descriptions.** Question: are the connect-time
  instructions and the six descriptions Spanish, English, or generated in the locale configured by the
  brand/locale configuration of user-visible surfaces (commit 9ca86b5)? The drafted required text in
  Contracts is English; the hub's current server description is Spanish and its audience is
  Spanish-speaking. Consequence: R15 is the agent-facing face of the product; a per-locale composition
  also makes the `instructions-teach-agent` test locale-dependent. Owner: Project owner. Resolution
  trigger: before implementing R15, with the brand/locale configuration scope as evidence. Preferred
  fallback if left unresolved: compose from the configured locale and fall back to English when unset.
- **O11 — `get_hub_status` while the registry holds no Guild row.** Question: what do `guild.name` and
  `guild.id` report while `GetGuildIdentityQuery` answers `not-registered` — a fresh Installation before
  the bootstrap's first write? The declared shape has no nullable member, so the choices are R8's "Guild
  not yet identified" wording in `name` with the configured Guild id in `id`; `null` for both, widening the
  shape; or omitting `guild` and answering with `registry.status` alone, which is `incomplete` or
  `unavailable` in that state. Consequence: the first keeps the shape and reuses wording R15 already
  teaches; the other two are contract changes to a tool this amendment just added, and a client keying on
  `guild.name` would have to tolerate `null` or a missing member. Owner: Project owner. Resolution
  trigger: before implementing R17, with the registry's fresh-installation states as evidence. Preferred
  fallback if the evidence stays thin: R8's unidentified-Guild wording in `name` plus the configured Guild
  id in `id`, which keeps the declared shape and needs no client-side null handling.
- **O12 — The mirror count while the registry is not current.** Question: when `registry.status` is
  `stale`, `incomplete` or `unavailable`, what does `mirror.visibleAndMirroredChannelCount` report — `0`,
  the last count the hub can attest, `null`, or is `mirror` absent from the answer? R11 forbids computing
  anything from state the hub cannot attest, and R17 removes the refusal for this tool because the status
  _is_ the answer, so the representation of the count in that window is a genuine gap. Consequence: a `0`
  would be read as "this hub mirrors nothing", which is exactly the false conclusion the tool exists to
  prevent ("Solo 2 canales — algo falla en la paginación"), while `null` or an absent `mirror` costs a
  widened shape this amendment did not declare. Owner: Project owner. Resolution trigger: before
  implementing R17, examined separately for a resync window (`stale`/`incomplete`) and for a lost Guild
  (`unavailable`). Preferred fallback if left unresolved: `mirror` stays present with
  `visibleAndMirroredChannelCount: null` until the status is current, recorded as the widened shape it is
  rather than a fabricated `0`.

## Implementation resolutions (2026-11-12)

Accepted by the owner at implementation authorization (2026-11-12, choice "Implementar con lo
recomendado"), applying the preferred fallbacks recorded above:

- **O4**: `categoryId` scoping is implemented only if the T3 implementation records registry evidence
  that the parent linkage is a category end to end; otherwise the digest is channel-scoped and the
  `categoryId` input and the per-group `categoryId` output field stay out of the contract.
- **O5**: cursors minted under the previous ascending contract are rejected as `invalid_input`; the
  cursor envelope gains the version/direction discriminator needed so an old cursor fails validation
  instead of silently continuing into the wrong half of a channel (changed in T2's commit).
- **O6**: both observable changes (R12's entry-set narrowing, R13's ordering flip) ship in place, not
  under `/v1`: this is a self-hosted, Installation-local surface with a single known MCP client, and
  the owner's D1/D2 decisions named the behavior without a vehicle. Recorded as the delivery decision.
- **O7**: `sinceByMyLastMessage` with no stored Requester message resolves to a valid empty digest
  with `window: { since: null, anchor: "my-last-message" }` — fail-explicit, as specified; the agent
  translates it, per R15.
- **O8**: group cursors stay bound (tool, group's `channelId`, the window SELECTION the client restates
  via the binding hash); continuation names the same `channelId` and window; the resolved bound of a
  relative window is recomputed per call while the absolute key position preserves no-repeat/no-skip.
- **O9**: no new parameter; R15's novelty block teaches that "everything" is `since` at the epoch
  boundary, which the window semantics already support.
- **O10**: the implementing work inspect the brand/locale configuration for user-visible surfaces
  (commit 9ca86b5); if a per-locale surface exists, R15 composes from it and `instructions-teach-agent`
  asserts against the configured locale; English is the fallback when no locale is set.
- **O11** (recorded by the `mcp-client-resilience` implementation, 2026-11-12): `guild.name` and `guild.id`
  are **`null`** — neither R8's "not yet identified" wording nor the configured Guild id — whenever the
  registry holds no Guild row (`GetGuildIdentityQuery` answers `not-registered`), and likewise while the
  status is `incomplete`/`unavailable`, because the identity is read under R8's rule (current or stale
  only). The declared shape in Contracts is widened to `string | null` accordingly. Rationale: `null` is
  the only answer that claims nothing, while a placeholder string would claim an identity nothing stored —
  the same fail-explicit reading O7 applied to the anchor window. Chosen over the recorded preferred
  fallback (R8's wording plus the configured id) because a client keying on `guild.name` would otherwise
  read a human sentence as the Guild's name, and over omitting `guild`, which costs more client-side
  shape handling than two nullable members.
- **O12** (recorded by the `mcp-client-resilience` implementation, 2026-11-12):
  `mirror.visibleAndMirroredChannelCount` is **`null`** — never `0`, never the last attested count —
  whenever `registry.status` is not `current`, and no channel list is read in that branch at all. `0` would
  be a claim ("this hub mirrors nothing"), which is exactly the false conclusion the tool exists to prevent;
  `null` says "unknown", which is the truth while the registry cannot attest its own state. `mirror` stays
  present so the shape does not vary, and the Contracts block is widened to `integer | null`. The loop is
  closed: the hub has no attested count to report in that window, so nothing is lost by not caching one
  (R11 forbids computing from unverifiable state; this feature caches nothing).
