/**
 * Architecture boundary enforcement for the six acceptance checks in docs/architecture/testing.md
 * ("Architecture acceptance checks") plus cycle and unresolved-import detection.
 *
 * Design rules this file follows:
 * - One coherent enforcement mechanism (dependency-cruiser) with resolved-path coverage: every
 *   package pattern matches the bare specifier, subpath imports and the resolved `node_modules/...`
 *   form, so renames, deep imports and alternative resolution paths cannot dodge a rule.
 * - Type-only imports count: `tsPreCompilationDeps: "specify"` keeps `import type` dependencies
 *   visible, because a boundary crossed at the type level is still a boundary crossed.
 * - Every rule is proven to be able to fail by a negative fixture in
 *   `tests/architecture/boundary-rules.test.ts`, which runs this same configuration against a
 *   generated violating tree and asserts the rule is reported. That suite also asserts the reverse
 *   direction (a clean reference tree and this repository's own `src/` produce no violation) and that
 *   no rule exists without a fixture, so a rule cannot be added, renamed or silently broken while
 *   `npm run arch` keeps reporting success.
 * - Testing.md's first boundary is split into three named rules so each failure mode reports
 *   separately: framework/driver/client packages, shared infrastructure, and filesystem/process/env.
 */

/** NestJS framework packages (explicitly, not via `@nestjs/*` type imports). */
const NEST_PACKAGE = String.raw`(?:^|[/\\])node_modules[/\\]@nestjs[/\\]|^@nestjs[/\\]`;
/** The `pg` driver, as specifier, subpath import or resolved path. */
const PG_PACKAGE = String.raw`(?:^|[/\\])node_modules[/\\]pg(?:[/\\]|$)|^pg[/\\]?`;
/** Raw HTTP client packages and core HTTP modules. */
const HTTP_CLIENT =
	String.raw`(?:^|[/\\])node_modules[/\\](?:axios|undici|got|superagent|node-fetch)[/\\]|^(?:axios|undici|got|superagent|node-fetch)[/\\]?` +
	"|^(?:node:)?https?$";
/** Filesystem, process and other environment modules: never reachable from domain code. */
const ENVIRONMENT_MODULE = String.raw`^(?:node:)?(?:fs|fs/|path|os|child_process|process|worker_threads|cluster|net|dns)(?:$|/)`;
/** The only places `pg` may be imported: shared persistence plumbing and PostgreSQL repositories. */
const PERSISTENCY_BOUNDARY = String.raw`^src/shared/persistence/|postgres-[^/\\]+\.repository\.ts$`;

const DOMAIN = "^src/features/[^/]+/models/domain/";
const USE_CASE = "^src/features/[^/]+/(?:commands|queries)/";
const CONTROLLER = String.raw`^src/features/[^/]+/(?:controllers|mcp)/|^src/shared/http/`;
const TRANSPORT_CONTRACT = String.raw`^src/features/[^/]+/models/(?:dtos|requests|responses)/`;
const SQL_REPOSITORY = String.raw`^src/features/[^/]+/repositories/`;
const CONCRETE_SQL_ADAPTER = "postgres-[^/\\\\]+\\.repository\\.ts$";
const GATEWAY_ADAPTER = "\\.gateway\\.ts$";

module.exports = {
	options: {
		doNotFollow: {
			path: "node_modules",
			dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-bundled", "npm-no-pkg"]
		},
		externalModuleResolutionStrategy: "node_modules",
		/* Keeps `import type` dependencies visible to the rules above. */
		tsPreCompilationDeps: "specify",
		tsConfig: {
			fileName: "tsconfig.json"
		},
		enhancedResolveOptions: {
			extensions: [".ts", ".cts", ".mts", ".js", ".cjs", ".mjs", ".json"]
		}
	},
	forbidden: [
		{
			name: "domain-no-framework-or-client-dependencies",
			severity: "error",
			comment: "Domain code cannot import NestJS, the pg driver, HTTP clients or other infrastructure packages.",
			from: { path: DOMAIN },
			to: { path: [NEST_PACKAGE, PG_PACKAGE, HTTP_CLIENT] }
		},
		{
			name: "domain-no-environment-or-filesystem",
			severity: "error",
			comment:
				"Domain code has no filesystem, process or network-stack dependency: environment access belongs to shared/config and infrastructure adapters.",
			from: { path: DOMAIN },
			to: { path: ENVIRONMENT_MODULE }
		},
		{
			name: "domain-no-shared-infrastructure",
			severity: "error",
			comment:
				"Domain code cannot import shared technical capabilities (configuration, logging, persistence, HTTP).",
			from: { path: DOMAIN },
			to: { path: "^src/shared/" }
		},
		{
			name: "use-case-no-transport-or-adapter",
			severity: "error",
			comment:
				"Commands and queries import contracts, never controllers, transport DTOs or concrete SQL/gateway adapters.",
			from: { path: USE_CASE },
			to: {
				path: [CONTROLLER, TRANSPORT_CONTRACT, CONCRETE_SQL_ADAPTER, GATEWAY_ADAPTER]
			}
		},
		{
			name: "controller-no-driver-or-repository",
			severity: "error",
			comment:
				"Controllers translate transport to use cases; they cannot import pg, SQL repositories or raw HTTP clients.",
			from: { path: CONTROLLER },
			to: { path: [PG_PACKAGE, HTTP_CLIENT, SQL_REPOSITORY, CONCRETE_SQL_ADAPTER] }
		},
		{
			name: "pg-only-in-persistence-boundary",
			severity: "error",
			comment:
				"The pg driver is restricted to PostgreSQL adapters and shared persistence plumbing (docs/architecture/persistence.md).",
			from: {
				path: "^src/",
				pathNot: PERSISTENCY_BOUNDARY
			},
			to: { path: PG_PACKAGE }
		},
		{
			name: "no-cross-feature-internal-adapters",
			severity: "error",
			comment:
				"Cross-feature access goes through a public contract, never another feature's controller, repository or gateway.",
			from: { path: "^src/features/([^/]+)/" },
			to: { path: String.raw`^src/features/(?!$1/)[^/]+/(?:controllers|mcp|repositories|gateways)/` }
		},
		{
			name: "no-circular-dependencies",
			severity: "error",
			comment:
				"Dependency cycles are rejected; resolve them by clarifying ownership (docs/architecture/structure.md).",
			from: {},
			to: { circular: true }
		},
		{
			name: "no-unresolved-imports",
			severity: "error",
			comment: "Unresolved imports hide typos, missing files and unregistered path aliases.",
			from: {},
			to: { pathNot: "^(?:node:)", couldNotResolve: true }
		}
	]
};
