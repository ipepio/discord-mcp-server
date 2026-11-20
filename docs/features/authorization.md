# Feature specification — Authorization (MCP OAuth 2.1 + Discord SSO)

## Goal and source request

- Owner: Project owner
- Source request (verbatim, acceptance evidence of
  [ADR 0006](../adr/0006-discord-sso-dynamic-client-registration.md)): "La idea es que el cliente mcp,
  si no tiene login, que muestre una url, esta url va contra un oauth que es un SSO con discord en el
  backend." and "se isntala el mcp. pone el dominio [...] se logea con la conf. y si su usuario de
  discord tiene acceso al server dónde apunta, ya está, no?" (sic, verbatim; preserved from the ADR).
- Expected outcome: an `authorization` feature that authenticates MCP clients and issues hub sessions.
  It is the Installation's own OAuth 2.1 authorization server — server metadata discovery, dynamic
  client registration (RFC 7591), authorize and token endpoints, PKCE required
  ([ADR 0006](../adr/0006-discord-sso-dynamic-client-registration.md)). Discord is the upstream
  identity provider: the authorization code is exchanged strictly server-side, the resolved identity is
  gated on a current Membership ([guild-state](guild-state.md)), and the client receives only an opaque
  hub-issued session token — Discord tokens never leave the server. This feature also owns the
  authentication of the MCP Streamable HTTP endpoint ([ADR 0004](../adr/0004-mcp-primary-transport.md)),
  so that no MCP tool executes without a valid session, and exposes the session → [User](../../CONTEXT.md)
  seam the query feature consumes. Glossary terms per [CONTEXT.md](../../CONTEXT.md): an Installation
  serves one Guild; a User authenticates through Discord OAuth2; a Membership decides access; tool
  arguments never do.
- Non-goals:
    - Permission state, effective-permission evaluation, bootstrap and resync policy —
      [guild-state](guild-state.md), which stays the only authority on what an authenticated User may
      read ([ADR 0005](../adr/0005-gateway-synced-permission-state.md)).
    - The Guild protocol: the Gateway connection, its normalized event stream and Guild REST reads —
      [discord](discord.md). This feature owns Discord identity flows only (R1).
    - Message ingestion, retrieval, MCP tool contracts and per-channel result filtering —
      [ingestion](ingestion.md) and the query feature. This feature decides _who_ is calling, never _what_
      the caller may see.
    - Pre-registered clients in operator configuration, static personal access tokens and any
      per-client operator setup ([ADR 0006](../adr/0006-discord-sso-dynamic-client-registration.md)).
    - Storing Discord profile data beyond the Discord User id; role-based hub authorization beyond Guild
      Membership; multi-Guild or multi-Installation login.
    - A client-initiated logout or revocation endpoint (RFC 7009) and an administrative
      session-management UI in v1. (Superseded 2026-11-09: refresh-token machinery was a non-goal here;
      [ADR 0009](../adr/0009-refresh-token-rotation.md) added it, [session-refresh](session-refresh.md)
      specifies it, and R18 below is the part of its response contract this document owns.)
- Owning feature and local instructions: `authorization` (placement per
  [structure](../architecture/structure.md)); a local `AGENTS.md` is added at implementation only if
  feature-specific invariants emerge.
- Relevant accepted ADRs: [0001](../adr/0001-layer-ownership.md),
  [0002](../adr/0002-rest-contracts.md), [0003](../adr/0003-postgresql-without-orm.md),
  [0004](../adr/0004-mcp-primary-transport.md),
  [0005](../adr/0005-gateway-synced-permission-state.md),
  [0006](../adr/0006-discord-sso-dynamic-client-registration.md).

## Prerequisites

- A Discord application owned by the operator for this Installation, whose OAuth2 client id and client
  secret are available as configuration, and where the hub's Discord redirect URI is registered. The bot
  and the OAuth2 application are the same Discord application; the bot token is never a
  [User](../../CONTEXT.md) credential.
- The only Discord OAuth2 scope requested is `identify`, which yields the Discord User id. No `guilds`,
  `bot` or message scope is requested, so the access token obtained during login carries no
  Guild-protocol capability even while it exists (R5).
- [guild-state](guild-state.md) is available with a current registry status and a Membership read (its
  public contract under Contracts and boundaries); the `discord` feature's normalized event stream is
  available for membership-end kinds (R9).
