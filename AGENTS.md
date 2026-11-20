# Backend agent working contract

Adapt to this repository's architecture. Do not redesign it to match an agent's preferred framework,
folder layout or dependency stack. This is a working NestJS + PostgreSQL application with real
source, migrations, tests and gates; a change is authorized by the request you were given, not by the
existence of a guide that describes it.

## Start here

1. Read the project request and this file.
2. Read [architecture and placement](docs/architecture/structure.md).
3. Read the task-relevant guide below and the nearest local `AGENTS.md`, if present.
4. Read accepted [ADRs](docs/adr/README.md) and the feature's specification before implementation.
5. Inspect a neighboring implementation. Preserve its contract unless the requested change alters it.

| Task                                                  | Required guide                                     |
| ----------------------------------------------------- | -------------------------------------------------- |
| HTTP endpoint or external contract                    | [REST](docs/architecture/rest.md)                  |
| Command, query or business rule                       | [Feature patterns](docs/architecture/features.md)  |
| SQL, repositories or transactions                     | [Persistence](docs/architecture/persistence.md)    |
| External API, common infrastructure or Nest wiring    | [Shared and gateways](docs/architecture/shared.md) |
| Naming, types, errors or configuration                | [Conventions](docs/architecture/conventions.md)    |
| Verification                                          | [Testing](docs/architecture/testing.md)            |
| Delivery, documentation or an architectural exception | [Workflow](docs/architecture/workflow.md)          |

Current project facts, the real verification commands and the feature composition notes live in
[docs/project-context.md](docs/project-context.md).

## Fixed baseline

- NestJS for the application shell; business logic must not depend on NestJS.
- MCP over Streamable HTTP is the only functional external contract
  ([ADR 0004](docs/adr/0004-mcp-primary-transport.md)). REST with OpenAPI is limited to auxiliary
  operational endpoints such as health ([ADR 0002](docs/adr/0002-rest-contracts.md)).
- PostgreSQL for persistence; direct SQL through `pg`, **no ORM**
  ([ADR 0003](docs/adr/0003-postgresql-without-orm.md)).
- Explicit repository contracts for the application's own database; gateways for external systems.
- Feature-based organization, commands for writes, queries for reads and explicit mappers.
- TypeScript ESM/NodeNext; explicit Nest injection tokens and factory wiring.
- The six features and their owned responsibilities are summarized in [README](README.md#how-it-is-built).

## Dependency rules

```text
HTTP controller / event consumer / scheduled adapter
                         |
                         v
                  command or query
                         |
                         v
             domain + repository/gateway contracts
                         ^
                         |
        SQL repository / external API gateway implementations

Nest feature module = composition root that wires these objects
```

- Controllers never access SQL, the connection pool or external HTTP clients directly.
- Commands and queries never import transport DTOs, ORM/driver types or Nest HTTP exceptions.
- Domain code has no NestJS, `pg`, HTTP, environment or filesystem dependencies.
- A repository owns SQL and row mapping, not the business workflow.
- A gateway owns an external system's protocol, not cross-feature business policy.
- A feature exposes intentional public use cases/contracts, not its internal repository implementation.
- Only composition modules wire concrete adapters. Avoid dependency cycles and broad internal barrels.
- Never bypass these rules with dynamic imports, path aliases, type casts or lint suppression.

## Before changing code

- Establish the requested behavior and acceptance examples. Ask only about consequential uncertainty.
- Choose the owning feature and the smallest necessary change; do not refactor unrelated code.
- Reuse the documented pattern. Do not introduce a base class, generic CRUD framework, CQRS bus,
  microservice, ORM, dependency or alternative transport without approval.
- Add only the files needed by actual behavior.
- New configuration means a name and validator under `src/shared/config/`, a placeholder in
  `.env.example` and a row in the environment-variable tables of [installation](docs/installation.md).
- Document a proposed exception before implementation; an agent-authored ADR is not owner approval.

## Completion contract

For an authorized change: verify the behavior through its public interface; cover affected existing
behavior; update OpenAPI and the relevant guides when a contract changes; update the ADR or feature
specification when a decision changes; run the repository's checks and report what you observed.

- `npm run format` — Prettier over `src`, `tests`, `migrations` and the root configuration files.
  Rewrites in place.
- `npm run lint`, `npm run arch`, `npm run typecheck`, `npm test` — static, dependency-boundary, type
  and unit gates. They need no external services.
- `npm run build` — emits `dist/` from `src`.
- `npm run test:integration` — needs a reachable PostgreSQL 16 with pgvector through an explicitly
  supplied `TEST_DATABASE_URL`; without it the run reports missing integration evidence instead of
  passing silently.
- `npm run migrate` / `npm run migrate:undo` — the schema is an explicit operator step, never applied
  at application startup. Migration files are append-only: ship a new one instead of editing an
  applied one.

Report the commands you actually ran, their results and anything you could not run. Never describe a
gate as passing because this document says it exists, and never hide a failing gate behind a skipped
test or an unavailable service.
