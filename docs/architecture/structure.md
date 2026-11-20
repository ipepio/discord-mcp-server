# Architecture and placement

Organize by business feature, keep infrastructure behind contracts and compose dependencies in Nest
modules. The following paths describe **future placement**, not existing code or an instruction to
create empty directories.

```text
src/
  main.ts                       bootstrap only
  app.module.ts                 application composition
  shared/
    config/                     validated technical configuration
    context/                    request/correlation context
    errors/                     transport error translation
    http/                       shared HTTP transport configuration
    logging/                    structured logging adapters
    persistence/                pool, transaction plumbing and migration integration
  features/
    <feature>/
      AGENTS.md                 feature ownership and invariants
      <feature>.module.ts       feature composition
      controllers/              REST adapters
      commands/                 write use cases and their input contracts
      queries/                  read use cases and their input contracts
      models/
        domain/                 business representations and invariants
        dtos/                   external wire representations when needed
        requests/               REST input DTOs
        responses/              REST output DTOs
        mappers/                boundary conversions
      repositories/
        <feature>.repository.ts contract
        postgres-<feature>.repository.ts implementation
      gateways/
        <system>.gateway.ts     external-system adapter
        <system>.gateway.interface.ts contract when an application seam needs one
      index.ts                  intentional public feature surface, if needed
migrations/                     append-only SQL schema changes, once implemented
tests/                          package-root tests mirroring feature paths
```

A command can contain its own `.request.ts` application input alongside the command, following the
source repo. This is not a REST request DTO: it must not depend on HTTP validation decorators.

## Placement decisions

| Need | Owner |
| --- | --- |
| HTTP validation, status or response serialization | Controller + request/response DTO + mapper |
| A write workflow | Command with `execute(input)` |
| A read workflow | Query with `execute(input)` |
| Business invariant used by multiple use cases | Owning feature's domain model or focused domain policy |
| SQL for the application's database | Feature PostgreSQL repository |
| External REST endpoint or protocol | Gateway; external DTOs stay with their owner |
| Pure conversion | Mapper; no I/O |
| Global pool/logging/configuration plumbing | Appropriate `shared` capability |
| Business capability used by another feature | Owning feature's public contract; not `shared` |

## Boundaries, not extra layers

Repositories contain both contracts and implementations for navigability; this co-location does not
permit commands to import `postgres-*`. They import only the contract. The feature module imports
implementations to wire them. Future lint rules must distinguish these files.

Do not add a generic `services/` bucket. A focused domain service is appropriate only when an actual
business rule does not naturally belong to a model or use case. Name it for that responsibility.

Do not force every domain model into a class: the source uses both plain types and readonly classes.
Use constructors/factories when invariants require them; preserve the neighboring feature's style.
Do not create a mapper for a conversion that does not exist or a repository for a feature with no DB.

Cross-feature calls go through an intentional public use case or contract, never another feature's
controller, SQL adapter or internal table. Resolve cycles by clarifying ownership, not by defaulting
to Nest `forwardRef` or moving the code to `shared`.
