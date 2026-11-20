# Feature specification — Session refresh (rotating refresh tokens)

## Goal and source request

- Owner: Project owner
- Source request (verbatim, 2026-11-09): "la idea es que se haga el login con discord y este lo revise
  siempre, no? tu que recomiendas? vamos a hacerlo bien, no queramos correr"
- Expected outcome: MCP clients keep a working session for a month without any human re-login, while
  every access token stays short-lived, every refresh is rotated single-use, and a leaked refresh
  token destroys its own family. Authorization itself is unchanged: every request still re-derives
  the caller's effective Discord permissions.
- Non-goals: static long-lived tokens; Discord-token passthrough; per-endpoint rate limits (separate
  decision O3); changes to the five tools or to permission evaluation.
- Owning feature: `authorization`. Relevant ADRs: [0006](../adr/0006-discord-sso-dynamic-client-registration.md)
  (basis), [0009](../adr/0009-refresh-token-rotation.md) (this feature; supersedes 0006's "no refresh
  machinery" clause upon acceptance).

## Behavior

"Refresh family" means: the refresh token issued at login plus every rotation descended from it; all
members share one `family_id` and die together. "Consumed" means: a refresh token that has been
rotated already; its row keeps the hash and the marker. "Session" means: the hub session the family
belongs to; it keeps its own expiry semantics.

- **R1 — The code grant returns a token pair.** `POST /oauth/token` with
  `grant_type=authorization_code` now returns `{ access_token, token_type, expires_in,
refresh_token }`. The refresh token is an opaque credential, stored only as a hash, bound to the
  newly created session and to a new family id. Existing clients that ignore the extra field are
  unaffected.
    - Example: a normal login → 200 with both credentials; `refresh_token` present.
    - Rejected: a client metadata error or PKCE failure → same errors as before, and no tokens at all.
- **R2 — The refresh grant rotates single-use.** `grant_type=refresh_token` requires the refresh
  token and (public clients) the `client_id`; it must match a stored, unconsumed, unexpired refresh
  token whose session is alive and whose client matches. Success consumes the presented token and
  returns a NEW access token (same TTL bounds) plus a NEW refresh token in the same family; the
  session's user binding never changes.
    - Example: refresh at 09:00 → new pair; presenting the 09:00 refresh again → refused (consumed), and
      see R3.
    - Boundary: the access token issued at login remains valid until its own expiry — refresh does not
      invalidate it (clients may hold both mid-rotation).
    - Error: unknown, malformed, consumed or expired refresh token → `invalid_grant`; the response is
      identical for all four cases (no oracle about which one happened).
- **R3 — Reuse kills the family.** Presenting a **consumed** refresh token is evidence that the
  family leaked. The hub revokes the session and every refresh token of that family, then answers
  `invalid_grant`. A subsequent refresh with ANY token of that family fails identically.
    - Example: token from 09:00 replayed at 10:00 after a 09:30 rotation → whole family revoked; the
      legitimate 09:30 refresh token also stops working.
    - Boundary: this is deliberately harsher than refusing silently — the standard requires it, and it
      is what turns a leak into a self-contained incident.
- **R4 — Absolute expiry.** A refresh token expires **30 days after its issuance** (each rotation
  re-issues from zero), regardless of use. An expired refresh token is refused with `invalid_grant`
  and does NOT revoke its family: expiry is routine, not evidence of a leak.
    - Example: a client that returns after 40 idle days → refused once, recovers with a fresh Discord
      login. Nothing else in that family was compromised.
- **R5 — Membership end cascades.** Leave, kick or ban revokes the session AND its whole refresh
  family immediately (the existing membership-end subscription gains the family sweep). A refresh
  attempt afterwards is refused with `invalid_grant`.
- **R6 — Authorization stays live.** No refresh path copies or freezes permissions: the access
  token keeps identifying the user, and every tool request re-evaluates guild-state exactly as
  before ([ADR 0005](../adr/0005-gateway-synced-permission-state.md)). Refresh changes _how long_
  authentication lasts, never _what_ may be read.
- **R7 — Storage and log safety.** Refresh tokens are stored hashed (same discipline as session
  tokens); the plaintext appears only in the grant response. No token, hash or family id is logged;
  audit lines carry client id, user id, family id and outcome code only.
- **R8 — Housekeeping.** Expired refresh tokens and dead families are deletable in bounded batches;
  expiry is enforced at validation time, never by the sweep.

## Contracts and boundaries

- Endpoint: the SAME `POST /oauth/token` gains one grant type; response gains one field. Additive.
- Repository additions (`authorization-store.repository.ts`): insert refresh token (hash, session id,
  family id, expiry); find unconsumed by hash (excluding expired); consume by hash (single-use,
  returning the row); revoke family by family id; delete expired in bounded batches.
- Schema (append-only migration): `oauth_refresh_token` table — `token_hash` PK (sha256 hex), client
  FK, session id FK, `family_id`, `issued_at`, `expires_at`, `consumed_at` nullable; index on family
  for the sweep, partial index on unconsumed for validation.
- Token shape: opaque base64url, ≥ 256 bits of entropy; the family id never appears in the token.
- Compatibility: additive per the versioning decision; the `/oauth/token` response gains a field
  (clients must tolerate unknown fields already).

## Implementation and proof

Implemented in the `authorization` feature; the named tests below and the integration suite are its
executable evidence.

- Direction to code, per rule:
    - R1 — `ExchangeAuthorizationCodeCommand` inserts the session and the first refresh row of a new
      family and returns both credentials.
    - R2 — `RotateRefreshTokenCommand`, dispatched from `POST /oauth/token` by `LoginController`; the
      single-use consumption is one conditional `UPDATE … WHERE consumed_at IS NULL AND expires_at > now`
      and every refusal is `invalid_grant`.
    - R3/R4 — same command: a consumed token outside the grace revokes the family and its sessions;
      an expired unconsumed token is refused without touching the family.
    - R5 — `RevokeUserSessionsCommand` sweeps the user's refresh families in the same call that revokes
      their sessions; `MembershipEndSubscription` remains the trigger.
    - R6 — the access token keeps its existing meaning: `AuthenticateSessionQuery` re-derives the
      membership and registry status per request, and no refresh path copies permissions.
    - R7 — migration `8_refresh_tokens` stores SHA-256 hashes only (hex CHECK, both foreign keys, family
      index, partial unconsumed index); `AuthorizationAuditGateway` logs ids, the family id and an
      outcome code, never a token or hash.
    - R8 — `deleteExpiredRefreshTokens` and `deleteDeadRefreshFamilyTokens` are bounded batches inside
      the repository purge; expiry is still enforced at validation.
- Tests (named, per the ADR): `refresh-rotates-single-use` (pair rotates, old token consumed),
  `refresh-reuse-revokes-family` (replay → family dead, all members refused),
  `refresh-expired-refused` (expired → invalid_grant, family intact),
  `refresh-revoked-with-membership` (kick → refresh refused), `access-token-permissions-still-live`
  (post-refresh reads still re-derive permissions; a mid-session permission change applies).
- All against isolated real PostgreSQL (`tests/integration/session-refresh.integration.test.ts`, plus
  store-level cases in `tests/integration/authorization-store.integration.test.ts`); the Discord OAuth
  gateway stays doubled; log scans assert no token/hash material.
- Verification commands: as recorded in project context; the integration suite extends the
  authorization store file. Actual per-task results are in the ODD task log.
- Operations, client behavior, housekeeping and rollback:
  [session refresh operations](../deployment/session-refresh.md).

## Open decisions

- **O-A — Refresh TTL value (RESOLVED 2026-11-09).** 30 days accepted in [ADR 0009](../adr/0009-refresh-token-rotation.md) (owner, 2026-11-09). Alternatives 7 or 14 for a tighter posture. Does not change any contract, only a constant.
- **O-B — Concurrent-rotation grace (RESOLVED 2026-11-09: 30 s grace, single previous generation, still consumed).** A client that fires two refreshes near-simultaneously (retry
  after a timeout) gets the second one refused as reuse → family revoked. Alternatives: a short
  grace window accepting the immediately-previous token once, or a per-family in-flight lock that
  serializes rotations. Recommendation: grace window of 30 s accepting the immediately-previous
  generation exactly once, still marking it consumed. To decide before implementation.
