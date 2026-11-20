# Agent workflow and decision ownership

The human owns scope and product decisions. The agent fits the implementation to the documented
architecture, rather than turning every task into a redesign.

## Per-task workflow

1. Read root/local instructions, project context, relevant ADRs and the requested feature behavior.
2. Inspect the owner and one analogous implementation. Identify which rules are stable versus local
   anomalies; do not copy a known defect just because it exists.
3. Resolve only consequential uncertainty. Do not ask the owner to choose routine filenames already
   settled here; do ask about missing business behavior, contract changes or destructive operations.
4. State the affected feature/boundaries. For substantial work, record acceptance examples and scope
   using the [feature specification](../templates/feature-spec.md).
5. Implement only when authorized. Keep tests, wiring and contract documentation alongside behavior.
6. Run actual applicable checks and inspect the resulting diff. Do not suppress a rule to get green.
7. Report behavior delivered, evidence, missing checks and remaining decisions. Never invent a pass.

## Decision hierarchy

- The owner's explicit current request controls task scope; this template never authorizes extra work.
- Accepted architectural decisions define the baseline. If a request appears to conflict, surface the
  specific conflict before changing architecture; a business ADR does not silently override the baseline.
- Local instructions refine feature-specific constraints, not cancel global dependency boundaries.
- Specifications define behavior; tests check it. ADRs explain significant decisions and trade-offs.
- A proposed ADR is not accepted by virtue of an agent creating it. Architectural exceptions and
  consequential business choices require explicit owner acceptance recorded in the ADR.

## Avoid unnecessary artifacts

Routine implementations within existing patterns do not need new ADRs. A simple field addition does
not need a new architectural layer. Add a local `AGENTS.md` only when it contributes feature-specific
knowledge, using [the local template](../templates/feature-agents.md).

Do not initialize Git, create branches/commits, publish, deploy or migrate data solely because this
template was copied. Follow the actual project's delivery policy and explicit authorizations.
Do not create source/configuration during a documentation-only task.

## Adopting or evolving the baseline

Record the template revision/provenance in project context. Copying the documents establishes a
starting point, not an automatic update subscription. Later improvements need an explicit diff review:
never overwrite project-specific business decisions or apply architecture migrations silently.

Before a public API or production deployment, fill the unresolved project decisions in project
context: access policy, API compatibility/versioning, operational configuration and actual check
commands. These are explicit project decisions, not license for an agent to invent requirements.