- Validated configuration at startup per the shared/config conventions (no scattered `process.env`
  reads): `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `PUBLIC_BASE_URL`, `SESSION_TTL_SECONDS` (R12).
  Invalid or missing configuration fails startup with an explicit error before any network activity.

## Behavior

"Session" means: a hub-issued opaque bearer credential stored server-side and identified by a
`session id`, bound to one [User](../../CONTEXT.md) of this Installation. "Current" (of the registry)
means: [guild-state](guild-state.md)'s status reports a complete, non-stale registry. "Membership
ended" means: the User's Membership rows are deleted in guild-state (guild-state R4) — leave, kick and
ban are indistinguishable here.

This feature owns its own Discord OAuth gateway contract (authorization-code exchange and current-user
identity fetch over HTTPS). Those are identity flows, not Guild protocol: the [discord](discord.md)
feature owns the Guild protocol — the single connection, normalized events and Guild REST reads — and
this feature never opens a connection, never calls a Guild read and never subscribes to a raw event.
Symmetrically, the `discord` feature owns no part of login, sessions or identity, and the bot token is
never evidence of a [User](../../CONTEXT.md).

Each rule states the rule, then a successful example, a rejected/boundary example, and error behavior
where applicable. Rule numbers are permanent. R14–R16 carry no rule text in this document: the
refresh-token rules that continue after R13 live in [session-refresh](session-refresh.md) under their own
numbering, so this document continues at R17 instead of renumbering anything a test, a task document or a
sibling specification already cites.

- **R1 — One authorization server, one identity source.** This feature is the Installation's
  authorization server and Discord is only the upstream identity provider. Sessions are hub-issued and
  opaque; Discord access and refresh tokens never reach an MCP client, never appear in a response body
  and never appear in a log line (R13). No second authentication path exists: the bot token, an
  operator-supplied static key, or a Discord token presented as a bearer credential never authenticates
  a User.
    - Example: a standard MCP client is pointed at the hub URL only → it discovers the authorization
      server, registers itself, runs the Discord login, and calls tools with a hub-issued token; it holds
      no Discord credential at any point.
    - Boundary: this feature's only Discord network calls are the login-time code exchange and the
      identity fetch (R5). Guild membership, roles and overwrites are read exclusively from
      [guild-state](guild-state.md), never from Discord per request
      ([ADR 0005](../adr/0005-gateway-synced-permission-state.md)).
    - Error: a defect that forwards any upstream credential to the client or to the logs is a security
      defect of this feature, not a tolerated integration shortcut.

- **R2 — Discovery and dynamic client registration.** The feature serves its authorization-server
  metadata (RFC 8414) and a protected-resource metadata document (RFC 9728) naming this hub as the
  authorization server for its own MCP endpoint; both are public, unauthenticated and free of secrets.
  Clients obtain credentials through dynamic client registration (RFC 7591) as public clients
  (`token_endpoint_auth_method: none`), and registered clients are stored in PostgreSQL. No operator
  per-client setup exists.
    - Example: two different MCP clients connect to the same Installation → two registered clients, each
      with its own redirect URI set; both subsequently log in.
    - Boundary: registration identifies the _client_, never the _User_: a registered client that has not
      completed a Discord login holds no access. Metadata documents carry no Discord client secret, no
      internal URL and no client list.
    - Error: registration metadata that is malformed or incomplete (missing `redirect_uris`, unsupported
      grant type, an unknown or non-public client authentication method) is rejected with
      `invalid_client_metadata` and nothing is stored.

- **R3 — Redirect URIs and `state` are exact-matched; no open redirects.** A registered client's
  redirect URI set is stored exactly as submitted, each entry absolute and fragment-free; `http` is
  accepted only for loopback addresses and `https` otherwise. Matching is exact string comparison — no
  wildcards, no sub-domain or path-prefix matching, no "closest registered URI", and no default when
  `redirect_uri` is omitted. An authorize request whose `redirect_uri` is absent or unregistered is
  rejected **without redirecting to that URI**: the error is rendered by the hub. The client-supplied
  `state` is mandatory, opaque to the hub and echoed back byte-exactly; the hub's own Discord leg
  carries a separate single-use `state` bound to one pending authorization request (R4).
    - Example: registered `https://client.example/callback` → that exact URI authorizes;
      `https://client.example/callback/extra`, `https://other.example/callback` and
      `https://client.example/` are all rejected, and none of them produces a redirect to the caller's
      URI.
    - Boundary: a client may register several redirect URIs (native clients use loopback with a dynamic
      port); each authorization request names exactly one and it must be a member of that client's set.
      `state` is never optional, never empty and never re-derived or repaired by the hub.
    - Error: any mismatch is an OAuth error response per R11 with no code issued, no Discord redirect and
      no session.

- **R4 — Authorize endpoint, PKCE and callback binding.** The authorize endpoint accepts the
  authorization-code grant only, with PKCE required: an `S256` `code_challenge` is mandatory and
  `plain` is rejected. `response_type=code`, `client_id`, `redirect_uri` and `state` (R3) are all
  required. On acceptance the hub creates one pending authorization request row holding the client id,
  redirect URI, PKCE challenge, client `state`, its own Discord `state` and a short expiry, then sends
  the browser to Discord. The Discord callback is resolved by the hub's `state` alone, and the row is
  consumed single-use, so a replayed or unknown `state` exchanges nothing. Authorization codes are
  single-use, short-lived and bound to the client id, the redirect URI and the PKCE challenge.
    - Example: a normal login → pending row created, Discord login, callback with matching `state`, code
      exchanged, hub session issued, client redirected to its registered URI with `code` and its own
      `state` echoed unchanged.
    - Boundary: reopening the callback URL or double-submitting the consent page → the second attempt
      finds no pending request (or a consumed one) and fails; exactly one session exists. An expired
      pending request fails exactly like an unknown `state`.
    - Error: client-side `state` mismatch, unknown/expired/replayed Discord `state`, `plain` PKCE or a
      missing challenge all fail closed: no exchange, no session, an OAuth error per R11, and a consumed
      pending row stays consumed.

- **R5 — Discord identity exchange is server-side only, and short-lived.** The callback exchanges the
  Discord authorization code over HTTPS using `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` and the hub's
  registered Discord redirect URI, then fetches the Discord User id with the resulting access token
  (scope `identify`). The access token — and any refresh token Discord returns — is held in memory for
  that fetch and discarded immediately: it is never persisted, never logged and never returned to the
  client. v1 keeps no refresh machinery (see Decisions). Identity is reduced to the Discord User id;
  username, avatar and profile data are not stored.
    - Example: a successful login → the gateway returns the Discord User id, the credential is discarded,
      and the rest of the flow uses only ids.
    - Boundary: the exchange is **not** retried when a network failure leaves its outcome ambiguous,
      because the authorization code is single-use; the login fails and the User re-runs the flow. The
      bounded retries of the [shared guide](../architecture/shared.md) apply only to the identity fetch,
      which is replay-safe.
    - Error: a Discord error response, a timeout or a payload failing validation is a named technical
      failure that ends the login with a safe message and no session; the upstream response body is never
      echoed and never logged (R13).

