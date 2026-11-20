# Guidance inventory

## Entry points

- [README.md](README.md): what the server does, quick start, architecture summary and ADR index.
- [AGENTS.md](AGENTS.md): agent working contract, task routing, dependency rules and completion contract.
- [CONTEXT.md](CONTEXT.md): domain glossary (ubiquitous language).
- [Project facts](docs/project-context.md): current baseline, real verification commands and feature composition.
- [docs/AGENTS.md](docs/AGENTS.md): local documentation editing rules.
- [Installation](docs/installation.md): Discord application setup, every environment variable and its origin, run and verify, troubleshooting.

## Architecture and patterns

- [Structure](docs/architecture/structure.md): placement map and dependency boundaries.
- [Features](docs/architecture/features.md): domain, commands, queries and business ownership.
- [REST](docs/architecture/rest.md): HTTP resources, DTOs, errors, pagination and compatibility.
- [Persistence](docs/architecture/persistence.md): PostgreSQL, pg, repositories, transactions and migrations.
- [Shared](docs/architecture/shared.md): technical infrastructure, gateways, configuration and Nest wiring.
- [Conventions](docs/architecture/conventions.md): names, types, imports, formatting and exports.
- [Testing](docs/architecture/testing.md): required verification evidence and architecture boundary checks.
- [Workflow](docs/architecture/workflow.md): agent scope, decisions and evolution.

## Feature specifications

- [Ingestion](docs/features/ingestion.md): Discord → PostgreSQL message ingestion (historical import + Gateway sync + lifecycle mirroring).
- [Semantic index](docs/features/semantic-index.md): embedding pipeline over stored messages (managed provider) and hybrid retrieval contract.
- [Guild state](docs/features/guild-state.md): authoritative permission registry (guild, roles, members, channels/threads, overwrites, thread membership) and effective-permission evaluation.
- [Discord transport](docs/features/discord.md): single Gateway connection, normalized event stream and shared REST call sites; read-only over Discord.
- [Authorization](docs/features/authorization.md): MCP OAuth 2.1 authorization server, Discord SSO, hub sessions and transport authentication; [composition and required configuration](docs/project-context.md#authorization-composition-and-operations).
- [Query](docs/features/query.md): the seven MCP retrieval and status tools with permission enforcement before every response.
- [Session refresh](docs/features/session-refresh.md): rotating refresh tokens with reuse detection (ADR 0009).
- [Query verification](docs/features/query-verification.md): implementation evidence, schema source and composition seams.

## Deployment and operations

- [Semantic index deployment](docs/deployment/semantic-index.md): provider egress disclosure, validated
  settings, opt-in module wiring, lifecycle/catch-up behavior, and explicit model/dimension re-embedding.
- [Session refresh deployment](docs/deployment/session-refresh.md): in-process rate limiting, the
  single-proxy assumption and the shared-store gap for multi-instance deployments.

## Decisions and reusable templates

- [ADR index](docs/adr/README.md).
- [0001 — Layer ownership](docs/adr/0001-layer-ownership.md).
- [0002 — REST contracts](docs/adr/0002-rest-contracts.md).
- [0003 — PostgreSQL without ORM](docs/adr/0003-postgresql-without-orm.md).
- [0004 — MCP as primary transport](docs/adr/0004-mcp-primary-transport.md) (accepted by owner).
- [0005 — Gateway-synced permission state](docs/adr/0005-gateway-synced-permission-state.md) (accepted by owner).
- [0006 — Discord SSO login with dynamic client registration](docs/adr/0006-discord-sso-dynamic-client-registration.md) (accepted by owner).
- [0007 — Mirror the Discord message lifecycle](docs/adr/0007-mirror-message-lifecycle.md) (accepted by owner).
- [0008 — Semantic search in v1: pgvector with a managed embedding API](docs/adr/0008-semantic-search-v1-pgvector.md) (accepted by owner).
- [0009 — Refresh token rotation for long-lived client access](docs/adr/0009-refresh-token-rotation.md) (accepted by owner).
- [ADR template](docs/templates/adr.md).
- [Feature specification template](docs/templates/feature-spec.md).
- [Feature-local AGENTS template](docs/templates/feature-agents.md).
