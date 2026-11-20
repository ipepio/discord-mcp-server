# Session refresh deployment and operations

Rotating refresh tokens (ADR 0009) for `docs/features/session-refresh.md`. The feature is additive:
existing clients that ignore `refresh_token` keep working exactly as before, and every authenticated
request still re-derives the caller's Discord permissions.

## What clients get

A successful login (`POST /oauth/token`, `grant_type=authorization_code`) and every refresh return the
same response shape:

```json
{ "access_token": "…", "token_type": "Bearer", "expires_in": 86400, "refresh_token": "…" }
```

- The **access token** is the hub session token: opaque base64url, valid for `SESSION_TTL_SECONDS`
  (300–86400 s, configured), stored server-side only as a SHA-256 hash.
- The **refresh token** is a second opaque credential in a _family_. Every token in one login chain
  shares one `family_id` (a UUID that never appears in a token) and lives at most **30 days from its
  own issuance**; each rotation restarts that 30-day clock.
- The first-party browser page (`/login/callback`) shows both credentials with their expiry hints. It
  is the only place the plaintext pair is rendered; nothing else returns or logs it.

Clients refresh with:

```http
POST /oauth/token
Content-Type: application/json

{ "grant_type": "refresh_token", "refresh_token": "<current token>", "client_id": "<client id>" }
```

## Refresh behavior

- **Rotation is strict single-use.** A successful refresh consumes the presented token and returns a
  new access token plus a new refresh token in the same family, anchored to a new hub session. The
  previous access token stays valid until its own `expires_at` — refresh never invalidates it, so a
  client may briefly hold two.
- **Grace window (30 s).** A retried/concurrent refresh may present the immediately previous
  generation once: a consumed token is accepted while it is its family's **single latest consumption**
  (a same-instant tie between two consumed tokens is treated as reuse, fail-closed), was consumed
  less than 30 seconds ago, and the family still has a live (unconsumed) token. The token stays
  consumed; the window is measured from the consumption and is not extended by use.
- **Reuse revokes the family.** Presenting a consumed token outside that window is evidence of a leak.
  The hub revokes every token of the family and the sessions it issued, then answers `invalid_grant`.
  Any later attempt with any token of that family fails the same way.
- **Expiry is routine.** An expired unconsumed token is refused with `invalid_grant` and its family is
  left intact: nothing was compromised, the client just needs a fresh Discord login.
- **Membership end cascades.** Leave/kick/ban revokes the user's sessions and their whole refresh
  family immediately, so the next refresh fails with `invalid_grant`.
- **Errors are indistinguishable.** Unknown, malformed, consumed and expired tokens all produce the
  same `invalid_grant` response; no oracle says which case happened.
- **No new settings.** The 30-day TTL and 30-second grace are fixed by the accepted ADR. The access
  token keeps `SESSION_TTL_SECONDS`.

Operational consequence: a client that refreshes while it has been used within the last 30 days keeps
working indefinitely. A client idle for **40 days** (30-day token + access-token ceiling) is refused
once and must re-run the Discord login; nothing else in its family was compromised.

## Schema and housekeeping

Migration `8_refresh_tokens` (append-only) adds `oauth_refresh_token`: `token_hash` primary key (SHA-256
hex CHECK), `client_id` and `session_id` foreign keys, `family_id uuid`, `issued_at`, `expires_at`
(`expires_at > issued_at` CHECK) and a nullable `consumed_at`, with indexes for the family sweep, the
live (unconsumed) head and expiry. Apply migrations explicitly before starting the new version, as
usual:

```sh
docker compose run --rm app sh -c "npm ci && npm run migrate"
```

`PurgeExpiredSessionsCommand` / the repository `purgeExpired` sweeps in bounded batches (never
unbounded): expired refresh tokens, then dead families (families with no live head, e.g. after a
reuse or membership revocation), then sessions that no refresh row still references, then old pending
requests and authorization codes. The session sweep skips a session that still anchors an unexpired
family row, so expired access sessions are retained at most until their family's 30-day window ends.
Expiry is always enforced by validation at use; the sweep is storage hygiene, never a security
control.

Rollback: leaving the table in place while running the previous application version is safe
(additive schema, ignored extra response field). Dropping it (`npm run migrate:undo`) destroys every
refresh family and forces all clients to log in again; do it only deliberately.

## Log safety

No log line carries a token, a token hash, an authorization code or a PKCE verifier. Audit lines are
`authorization outcome` with `code` (`session_issued`, `refresh_rotated`, `refresh_grace_accepted`,
`refresh_expired`, `refresh_reuse_detected`, `invalid_grant`), `clientId`, optional `userId`,
`sessionId` and `familyId`. Revocation logs carry `userId`, `count` and `refreshCount`. Note that the
structured logger redacts fields whose name looks secret (`token`, `secret`, `key`, …), which is why a
refresh-token count is named `refreshCount`.

## Rate limits (O3)

The four public OAuth endpoints and `/mcp` are bounded by a fixed-window, per-client-IP limiter that
runs inside the authorization module: registration 10/hour, `authorize` and the Discord callback
20/minute, token 30/minute and `/mcp` 300/minute by default (`RATE_LIMIT_*` variables). A refused
request answers `429` with `Retry-After`; throttle log lines carry only `code: rate_limited` and the
address. State lives in process memory with a hard entry cap (oldest entry evicted), which is correct
for the v1 single-instance compose deployment. **A multi-instance deployment needs a shared store**
(Redis or the database) so the bound is global; that is a deployment decision, not implemented here.

The limiter assumes **one trusted reverse-proxy hop**: it keys on the rightmost `X-Forwarded-For`
entry and falls back to `req.socket.remoteAddress` when the header is absent. Publish only the proxy,
and have it set or overwrite `X-Forwarded-For`; a directly reachable application port would let a
caller choose its own limiter key.

## Verification

Repository gates: `npm run format`, `npm run lint`, `npm run arch`, `npm run typecheck`, `npm test`.
Real PostgreSQL evidence comes from the isolated integration harness (create/drop per suite, never a
shared database); run it inside the compose network:

```sh
export POSTGRES_PASSWORD=$(docker exec <postgres-container> printenv POSTGRES_PASSWORD)
docker compose -p discord-mcp-server-refresh run --rm --no-deps \
  -v refresh-modules:/srv/app/node_modules \
  -e TEST_DATABASE_URL="postgres://<db-user>:$POSTGRES_PASSWORD@postgres:5432/postgres" \
  app sh -c "npm ci --no-audit --no-fund && npm run test:integration"
```

The suite covers the named tests `refresh-rotates-single-use`, `refresh-reuse-revokes-family`,
`refresh-expired-refused`, `refresh-revoked-with-membership` and
`access-token-permissions-still-live`, plus a log scan asserting no token or hash material appears in
logs or audit outcomes.