- **R6 — Membership gate at login.** Immediately after identity resolution, this feature asks
  [guild-state](guild-state.md) whether a Membership currently exists for that Discord User id in this
  Installation's Guild, and requires the registry status to be current (R10). A User without a
  Membership is denied: no session row is written, no token is issued, and the browser receives a
  clear, stable message and code stating that the Discord account is not a member of this Guild.
  Denial holds for that identity until a Membership exists; re-running the flow with the same Discord
  account reproduces the denial instead of creating a session.
    - Example: member U logs in → Membership found, registry current → session issued and U redirected to
      the client's registered URI.
    - Rejected: non-member X completes the Discord login → `access_denied` page, zero session rows, zero
      tokens; the logged outcome names the User id, the client id and the denial code.
    - Boundary: a Membership that ends between login and the first tool call is caught by the
      per-request check (R8) and the revocation path (R9), never by trusting the login-time decision.
    - Error: an unavailable or erroring guild-state is _not_ reported as denial ("not a member"); it is
      reported as a retryable unavailability (R10), so the two outcomes stay distinguishable.

- **R7 — Hub session model: opaque, server-side, revocable, expiring.** The token endpoint returns the
  hub session token once, as an opaque bearer credential (`token_type: Bearer`) with its lifetime. The
  store keeps only a hash of the token plus the session id, the User id, the client id, `issued_at`,
  `expires_at` and a revocation instant; the plaintext token exists only in the response. Several
  sessions for one User are independent (one per client), and revoking one does not revoke another. An
  expired or revoked session is unusable immediately, without waiting for any cleanup job. When a session
  expires the client learns it from a `401` (R17) and renews it. O1 fixes the lifetime as fixed and
  absolute, never sliding. (Superseded 2026-11-09: v1 kept no refresh token, and the only renewal was a
  new authorization flow; [ADR 0009](../adr/0009-refresh-token-rotation.md) added rotating refresh tokens
  in one family per session, [session-refresh](session-refresh.md) owns those rules, and R18 owns the
  lifetime the token response must publish.)
    - Example: a session with its configured TTL issued → requests succeed until `expires_at`, then fail
      with `401`, and the client re-authorizes without operator involvement.
    - Boundary: a token value that no stored hash matches — including a token from a different
      Installation, a token-shaped string, or a Discord token — is an authentication failure; the response
      never reveals whether the session existed, was revoked or had expired. Session rows hold no
      permission data: authority is always re-derived (R8). (Narrowed by R17: an *expired* credential is
      named as its own cause class, because a standard client must be able to tell "renew this" from "you
      sent nothing". Revoked, unknown and malformed values stay one indistinguishable answer, and no
      outcome carries a session id, a User id or any stored-data fact, so the session-existence half of
      this boundary stands unchanged.)
    - Error: a failure to persist the session ends the login with a safe error and no token; a token whose
      row write failed never exists from the client's point of view.

- **R8 — Every MCP request is authenticated server-side; identity never comes from tool input.** Each
  MCP Streamable HTTP request (`initialize`, `tools/list`, `tools/call` and any continuation on an open
  stream) is authenticated before any tool code runs: a bearer session token is required, hashed and
  looked up, then validated for expiry, revocation and a still-current Membership. The transport
  adapter places the resolved principal (User id + session id) in the request context; use cases
  receive it as an argument and read no HTTP header, cookie or session table. Tool inputs and JSON
  Schema documents carry no principal identity or permission field; a tool call that
  supplies a user id or any identity/permission argument is rejected as invalid input and executes no
  work ([ADR 0005](../adr/0005-gateway-synced-permission-state.md): access is bounded by Discord
  permissions, never by tool arguments, and the MCP surface is read-only with respect to permission
  state).

    Documented retrieval filters such as `authorId` are permitted because they select results, never the
    principal whose permissions are evaluated; identity-bearing arguments remain forbidden at every depth.

    - Example: `tools/call search_messages` with a valid token → the resolved User id feeds the query
      feature's permission evaluation; the tool arguments contain only query parameters.
    - Rejected: a call whose input names another User id, or whose token belongs to a revoked session →
      no dispatch and no result; an unauthenticated request is refused with `401`.
    - Boundary: an unauthenticated request to the MCP endpoint answers `401` with a `WWW-Authenticate`
      header naming the protected-resource metadata document, so a standard MCP client knows where to
      authenticate instead of guessing. Every non-successful validation (missing header, wrong scheme,
      malformed token, unknown session, expiry, revocation, non-current Membership) is an authentication
      failure: none of them dispatches a tool, none of them is a JSON-RPC error and none of them reaches
      tool code. (Superseded in part by R17: the validations are no longer *reported* identically. The
      challenge is the same in all cases, but a missing credential carries no `error` parameter while an
      expired or invalid one carries `error="invalid_token"` and a fixed description naming its class, and
      a technical failure carries `temporarily_unavailable` plus `Retry-After`.)
    - Error: authentication failures never reach tool code and never produce a JSON-RPC success envelope;
      the failure is a `401` (R11) logged as an outcome code with ids only (R13).

