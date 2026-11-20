# 0006 — Discord SSO login with dynamic client registration

- Status: Accepted by owner
- Scope: Security / authentication
- Owner: Project owner
- Acceptance evidence: "La idea es que el cliente mcp, si no tiene login, que muestre una url, esta
  url va contra un oauth que es un SSO con discord en el backend." and "se isntala el mcp. pone el
  dominio [...] se logea con la conf. y si su usuario de discord tiene acceso al server dónde
  apunta, ya está, no?" (sic, verbatim; sic preserved)
- Supersedes: none

## Context

Connecting a new MCP client must require no operator-side client setup: install the client, enter
the hub URL, log in with Discord, and guild membership decides access. The MCP authorization model
is OAuth 2.1 based; an unknown client needs a way to obtain client credentials at first connect.
The owner also stated future intent (not v1 scope): an installation script or a packaged build with
its own configuration.

## Decision

The hub implements the MCP authorization flow: OAuth 2.1 authorization code with PKCE, acting as
its own authorization server, with Discord as the upstream identity provider (SSO). Clients obtain
credentials through dynamic client registration (RFC 7591), so any standard MCP client connects by
entering the hub URL alone. After the Discord login, the backend verifies the user's identity and
guild membership against the Gateway-synced state ([ADR 0005](0005-gateway-synced-permission-state.md))
and issues its own session token to the MCP client. Discord access tokens remain server-side; MCP
clients never receive them.

## Alternatives

- Pre-registered clients in operator configuration: rejected for v1 — it adds a per-client
  configuration step to a product whose stated UX is "put the domain and log in"; may be revisited
  later if deployment feedback demands it.
- Static personal tokens: rejected — no standard client flow, manual revocation, contradicts the
  owner's Discord OAuth2 direction.

## Consequences

- The authorization server surface (metadata discovery, registration, authorize, token) is part of
  the v1 security scope and needs its own tests.
- Session tokens are hub-issued; their format, lifetime and revocation are feature-specification
  details, not owner decisions.
- Operator per-client configuration is not required; the operator still owns the Discord
  application, guild configuration and secret material.

## Verification and adoption

The authorization feature specification must test the full flow (discovery, registration, PKCE,
Discord callback, membership check, session issuance, client receives only hub tokens) plus negative
cases (non-member user, tampered callback, expired session) against isolated infrastructure.
