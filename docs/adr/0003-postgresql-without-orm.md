# 0003 — PostgreSQL and explicit repositories, no ORM

- Status: Accepted by owner
- Scope: Persistence
- Acceptance evidence: "yo tiraría sin ORM y con repositorios bien definidos tbh" and
  "Depende para que, en este caso PostgreSQL".

## Context

The source integration repository persists through external APIs and has no ORM or database client.
Its gateway boundaries are useful precedent, but its code cannot establish a SQL convention that
does not exist. The owner explicitly chose direct database access without an ORM and PostgreSQL for
this template. PostgreSQL is not declared mandatory for every future project regardless of need.

## Decision

When an application based on this template needs its own persistence, use PostgreSQL through `pg`
behind explicit feature repository contracts. Repositories own parameterized SQL, row mapping,
expected constraint translation and persistence details. Use cases do not see SQL or driver types.
Gateways remain the separate boundary for external systems.

Follow [the persistence guide](../architecture/persistence.md) for pooling, transaction boundaries,
exact values, append-only migrations and isolated integration tests. Database-specific choices that
are not fixed there must be resolved when the actual requirement arises.

## Alternatives and consequences

An ORM could reduce routine CRUD/mapping code, but adds another abstraction and is not the chosen
baseline. SQL repositories require explicit queries, mapping and real database tests; type annotations
alone cannot verify SQL. Do not add Prisma, TypeORM, Sequelize or another ORM without accepted change.

Migration tooling and database provisioning are future implementation choices. This Markdown-only
template creates no database, installs no driver and runs no migration. Ordinary application startup
must not silently apply production schema changes.