- **R9 — Membership end revokes the User's sessions immediately.** This feature subscribes to the
  normalized `discord` event-stream kinds that end a Membership — `member-removed`, and `ban-added`
  once guild-state adopts ban kinds (guild-state's Contracts section keeps them conditional) — the same
  seam [guild-state](guild-state.md) consumes. On receipt it revokes every session of that Discord User
  id in a single write, so the next request fails closed with `401`. Latency is event latency, matching
  guild-state R12, and no Discord REST call is made. The per-request Membership check (R8) is the
  backstop, so a lost or duplicated event cannot leave a revoked User authenticated until expiry.
    - Example: User U is kicked → all of U's sessions are revoked in one statement; U's next tool call is
      `401` and must re-run the flow, which now denies at the gate (R6).
    - Boundary: role changes, channel overwrite changes and private-thread membership changes do **not**
      revoke sessions: they change what a User may read inside their remaining access, which is
      guild-state's and the query feature's authority, not authentication. Revocation is idempotent; an
      event naming a User id with no session is a counted no-op.
    - Error: a failing revocation write is logged with the User id, counted as an anomaly and never
      swallowed silently; the per-request check (R8) remains the backstop, so such a failure degrades the
      latency of revocation, not its correctness.

- **R10 — Fail closed on a non-current registry.** The registry status from
  [guild-state](guild-state.md)'s status query is consulted at login completion (R6) and on every
  authenticated request (R8). While it reports `stale`, `incomplete` or `unavailable` — or when the
  status query itself fails — this feature refuses to treat any Membership as authoritative:
    - new logins are refused with a retryable OAuth error (`temporarily_unavailable`), and no session is
      issued;
    - existing sessions stay valid as identities, but every MCP request is refused with a retryable
      authentication failure, because a stale registry can still over-grant the permissions a request
      would be authorized against (guild-state R11,
      [ADR 0005](../adr/0005-gateway-synced-permission-state.md)).
      This feature never issues a session, and never lets a request through, on the strength of a
      Membership it cannot attest.
    - Example: the hub reconnects while guild-state resyncs → a new login is refused as
      `temporarily_unavailable`; an existing session's tool call fails retryably; both resume once the
      status returns to current, without a re-login.
    - Boundary: guild-state R11 leaves the read policy during that window to this feature; this rule is
      that policy, and O2 records the narrower alternative (letting already-validated sessions through
      while the registry is stale) as an owner decision rather than an implementation choice.
    - Error: `unavailable`, a missing registry and a failing status query all fail closed identically —
      the hub never degrades into "assume current", "assume member" or "assume the session is fine".

- **R11 — Error semantics: OAuth on the authorization surface, protocol errors on MCP.** Authorization
  endpoint failures are standard OAuth error responses per RFC 6749 §4.1.2.1 and §5.2 with stable codes
  (`invalid_request`, `invalid_client`, `unauthorized_client`, `invalid_grant`,
  `unsupported_grant_type`, `invalid_scope`, `access_denied`, `temporarily_unavailable`) and a safe,
  short description; the browser-facing authorization and callback pages render a safe message with
  the same code. Authentication failures on the MCP endpoint are HTTP `401` with `WWW-Authenticate`
  (R8); failures after authentication — invalid tool input included — are MCP/JSON-RPC errors with
  stable codes. No response, whether HTML, JSON or protocol error, contains a stack trace, SQL text,
  an internal hostname, a token, an authorization code, a `state` value, a PKCE verifier or an upstream
  response body.
    - Example: a bad PKCE verifier → `400 invalid_grant` with a short description of the failed
      verification and no other detail.
    - Boundary: unexpected failures become a generic `500` with a correlation id and are logged with
      correlation context ([REST guide](../architecture/rest.md)); expected failures keep named, stable
      codes a client can act on ([feature patterns](../architecture/features.md)).
    - Error: an upstream Discord failure is mapped to a local code and message; the upstream outcome is
      recorded as a code and a count only.

- **R12 — Configuration validated once at startup.** `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`
  (non-empty strings), `PUBLIC_BASE_URL` (an absolute `https` URL, `http` only under an explicit
  local-development setting) and `SESSION_TTL_SECONDS` (integer within documented bounds) are parsed and
  validated once through the shared configuration path ([shared guide](../architecture/shared.md));
  this feature and its consumers never re-read the environment. `PUBLIC_BASE_URL` is the single source
  of the OAuth issuer value, the metadata documents' base and the hub's Discord redirect URI; those are
  derived from it, never duplicated as separate variables. The Discord client secret reaches only the
  gateway.
    - Example: complete configuration → the served metadata document carries the configured issuer, and
      the derived Discord redirect URI equals the value the operator registered on the Discord
      application.
    - Boundary: the hub cannot read the Discord application's registered redirect URIs at startup, so a
      mismatch is not a startup error; it surfaces as a login-time Discord rejection, logged as a
      configuration anomaly naming the expected redirect URI and no credential material.
    - Error: any missing or malformed item fails startup with an explicit error naming it, before any
      listener or network activity; there is no partially configured state and no fallback issuer.

- **R13 — Log safety: ids, codes and counts only.** No log line, error body, counter label or metric
  carries a Discord access or refresh token, a hub session token or its hash, an authorization code
  (hub or Discord), a `state` value, a PKCE verifier or challenge, a client secret or an
  `Authorization` header. Logs and outcomes carry session id, client id, Discord User id, Guild id,
  status and error codes, elapsed times and counts — extending the siblings' log rules
  ([discord](discord.md) R11, [guild-state](guild-state.md) R14, [ingestion](ingestion.md) R12,
  [shared guide](../architecture/shared.md)).
    - Example: a completed login logs the outcome code, client id, User id, session id and elapsed time;
      a failed PKCE verification logs the client id and the error code.
    - Boundary: credential material is excluded even from validation-failure detail and correlation
      context; where a log call would include it, the field is replaced by ids.
    - Error: log safety never blocks, delays or fails a login or a request; a redaction failure is itself
      counted and reported as an anomaly instead of degrading the flow.

- **R17 — RFC 6750 error semantics on the MCP `401` (owner decision "1 · OAuth correcto", 2026-11-12).**
  The authenticator's result always names one of four outcome classes, and all four answer HTTP `401` with
  `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_BASE_URL>/.well-known/oauth-protected-resource"`
  naming the protected-resource metadata document of R2. They differ in exactly two members, and both are
  contract:
    - **(a) no credential presented.** The challenge carries `resource_metadata` and **no** `error`
      parameter, and the body carries no `error` member. That absence is the signal a standard OAuth
      client reads as "nothing was sent — start the authorization flow"; (a) is the one class that must
      never be reported as a token problem.
    - **(b) credential presented and expired.** `error="invalid_token"` with
      `error_description="The access token has expired."`
    - **(c) credential malformed, unknown or revoked.** `error="invalid_token"` with
      `error_description="The access token is invalid."`
    - **(d) technical/retryable failure.** `error="temporarily_unavailable"` (the retryable code of R10 and
      R11) with `error_description="Authentication is temporarily unavailable."`, plus the `Retry-After`
      header. This is the only class that carries `Retry-After`: (a), (b) and (c) never do, because
      replaying the same request with the same credential cannot succeed.

  The body is the RFC 6750 §3.1 object in every class — `error` and `error_description` — so one parser
  serves all four and only the presence of those members differs. No response body carries a stack trace,
  SQL text, a hostname or token material (R11, R13).
    - Example (b): a client whose session passed `expires_at` calls `tools/call` → `401`, the challenge
      above with `error="invalid_token"` and the expired-token description, no `Retry-After`, no tool
      result and no dispatch; the client renews the credential instead of re-probing the URL.
    - Example (a): a fresh client calls `/mcp` with no `Authorization` header → `401` with
      `resource_metadata` and no `error`, so the client runs discovery, registration and the Discord login
      (R2, R4) rather than concluding its token is broken.
    - Boundary (client-facing strings, and what they may not say): the three `error_description` strings
      above are fixed text and part of the contract, so a client or a support conversation may key on them.
      They describe the credential the caller presented and never a row: no session id, no User id, no
      client id, no Membership fact, no existence fact and no stored-data fact. Distinguishing *expired*
      from *invalid* is a UX fact, not a security claim: the three sub-cases inside (c) stay deliberately
      indistinguishable, so revoked, unknown and malformed values answer identically and a holder of any
      of them learns nothing about whether a session existed or why it ended.
    - Error: a `401` whose challenge omits `resource_metadata`, whose body is not the RFC 6750 object, or
      that carries `Retry-After` outside class (d) is a defect of this feature. A cause the authenticator
      cannot classify is (c) or (d), never (a), never (b) and never a success. Rewording a description
      string is a breaking change to a published contract (Compatibility); adding an outcome class is a new
      decision, not an implementation detail.
    - History (superseded by this rule): the guard answered `UnauthorizedException("Authentication
      required.")` with only `WWW-Authenticate: Bearer resource_metadata="…"` and never an `error`
      parameter, and the authenticator collapsed malformed, unknown and expired credentials into one
      `{ authenticated: false }` result (`mcp-authentication.guard.ts`, `authenticate-session.query.ts`;
      recorded in `odd/tasks/mcp-client-resilience.md` L3). R7's "never reveals whether the session
      existed, was revoked or had expired" and R8's "treated identically" are narrowed to exactly what
      the paragraph above allows.

- **R18 — The token response states every lifetime it issued (owner decision "1 · OAuth correcto",
  2026-11-12).** Both grants of `POST /oauth/token` answer with the same five members — `access_token`,
  `token_type: "Bearer"`, `expires_in`, `refresh_token` and `refresh_expires_in` — and
  `refresh_expires_in` is the **absolute** refresh-token lifetime the hub issued in that same response, in
  seconds from the response instant ([session-refresh](session-refresh.md) R4: 30 days, 2592000 seconds;
  each rotation re-issues from zero). A client learns its refresh deadline from the response itself: it
  never has to guess a TTL from documentation, infer it from an earlier response, or reconstruct it from an
  access-token lifetime that is far shorter.
    - Example: a login answers `{ access_token: "<opaque>", token_type: "Bearer", expires_in: 86400,
      refresh_token: "<opaque>", refresh_expires_in: 2592000 }`, so a client can schedule its rotation
      inside 30 days and never needs an unannounced daily re-login.
    - Boundary: both grants answer identically in shape and in the meaning of each member, so one parser
      serves them. `refresh_expires_in` always describes the `refresh_token` in the same body, never a
      previous one, because every rotation replaces it (session-refresh R2, R4). A client that reads only
      `expires_in` keeps working exactly as before; it simply cannot plan past the access token.
    - Error: a grant response that omits either lifetime, or reports one as a number other than the
      lifetime just stored for the credential it returned, is a defect of this feature, found by
      `token-response-reports-refresh-lifetime`. Nothing else in the body changes: no hash, no family id,
      no session id and no Discord credential (R13).
    - History (superseded by this rule): both grant commands already computed the refresh lifetime and the
      token endpoint dropped it, answering `{ access_token, token_type, expires_in, refresh_token }`
      (`exchange-authorization-code.command.ts`, `rotate-refresh-token.command.ts`, `login.controller.ts`;
      `odd/tasks/mcp-client-resilience.md` L3). The computed-but-unpublished value was the whole gap: a
      client could only guess how long the credential it was just handed would live.

- **R19 — Dynamic registration accepts the standard grant set (owner decision "1 · OAuth correcto",
  2026-11-12).** `POST /oauth/register` validates a declared `grant_types` as a **set**: it must contain
  `authorization_code`, it may contain `refresh_token`, and it may contain nothing else. Order and
  repetition carry no meaning. An omitted `grant_types` keeps the existing default of
  `["authorization_code"]`. `response_types` stays exactly `["code"]` and `token_endpoint_auth_method`
  stays exactly `none` (R2): this rule widens neither, and a declared value outside them is still rejected.
    - Example: `{ redirect_uris: [...], grant_types: ["authorization_code", "refresh_token"] }` registers;
      so does `["refresh_token", "authorization_code"]`, and so does `["authorization_code"]`, which is
      what a stock client library sends.
    - Rejected: `[]`, `["refresh_token"]` (a set without `authorization_code`), `["client_credentials"]`,
      `["authorization_code", "client_credentials"]`, `["implicit"]` → `invalid_client_metadata` with no
      client row written (R2's error behavior), exactly as before this rule.
    - Boundary: the declared set is validated, never stored — it records what the client says it does and
      grants nothing, because registration issues no secret and the token endpoint decides every grant on
      its own terms (R7, session-refresh R2). A client that declared only `authorization_code` still
      receives and may use a refresh token (R18). A client whose *own* configuration declares only
      `authorization_code` and therefore never refreshes is that client's setting, explained by the
      installation checklist, not a hub refusal: this rule claims no hub-side behavior for a client that
      never asks, and the client half is recorded in `odd/tasks/mcp-client-resilience.md` S1.
    - Error: a `grant_types` body that is not an array of strings, or a member that is not a string, is
      `invalid_client_metadata` like any other malformed metadata, and the rejection writes nothing.
    - History (superseded by this rule): the command rejected every declared set except exactly
      `["authorization_code"]` (`register-client.command.ts`) while the authorization-server metadata
      advertised `grant_types_supported: ["authorization_code", "refresh_token"]`
      (`get-authorization-server-metadata.query.ts`; `odd/tasks/mcp-client-resilience.md` L3). A client
      that registered the grants the hub itself advertises was refused by the hub's own contradiction;
      this rule accepts every grant that metadata advertises and keeps every other rejection.

## Contracts and boundaries

- Exposed transport: one HTTP surface owned here — the OAuth protocol endpoints, which are neither
  MCP tools nor a REST business API — plus this feature's authentication of the MCP Streamable HTTP
  endpoint owned elsewhere. The OAuth endpoints' contract _is_ the cited standard plus what this
  specification adds, and no OpenAPI document describes them, exactly as
  [ADR 0004](../adr/0004-mcp-primary-transport.md) keeps OpenAPI for auxiliary REST resources rather
  than for protocol surfaces. Every endpoint carries an explicit access classification
  ([REST guide](../architecture/rest.md)):
    - `GET /.well-known/oauth-authorization-server` — public, unauthenticated, cacheable authorization
      server metadata (RFC 8414): issuer, endpoint URLs, supported grant types and PKCE methods,
      public-client `token_endpoint_auth_method: none`, and scopes. No secrets, no client list.
    - `GET /.well-known/oauth-protected-resource` — public, unauthenticated metadata for the MCP endpoint
      (RFC 9728) naming this hub as the authorization server.
    - `POST /oauth/register` — public dynamic client registration (RFC 7591); unauthenticated by design
      for public clients, bounded by R3 validation and the rate limits O3 decides.
    - `GET /oauth/authorize` — public browser endpoint consuming `client_id`, `redirect_uri`,
      `response_type=code`, `code_challenge` with `code_challenge_method=S256`, and `state` (R3, R4).
    - `POST /oauth/token` — public; two grants and no third. `grant_type=authorization_code` with `code`,
      `redirect_uri`, `client_id` and `code_verifier`; `grant_type=refresh_token` with `refresh_token` and
      `client_id` ([session-refresh](session-refresh.md) R2). Both answer
      `{ access_token, token_type: Bearer, expires_in, refresh_token, refresh_expires_in }` (R18).
      (Superseded 2026-11-12: this bullet said "the hub session token with `token_type: Bearer` and
      `expires_in`, and no `refresh_token` in v1. There is no other grant." —
      [ADR 0009](../adr/0009-refresh-token-rotation.md) added the refresh grant and R18 publishes every
      lifetime it issues.)
    - `GET /oauth/discord/callback` — public but `state`-bound (R4, R5); this is the hub↔Discord leg,
      not a client entry point, and it redirects to the client's registered URI only after a session is
      issued.
      The MCP Streamable HTTP endpoint is the protected surface (R8): every request requires a hub session
      token, and its `401` carries `WWW-Authenticate` naming the protected-resource metadata document.
- Public use cases (`index.ts`; inputs are camelCase application types with no HTTP or Discord types):
    - `AuthenticateSessionQuery` — input: the opaque session token as presented by the transport adapter
      (never a tool input); output: the authenticated principal (User id, session id, expiry) together
      with the validity facts of the check that gated it (session authenticated, Membership current,
      registry status current), or a named authentication failure that identifies one of R17's four
      outcome classes (no credential, expired, malformed/unknown/revoked, technical/retryable). This is the
      session → [User](../../CONTEXT.md) seam the query feature consumes; no other feature reads the
      session store, and no other feature re-resolves identity from Discord. (Superseded by R17: "a named
      authentication failure" used to be a single undifferentiated `{ authenticated: false }` — the four
      classes are the contract the transport adapter maps onto the `401`.)
    - `GetAuthorizationServerMetadataQuery` — the values served by R2, so the contract is testable
      without an HTTP client.
    - Consumed contracts: `GetGuildStateStatusQuery` (registry completeness and staleness, R10) and the
      Membership read (R6, R8) belong to [guild-state](guild-state.md). The Membership read is this
      feature's requirement on that public surface: a User-id lookup returning `present` or `absent` for
      the Installation's Guild, authoritative only while the status is current. Its final name and shape
      are guild-state's to fix; if guild-state does not declare it yet, the addition is an intentional
      cross-feature contract change to record there, never an import of guild-state tables.
- Commands (named for their intent):
    - `RegisterClientCommand` — dynamic registration validation and persistence (R2, R3).
    - `BeginLoginCommand` — authorize-request validation, pending request creation and the Discord
      authorization URL (R3, R4).
    - `CompleteLoginCommand` — callback: `state` resolution, Discord exchange and identity (R5),
      Membership gate (R6), session issuance (R7), pending-request and code consumption (R4).
    - `RevokeSessionCommand`, `RevokeUserSessionsCommand` — single-session and membership-end revocation
      (R7, R9).
    - `PurgeExpiredSessionsCommand` — bounded housekeeping of expired sessions and old pending requests.
      Expiry is enforced by validation at read time (R7); the sweep is never a security control.
- Queries: `AuthenticateSessionQuery` and `GetAuthorizationServerMetadataQuery` above. No query returns
  token material, token hashes or the registered client list.
- Event subscription: normalized `discord` stream kinds only, and only for revocation (R9).
- Discord OAuth gateway contract (owned here, implemented in this feature's `gateways/`): one narrow
  `DiscordOAuthGateway` with the authorization-code exchange and the current-user identity fetch.
  HTTPS only, explicit timeouts, payload validation before use, no discord.js types and no Guild
  operation (Guild reads belong to the [discord](discord.md) adapter). Client credentials live in
  configuration and reach the gateway only ([shared guide](../architecture/shared.md)); Discord error
  responses map to named technical failures without echoing the body (R5).
- Repository contracts (owned here; parameterized SQL, explicit column selection, `timestamptz`
  instants and bigint ids per the [persistence guide](../architecture/persistence.md)): insert a
  registered client with its exact redirect URI set; find a client with its redirect URIs; insert a
  pending authorization request; consume a pending request by its Discord-`state` key, atomically and
  single-use; consume an authorization code once; insert a session; find an active session by token
  hash in one read that excludes expired and revoked rows; revoke one session; revoke every session of
  a User id in one statement; delete expired sessions and old pending requests in bounded batches.
- Transactions and consistency: session issuance is a single insert and revoking all of a User's
  sessions is a single statement. Pending-request and code consumption are single-use by construction
  (one conditional write returning the row), so two concurrent callbacks cannot both issue a session.
  No transaction spans a Discord HTTPS call: the exchange and identity fetch complete before the
  session write, and a failed write leaves no session and no usable code. A non-current registry read
  never authorizes a session write (R10).
- Retry/idempotency: authorization codes, pending requests and Discord-`state` values are single-use;
  replayed callbacks, replayed codes and repeated consents fail without creating a second session.
  Session revocation is idempotent. Dynamic registration is deliberately **not** deduplicated: a second
  registration is a second client, because RFC 7591 exposes no operation identity this feature may
  assume.
- Composition: this feature's module wires its controllers, commands, queries, repository
  implementations and gateway behind explicit tokens and factories. The MCP transport adapter (owned
  with the MCP surface, not here) mounts this feature's authentication guard: the resolved principal
  enters the request context before JSON-RPC dispatch and every tool use case receives it as an
  argument. No use case reads HTTP headers, cookies or the session store directly, and the transport
  adapter holds no authorization policy of its own
  ([structure](../architecture/structure.md), [shared](../architecture/shared.md)).
- Compatibility: additive. The OAuth endpoint paths, the OAuth error codes and the session-store
  semantics (opaque token hash, `timestamptz` expiry, bigint User id) are a cross-feature contract other
  features and their tests depend on; changing an error code, a path or a column's meaning is a
  breaking change requiring an explicit decision. OAuth protocol paths carry no `/v1` prefix — the
  version namespace recorded in [project context](../project-context.md) governs MCP tool evolution.

## Implementation and proof

- Minimal affected paths: `src/features/authorization/` — `authorization.module.ts` (composition),
  controllers for the six endpoints above, the commands and queries listed, repository contracts plus
  their PostgreSQL implementations, the `DiscordOAuthGateway` and its HTTP adapter, domain models,
  DTOs and mappers, and `index.ts` as the intentional surface; shared configuration entries; an
  append-only migration for registered clients, pending authorization requests and sessions; the
  application module wiring; and the authentication guard mounted by the MCP transport adapter. No
  Gateway connection, no Guild REST read, no message table and no MCP tool contract.
- Tests per rule, against an isolated real PostgreSQL database for the client registry, pending
  requests and session store, with the Discord OAuth gateway behind a test double and a scripted MCP
  client driving the flow end to end (discovery → registration → authorize → Discord callback → token
  → `tools/list` → `tools/call`). No test contacts Discord.
    - R1/R2/R7: the scripted client receives only hub tokens; no token material appears in a
      client-visible payload; two clients of one User hold independent sessions.
    - R3: exact-match cases — registered URI accepted, an extra path segment, another host and an
      omitted `redirect_uri` rejected — plus the assertion that a rejected request produced no redirect
      to the caller's URI.
    - R4/R5: happy-path callback; an `S256` mismatch rejected with `invalid_grant` and no session; a
      `plain` challenge rejected; a missing or empty `state` rejected.
    - Negative cases required by [ADR 0006](../adr/0006-discord-sso-dynamic-client-registration.md)
      "Verification and adoption", named here for stable test names:
        - `non-member-user-denied` — a Discord identity with no Membership gets `access_denied` and zero
          session rows.
        - `tampered-state` — a mutated client `state` echo and a mutated Discord-leg `state` are both
          rejected, with no code exchanged and no session, and the pending request stays consumed.
        - `pkce-failure` — a wrong `code_verifier` is rejected and the code is unusable afterwards.
        - `expired-session` — a session past `expires_at` answers `401` with no tool execution.
        - `revoked-after-membership-end` — a normalized `member-removed` event revokes every session of the
          User in one write and the next request is `401`, while a role change revokes nothing.
        - `guild-state-unavailable-at-login` — a `stale`/`incomplete`/`unavailable` registry status yields
          `temporarily_unavailable` at login and a retryable refusal for an existing session, never a
          denial and never a session.
    - R8: no tool executes without a session (structural test of the dispatch path's requirement for a
      resolved principal); a tool input carrying a user id is rejected and executes nothing; an
      unauthenticated request answers `401` with `WWW-Authenticate` naming the metadata document.
    - R9: duplicate and unknown-User events are idempotent no-ops; a failing revoke write is counted.
    - R10: the transition `current → stale → current` gates new logins and existing requests exactly as
      stated, with no write and no session issued on refusal.
    - [ADR 0005](../adr/0005-gateway-synced-permission-state.md) revocation scenarios, mapped to this
      feature's responsibility: `revocation-member-kicked` revokes the User's sessions (R9);
      `revocation-role-removed`, `revocation-channel-overwrite-changed` and
      `revocation-private-thread-membership-lost` assert that the session stays valid and the resolved
      principal unchanged, because those changes narrow what the User may read (guild-state's and the
      query feature's tests prove the access effect) rather than who is authenticated;
      `resync-after-reconnect` is exercised here as R10's gating, which refuses logins and requests while
      the registry reports a non-current status.
    - R11: status and body shape per OAuth error code; no stack trace, SQL text or upstream body in any
      response; the `500` correlation behavior.
    - R12: startup failure per item — client id, client secret, base URL, out-of-bounds TTL — each
      asserted before any listener or network call.
    - R13: a log scan asserts that a fixture session token, fixture Discord access token, fixture
      authorization code, fixture `state` and fixture client secret appear in no emitted log line,
      counter label or error response.
    - R17: the three named cases `unauthorized-missing-token`, `unauthorized-expired-token` and
      `unauthorized-invalid-token` assert, through the composed MCP surface, the `401` status, the exact
      `WWW-Authenticate` parameters of their class (including the **absence** of `error` in the first), the
      RFC 6750 body members, the absence of `Retry-After` outside class (d), and zero tool dispatch; a
      fourth case covers (d) with `temporarily_unavailable` and `Retry-After`, and a scan asserts no
      response body carries a session id, a User id or token material.
    - R18: `token-response-reports-refresh-lifetime` — both grants' responses carry `expires_in` and
      `refresh_expires_in`, and the reported refresh lifetime equals the value just stored for the returned
      token (never a previous one), for a login and for a rotation.
    - R19: `registration-accepts-refresh-grant` — `["authorization_code", "refresh_token"]` registers,
      while a set without `authorization_code`, an empty set, an unknown grant, a non-`code`
      `response_types` entry and a non-`none` `token_endpoint_auth_method` each still answer
      `invalid_client_metadata` and write no client row.
- Safe isolated database setup: a dedicated PostgreSQL test database/schema with an explicitly supplied
  test connection, isolation confirmed before setup or cleanup; missing database access is reported as
  unavailable evidence, never passed, and no shared or production data is truncated
  ([testing guide](../architecture/testing.md)).
- Actual verification commands: `npm run format`, `npm run lint`, `npm run arch`,
  `npm run typecheck`, `npm test`, and isolated in-compose `npm run test:integration`.
  See [composition and operations](../project-context.md#authorization-composition-and-operations).
  Owner implementation scope separates feature/use-case/repository proof from the composed MCP
  client flow: the latter is FINAL-phase work and is not included in this lane's completion claim.
- Concrete consumed Membership contract: `GetMembershipStatusQuery.execute({ userId })` from
  `guild-state/index.ts`, yielding `status: present | absent`; `GetGuildStateStatusQuery` is checked
  before and after the Membership read, with only `current` accepted.
- Documentation updates at implementation: project-context feature section, `CONTENTS.md` entry, a local
  `AGENTS.md` only if invariants emerge, the guild-state cross-reference once the Membership read has
  its final name, and the query feature's cross-reference to the session seam.

## Decisions (2026-11-04)

- Authorization-server ownership: the hub is its own OAuth 2.1 authorization server for the MCP
  surface, with Discord as the upstream SSO identity provider and dynamic client registration so that
  no operator per-client setup exists
  ([ADR 0006](../adr/0006-discord-sso-dynamic-client-registration.md)).
- Identity boundary: this feature owns the Discord OAuth gateway contract (code exchange and identity
  fetch) because those are identity flows; the `discord` feature owns Guild protocol only. Login is
  identity, not Guild event handling.
- Hub-issued sessions: the client receives only an opaque hub session token; Discord access and refresh
  tokens stay server-side and are never logged
  ([ADR 0006](../adr/0006-discord-sso-dynamic-client-registration.md)).
- Session posture recorded with this specification: identity is established once at login and the
  Discord access token is discarded after the identity and Membership check — v1 keeps no
  refresh-token machinery and performs no Discord re-verification mid-session, because Membership is
  continuously authoritative through [guild-state](guild-state.md)
  ([ADR 0005](../adr/0005-gateway-synced-permission-state.md)).
- Access-decision authority stays with guild-state: a session proves who is calling, while every read
  is still authorized by the effective-permission evaluation at query time. No permission state is
  copied into this feature.
- Fail-closed policy during resync: no session is issued and no request is served on a Membership this
  feature cannot attest (R10); the narrower alternative is O2.
- No OpenAPI document for the OAuth endpoints: their contract is the cited RFCs plus this specification,
  consistent with [ADR 0004](../adr/0004-mcp-primary-transport.md) treating protocol surfaces separately
  from REST resources.

## Open decisions

- **O1 — Session lifetime and renewal (resolved 2026-11-06).** Coordinator decision under the owner's
  standing security-first/simplicity-second directives, subject to owner veto at lane verification:
  `SESSION_TTL_SECONDS` is required with no default, integer 300..86400 inclusive. Expiry is fixed and
  absolute, never sliding; expired credentials receive 401 and the client re-authorizes. The verbatim
  decision is recorded in `odd/tasks/authorization.md` Log.
- **O2 — Existing sessions during a resync window.** Question: keep R10's total fail-closed policy
  (every MCP request refused while guild-state is `stale`/`incomplete`), or let already-authenticated
  sessions continue and rely on guild-state's and the query feature's own gating for the reads? Consequence:
  total fail-closed makes MCP unavailable for the duration of every post-reconnect resync, which can be
  minutes on a large Guild; the narrower policy keeps the service usable but authorizes reads during
  the window against a registry that cannot attest currency — an explicit over-grant risk under
  [ADR 0005](../adr/0005-gateway-synced-permission-state.md). Owner: Project owner. Resolution trigger:
  before implementing R10, with resync duration measured on the guild-state resync path.
- **O3 — Rate limits for the authorization endpoints.** Question: which dedicated limits apply to
  registration, authorize, token and callback (per IP, per client id, per User id) beyond the generic
  HTTP bounds, and with what values? Consequence: the registration endpoint is unauthenticated by
  design, so without a limit any caller can grow the client table; the token endpoint is the
  code-and-verifier-guessing surface, and an unlimited authorize endpoint invites redirect-request
  floods. Owner: Project owner. Resolution trigger: before exposing the endpoints outside a trusted
  network, with measured request costs from the scripted flow.
