# Verification and future enforcement

This is a documentation-only template: there is no test runner, ESLint configuration or CI workflow.
The rules below specify what an authorized application setup must implement; they are not evidence
that those protections already exist.

## Test the responsibility

| Check | Evidence it must provide |
| --- | --- |
| Domain/use-case tests | Business rules, outputs, errors and exact intended side effects |
| Mapper tests | Contract casing, optional/null fields and value conversion |
| Repository integration | Real SQL, constraints, mapping, ordering and transaction atomicity |
| Gateway tests | Outgoing contract, external failures and response validation |
| REST/e2e tests | Input validation, status/body/headers, error format and access policy |
| Nest module smoke test | Providers resolve and a real handler instance is wired |
| Architecture checks | Forbidden dependencies actually fail, not just clean code passing |

Prefer deterministic tests at the nearest useful public boundary. Mock repository/gateway contracts
for use-case tests, not their implementation internals. Inject time/ID sources when determinism needs
them; do not invent wrappers for every standard-library call.

For behavior changes, observe a failing regression test before the fix when meaningful, then the
passing test and relevant existing tests. Include rejection behavior and assert that invalid input
has not performed prohibited writes. Avoid tests that only repeat implementation details.

## Database safety

Use a dedicated PostgreSQL test database or isolated schema with an explicitly supplied test
connection. Confirm isolation before setup/cleanup. Never infer that an arbitrary `DATABASE_URL` is
safe to truncate. Close pools and clean only resources the test owns. Missing database access must
be reported as missing integration evidence, not hidden with skipped tests counted as success.

## Architecture acceptance checks

When executable setup is authorized, implement import/dependency rules with negative fixtures:

- Domain cannot import NestJS, `pg`, HTTP clients, configuration or infrastructure.
- Commands/queries cannot import controllers, transport DTOs or concrete SQL/gateway adapters.
- Controllers cannot import `pg`, SQL repositories or raw HTTP clients.
- `pg` imports are restricted to PostgreSQL adapters and shared persistence plumbing.
- Cross-feature calls cannot import another feature's internal adapters.
- Detect cycles and unresolved imports; check alternative paths and aliases as well as package names.

Use one coherent enforcement mechanism with resolved-path coverage. A few fragile relative-import
patterns are not proof of layer protection. Test that deliberately violating each boundary fails.
An agent may propose tooling for an authorized setup, not install it during a documentation task.

## CI and completion

The future application's CI should run its real formatter, lint/architecture checks, typecheck,
build, unit/contract tests and isolated integration checks. Database changes need repository/migration
proof; authentication changes need access-control proof. Do not add unrelated infrastructure.

Pin tool/runtime versions and commit the package-manager lockfile when setup is authorized. Record
actual script names in [project context](../project-context.md); do not assume commands exist because
the original integration monorepo used pnpm/Turbo/Jest.

Coverage can reveal gaps but does not prove requirements. Thresholds must be agreed and actually
executed in CI before being claimed as enforced. Do not copy unreachable thresholds or hide missing
tests behind `--passWithNoTests` as a quality guarantee.

For Markdown-only changes, verify links, consistency, scope and any examples that are executable.
Do not install an application test stack to validate prose. Report precisely what ran and what did not.
