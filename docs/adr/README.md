# Architecture decision records

ADRs record significant decisions, alternatives and consequences. They do not replace feature
specifications or tests, and creating one does not authorize implementation.

## Baseline decisions

| ADR | Status | Decision |
| --- | --- | --- |
| [0001 — Layer ownership](0001-layer-ownership.md) | Accepted baseline | Feature-based NestJS shell; framework-free use cases/domain |
| [0002 — REST contracts](0002-rest-contracts.md) | Accepted by owner | REST when exposing HTTP; OpenAPI documents the contract |
| [0003 — PostgreSQL without ORM](0003-postgresql-without-orm.md) | Accepted by owner | pg behind explicit repositories for this template |

## Project decisions

| ADR | Status | Decision |
| --- | --- | --- |
| [0004 — MCP as primary transport](0004-mcp-primary-transport.md) | Accepted by owner | MCP Streamable HTTP is the only functional external contract; REST/OpenAPI applies to auxiliary endpoints only |
| [0005 — Gateway-synced permission state](0005-gateway-synced-permission-state.md) | Accepted by owner | Authorization evaluates effective permissions from Gateway-synced PostgreSQL state, never per-query Discord REST and never a TTL cache |
| [0006 — Discord SSO login with dynamic client registration](0006-discord-sso-dynamic-client-registration.md) | Accepted by owner | MCP clients log in via OAuth 2.1 PKCE with Discord SSO and self-register; Discord tokens stay server-side |
| [0007 — Mirror the Discord message lifecycle](0007-mirror-message-lifecycle.md) | Accepted by owner | Edits update stored content; deletions tombstone and exclude messages from every query path; no archive mode in v1 |
| [0008 — Semantic search in v1: pgvector with a managed embedding API](0008-semantic-search-v1-pgvector.md) | Accepted by owner | Decoupled embedding pipeline over stored messages, hybrid FTS+vector retrieval, four testable ACL invariants |
| [0009 — Refresh token rotation for long-lived client access](0009-refresh-token-rotation.md) | Accepted by owner | OAuth 2.1 refresh grant with single-use rotation, 30-day absolute expiry, and reuse-detection family revocation |

Baseline records preserve the agreed direction; details in the linked guides operationalize it.
Application-specific choices not made by the owner remain open in [project context](../project-context.md).
No executable implementation is implied by accepted documentation.

## Lifecycle

1. Copy [the ADR template](../templates/adr.md) to the next unused `NNNN-short-decision.md`.
2. Keep status `Proposed` while a consequential decision is unresolved. Include alternatives and costs.
3. Record explicit owner acceptance before relying on an architectural exception or business choice.
4. Link accepted records from the feature specification/local instructions and this index.
5. To change an accepted decision, create a successor and mark the predecessor superseded with a link.
   Preserve the historical reasoning; do not silently rewrite it to match current code.

Use ADRs for significant business policy or architectural trade-offs. Routine behavior belongs in
specifications/tests; routine use of an existing pattern does not require another ADR. A business ADR
cannot implicitly authorize changing the global architecture, dependencies or persistence strategy.
