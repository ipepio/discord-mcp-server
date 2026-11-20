# 0009 — Refresh token rotation for long-lived client access

- Status: Accepted by owner
- Scope: Security / authentication
- Owner: Project owner
- Acceptance evidence: owner accepted the record on 2026-11-09 after reviewing the proposal
  ("lo acepto, desarrollalo"). The 30-day refresh TTL stands (O-A resolved as proposed); O-B resolved
  with the proposed 30-second single-previous-generation grace window, still consuming that token.
  Implementation authorized on the same message.
- Supersedes: [0006](0006-discord-sso-dynamic-client-registration.md) partially — it extends the
  session model with the OAuth 2.1 refresh-token grant; every other 0006 decision (dynamic client
  registration, Discord SSO, hub-issued opaque tokens, server-side storage) stays in force.

## Context

The hub currently issues a single opaque session per login with a fixed expiry and **no refresh**
mechanism (a deliberate v1 simplification). That forces a full Discord re-login at every expiry:
tolerable hourly for a human on the landing page, but a recurring interruption for MCP clients that
lack OAuth support (they would need a manually pasted bearer token, renewed daily), and friction even
for clients that do support OAuth (a re-authorization round trip per day).

The alternative considered — long-lived static tokens (90 days) for OAuth-less clients — was
rejected: it contradicts the owner's own requirement that users cannot be impersonated, and a
multi-day bearer token that never rotates is, in practice, a non-expiring password.

## Decision

Add the OAuth 2.1 refresh-token grant to the hub's authorization server, with **rotation and reuse
detection**:

1. `POST /oauth/token` additionally accepts `grant_type=refresh_token` with a `refresh_token` and
   (for public clients) `client_id`. The authorization-code grant now also returns a
   `refresh_token` next to the session token.
2. Every refresh **rotates**: the presented refresh token is consumed single-use and a new refresh
   token is issued with the response. A short access token (24 h max, unchanged bounds) plus a fresh
   refresh token accompany each rotation.
3. Refresh tokens are stored **hashed**, belong to one session (and through it, to one user and
   client), and expire absolutely after **30 days** of their last rotation.
4. **Reuse detection**: presenting an already-consumed refresh token means its chain leaked. The hub
   revokes the **entire token family** (the session and every refresh token descended from it) and
   refuses the request.
5. Ending the Membership (leave/kick/ban) revokes the session and its whole refresh family, exactly
   as sessions are revoked today. Every authenticated request keeps re-deriving permissions from
   guild-state — nothing about authorization changes.
6. The browser first-party login (`/login`) keeps working unchanged: it now simply returns a token
   pair instead of a lone access token.

### Configured values

| Setting           | Value                                    | Rationale                                                            |
| ----------------- | ---------------------------------------- | -------------------------------------------------------------------- |
| Access token TTL  | stays `SESSION_TTL_SECONDS`, 300–86400 s | short-lived; permissions re-derived per request regardless           |
| Refresh token TTL | **30 days** absolute from last rotation  | a working month of unattended use per client; bounded, not "forever" |
| Rotation          | strict single-use                        | required for reuse detection to mean anything                        |
| Reuse response    | revoke the whole family                  | standard OAuth 2.1 practice; the leak kills itself                   |

## Alternatives

- **Long-lived static tokens for OAuth-less clients** (earlier coordinator suggestion): rejected — a
  de facto password that survives leaks and revokes only by hand; contradicts the impersonation
  requirement and the spirit of ADR 0006.
- **Status quo (24 h + re-login)**: rejected as the end state — daily re-authorization interrupts
  unattended use and makes static-token workarounds tempting again.
- **Discord-token passthrough**: rejected — the hub's session must not depend on Discord token
  lifetime, and Discord tokens must remain server-side only.

## Consequences

- New persistence: a refresh-token table (hash, session id, family id, expiry, consumed marker) and
  the `refresh_token` grant in the token endpoint; both are additive schema and additive grant —
  no existing endpoint changes shape except gaining a field in the response.
- Clients that ignore the refresh token keep working exactly as before (access token per session).
- The leak response changes from "wait for expiry" to "automatic family revocation"; membership end
  still kills everything instantly.
- ADR 0006 remains the accepted basis for registration/SSO; its "no refresh machinery in v1" clause
  is superseded by this record upon owner acceptance.

## Verification and adoption

The authorization feature specification gains the refresh-token rules (rotation, reuse → family
revocation, absolute expiry, membership-end cascade) with named tests: `refresh-rotates-single-use`,
`refresh-reuse-revokes-family`, `refresh-expired-refused`, `refresh-revoked-with-membership`,
`access-token-permissions-still-live`. Implemented only after the owner accepts this record.
