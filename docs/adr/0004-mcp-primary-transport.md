# 0004 — MCP Streamable HTTP as the primary external transport

- Status: Accepted by owner
- Scope: Architecture / external contracts
- Owner: Project owner
- Acceptance evidence: Owner direction during design interview: "entonces te diría que mcp solo, no?";
  final confirmation of the decision and the auxiliary-endpoints nuance: owner selected
  "Confirmo todo, incluido ADR 0004" (2026-11-04).
- Supersedes: none. Narrows the applicable scope of [0002](0002-rest-contracts.md); does not replace it.

## Context

Discord MCP Server exposes an MCP server over Streamable HTTP so any MCP-compatible client can query
Discord data. MCP is a JSON-RPC-based protocol whose tool contracts are described by JSON Schema
documents defined by the MCP specification itself; it is not a REST resource model and is not
documented by OpenAPI. [ADR 0002](0002-rest-contracts.md) says REST + OpenAPI whenever HTTP is
exposed, so every feature specification needs to know which contract type it documents.

The owner additionally stated the future intent that an internal web panel ("tipo chatgpt") also
consume the service; the initial scope still excludes any frontend, so the panel is a future MCP
client, not a v1 deliverable.

## Decision

MCP over Streamable HTTP is the product's only functional external contract. The REST/OpenAPI
baseline of [ADR 0002](0002-rest-contracts.md) remains in force exclusively for auxiliary
operational HTTP endpoints: health/readiness probes used by Docker Compose or load balancers, and
any future administrative endpoint. Such endpoints keep the explicit access classification required
by ADR 0002.

The MCP surface is documented by MCP-specification artifacts: the server/tool list and per-tool
input/output JSON Schemas. How these artifacts are organized in this repository is decided with the
first feature specification. Clients authenticate through the MCP authorization model (OAuth2);
the future web panel is just another registered MCP client, so no second API is created for it.

## Alternatives

- Treat MCP as an unrecorded exception: rejected — the repo workflow requires recorded owner
  acceptance for architectural exceptions.
- Keep REST+OpenAPI as the only documented contract and describe MCP tools ad hoc outside the
  guides: rejected — it splits contract documentation across two standards with no owning guide.
- Expose a parallel REST API for the future panel: rejected — it would duplicate the authorization
  and ACL boundary and contradicts the owner's direction of a single integrated backend.

## Consequences

- Feature specifications document MCP tool contracts (not REST resources) for product behavior;
  the REST guide continues to govern auxiliary endpoints only.
- No OpenAPI document is produced for the MCP surface; consumers rely on MCP discovery
  (`tools/list`) and the tool schemas.
- The future panel never becomes a reason to add a second API; its access goes through the same
  OAuth2 and per-user ACL boundary as any other client.
- Transport adapters (MCP and auxiliary REST) remain thin adapters with no SQL and no business
  logic; layer rules from [ADR 0001](0001-layer-ownership.md) are unchanged.

## Verification and adoption

The owner accepted the decision and the auxiliary-endpoints nuance on 2026-11-04. The first feature
specification is expected to demonstrate the contract documentation approach it defines.
