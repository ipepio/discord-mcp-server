# 0002 — REST when exposing HTTP

- Status: Accepted by owner
- Scope: Architecture / external contracts
- Acceptance evidence: "me refiero que cuando se exponga una api, esta sea api-rest".

## Context

The owner clarified that REST governs exposed HTTP APIs, not every internal call or database access.
Agents must not independently substitute GraphQL, RPC-style endpoint collections or a self-calling
HTTP service topology. A worker may legitimately have no exposed HTTP API.

## Decision

Use REST resource/method semantics and explicit OpenAPI contracts whenever HTTP is exposed.
Keep controllers thin and separate transport DTOs from use-case inputs and domain models.
[The REST guide](../architecture/rest.md) defines the template's response, validation, pagination and
error baseline. It does not imply implemented endpoints.

## Alternatives and consequences

GraphQL or another transport can fit specific requirements, but is not a default agent choice here;
a justified exception needs acceptance. Internal feature calls remain ordinary use-case/contract calls.
REST is not a mandate for CRUD-only business behavior. Access control and API versioning policies
remain explicit project decisions before protected behavior or public release.
