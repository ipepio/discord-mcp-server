# Contributing

Thanks for considering a contribution. This repository is a self-hosted MCP server that mirrors one
Discord guild into PostgreSQL; it is TypeScript on Node.js, with no ORM and no build step beyond `tsc`.

## Before you start

- Read [AGENTS.md](AGENTS.md) for the architecture contract and [docs/architecture/](docs/architecture/)
  for the guides a change touches (REST, features, persistence, shared infrastructure, conventions,
  testing).
- Open an issue for anything larger than a small fix, so the approach is agreed before you write code.
- For a security problem, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Requirements

- **Node.js >= 22** (`engines` in `package.json`); `npm` ships with it.
- **Docker** and **Docker Compose**, only if you want a local PostgreSQL. Unit and architecture tests
  need no external service.
- No globally installed tooling: every command below runs a local dependency.

## Development setup

```bash
git clone <this repository>
cd discord-mcp-server
npm ci                     # installs exactly what package-lock.json pins
cp .env.example .env       # then fill in the placeholders
```

`.env` is git-ignored and must never be committed. `.env.example` documents the complete environment
contract: every variable the application reads at startup, with placeholders and the accepted values.

### Database

The compose file runs PostgreSQL 16 with the `pgvector` extension and deliberately does **not** publish
port 5432 to the host:

```bash
docker compose up -d postgres
docker compose run --rm app sh -c "npm ci && npm run migrate"   # schema, an explicit step
```

Migrations are never applied at application startup; they are an operator step and the files are
append-only. `npm run migrate:undo` reverses the most recent one.

## Gates

Run these before opening a pull request. Each one is a `package.json` script; CI runs the same set and
adds the integration suite.

```bash
npm run format      # prettier --write over the repository's formatted file list
npm run lint        # eslint
npm run arch        # dependency-cruiser: the architecture boundaries and cycles
npm run typecheck   # tsc --noEmit for src and tests
npm test            # vitest unit, contract, fixture and architecture suites
```

`npm run format` writes; CI runs `prettier --check` over the same file list, so a formatting gate that
passes locally passes there. Never hand-edit formatting to satisfy a tool: run the script.

`npm run build` (emits `dist/`) and `npm run migrate` are not part of the gate list but must keep
working when you touch `tsconfig.json` or `migrations/`.

### Integration tests

The PostgreSQL-backed suite is separate because it needs a real database:

```bash
npm run test:integration   # requires TEST_DATABASE_URL
```

`TEST_DATABASE_URL` is required and never defaulted, because a harness that silently reused an
installation's own database could truncate real permission state. Each suite creates its own database
on that server, applies the migrations into it, and drops it afterwards, so the role in the URL must be
able to `CREATE DATABASE`. Without the variable the suites print an `UNAVAILABLE` banner and skip:
skipped is not passed.

Against a local container with a published port (useful from the host):

```bash
docker run --rm -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=discord_hub -p 5432:5432 pgvector/pgvector:pg16

TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/discord_hub npm run test:integration
```

Inside the compose network, where the service host name is `postgres`, use the compose service itself:

```bash
docker compose run --rm \
  -e TEST_DATABASE_URL=postgres://user:password@postgres:5432/discord_hub \
  app sh -c "npm ci && npm run test:integration"
```

## Commits

[Conventional Commits](https://www.conventionalcommits.org/) with a type, an optional scope and an
imperative subject:

```text
feat(ingestion): bound the resync walk per channel
fix(authorization): refuse an expired session on the token endpoint
docs(installation): state the pgvector requirement
```

- Types in use: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `perf`.
- Mention a breaking change with `!` after the type/scope and explain it in the body.
- One logical change per commit; keep tests and the code they cover in the same commit.
- No commit-message linter runs in this repository yet: the convention is reviewed, not enforced by a
  hook. Do not add one in an unrelated pull request.

Never commit `.env`, credentials, bot tokens, database dumps or machine-specific agent state (`.pi/`
and `.atl/` are ignored for that reason).

## Pull requests

- Keep it focused: one behaviour change, or one documentation correction. Unrelated refactors make a
  review slower and hide the change that matters.
- Say what you ran: paste the gate results, and name any check you skipped and why.
- New behaviour needs a test at the level that observes it, and existing behaviour your change affects
  must still be covered.
- When an external contract changes, update the OpenAPI document and the relevant guide under
  `docs/`. A new architectural exception needs a decision record under `docs/adr/`; an agent-authored
  ADR is a proposal, not an approval.
- Do not add dependencies, or change the architecture, in a pull request that is not explicitly about
  that decision.
- Follow the existing patterns. Do not introduce a base class, a generic CRUD layer, a CQRS bus, an
  alternative transport or an ORM without agreement first.

## Reporting problems

Use the issue tracker for bugs and feature requests. For anything that could expose data or
credentials, use the private channel in [SECURITY.md](SECURITY.md).

## License

Contributions are accepted under the MIT License in [LICENSE](LICENSE).
