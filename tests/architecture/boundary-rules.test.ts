/**
 * Negative fixtures for every boundary rule configured in `.depcruiser.cjs`.
 *
 * Requirement being tested (docs/architecture/testing.md, "Architecture acceptance checks"):
 * "Test that deliberately violating each boundary fails" — a rule that cannot fail is not evidence.
 * Each case below writes a tree that violates exactly one documented boundary, runs the repository's
 * real dependency-cruiser configuration against it and asserts that the rule IS reported. The
 * expected rule set is asserted exactly, so a rule that silently stops matching (renamed pattern,
 * typo, dependency-cruiser upgrade changing resolution) fails this suite instead of passing vacuously.
 *
 * The six documented boundaries map to the rules as follows:
 *   1. domain cannot import NestJS/pg/HTTP clients/configuration/infrastructure
 *      -> domain-no-framework-or-client-dependencies, domain-no-shared-infrastructure,
 *         domain-no-environment-or-filesystem
 *   2. commands/queries cannot import controllers, transport DTOs or concrete SQL/gateway adapters
 *      -> use-case-no-transport-or-adapter
 *   3. controllers cannot import pg, SQL repositories or raw HTTP clients
 *      -> controller-no-driver-or-repository
 *   4. pg imports are restricted to PostgreSQL adapters and shared persistence
 *      -> pg-only-in-persistence-boundary
 *   5. cross-feature calls cannot import another feature's internal adapters
 *      -> no-cross-feature-internal-adapters
 *   6. cycles and unresolved imports are detected, including alternative resolution paths
 *      -> no-circular-dependencies, no-unresolved-imports (+ the `*-deep-*` package-path cases)
 */

import { afterAll, describe, expect, it } from "vitest";
import {
	BASELINE_TREE,
	REPO_ROOT,
	clearFixtures,
	configuredRuleNames,
	cruiseTree,
	removeFixture,
	reported,
	source,
	withBaseline,
	writeFixture
} from "./architecture-harness.js";
import type { CruiseRun, FixtureTree } from "./architecture-harness.js";

/** One deliberately violating edge inside a fixture tree. */
interface ExpectedEdge {
	readonly rule: string;
	readonly from: string;
	readonly to: string;
}

interface BoundaryCase {
	readonly id: string;
	readonly boundary: string;
	readonly tree: FixtureTree;
	readonly edges: readonly ExpectedEdge[];
}

const DOMAIN_MESSAGE = "src/features/messages/models/domain/message.ts";
const CONFIRM_COMMAND = "src/features/messages/commands/confirm-message.command.ts";
const MESSAGE_EXPORT_QUERY = "src/features/messages/queries/message-export.query.ts";
const MESSAGES_CONTROLLER = "src/features/messages/controllers/messages.controller.ts";
const RESPONSE_MAPPER = "src/features/messages/models/mappers/message.response-mapper.ts";
const GUILD_MODULE = "src/features/guild-state/guild-state.module.ts";
const TEXT_DESCRIPTION = "src/features/messages/models/domain/text-description.ts";

/**
 * Each tree is the clean baseline with one violating file added or rewritten; everything else in the
 * tree stays legitimate, so a reported violation cannot be an artefact of a broken fixture.
 */
const BOUNDARY_CASES: readonly BoundaryCase[] = [
	{
		id: "mcp-adapter-imports-repository",
		boundary: "3 — MCP adapters obey the same transport boundary as REST controllers",
		tree: withBaseline({
			"src/features/messages/mcp/messages.adapter.ts": source(
				'import { PostgresMessageRepository } from "../repositories/postgres-message.repository.js";',
				"export const invalid = PostgresMessageRepository;"
			)
		}),
		edges: [
			{
				rule: "controller-no-driver-or-repository",
				from: "src/features/messages/mcp/messages.adapter.ts",
				to: "repositories/postgres-message.repository.ts"
			}
		]
	},
	{
		id: "domain-imports-nestjs",
		boundary: "1 — domain cannot import NestJS",
		tree: withBaseline({
			[DOMAIN_MESSAGE]: source(
				'import { Injectable } from "@nestjs/common";',
				"",
				"@Injectable()",
				"export class Message {",
				"\tpublic static fromText(text: string): Message {",
				"\t\treturn new Message();",
				"\t}",
				"}"
			)
		}),
		edges: [{ rule: "domain-no-framework-or-client-dependencies", from: DOMAIN_MESSAGE, to: "@nestjs/common" }]
	},
	{
		id: "domain-imports-pg",
		boundary: "1 — domain cannot import the pg driver (type-only import still crosses the boundary)",
		tree: withBaseline({
			[DOMAIN_MESSAGE]: source(
				'import type { Pool } from "pg";',
				"",
				"export interface MessageDraft {",
				"\treadonly pool?: Pool;",
				"}"
			)
		}),
		edges: [
			{ rule: "domain-no-framework-or-client-dependencies", from: DOMAIN_MESSAGE, to: "node_modules/pg" },
			{ rule: "pg-only-in-persistence-boundary", from: DOMAIN_MESSAGE, to: "node_modules/pg" }
		]
	},
	{
		id: "domain-imports-http-client",
		boundary: "1 — domain cannot import HTTP clients",
		tree: withBaseline({
			[DOMAIN_MESSAGE]: source(
				'import { request } from "node:http";',
				'import { get } from "node:https";',
				"",
				"export const transport = { request, get };"
			)
		}),
		edges: [
			{ rule: "domain-no-framework-or-client-dependencies", from: DOMAIN_MESSAGE, to: "http" },
			{ rule: "domain-no-framework-or-client-dependencies", from: DOMAIN_MESSAGE, to: "https" }
		]
	},
	{
		id: "domain-imports-http-client-package",
		boundary: "1 — domain cannot import an HTTP client package (resolved node_modules path, not only a bare name)",
		tree: withBaseline({
			/* A vendored client package so the fixture proves the resolved-path branch without adding a
			   dependency to this repository. Only the axios boundary is under test here. */
			"node_modules/axios/package.json": '{ "name": "axios", "version": "0.0.0", "main": "index.js" }\n',
			"node_modules/axios/index.js": "export default { get() {} };\n",
			[DOMAIN_MESSAGE]: source('import axios from "axios";', "", "export const client = axios;")
		}),
		edges: [{ rule: "domain-no-framework-or-client-dependencies", from: DOMAIN_MESSAGE, to: "node_modules/axios" }]
	},
	{
		id: "domain-imports-environment",
		boundary: "1 — domain cannot import the filesystem, process or the network stack",
		tree: withBaseline({
			[DOMAIN_MESSAGE]: source(
				'import { readFile } from "node:fs/promises";',
				'import { hostname } from "node:os";',
				"",
				"export const io = { readFile, hostname };"
			)
		}),
		edges: [
			{ rule: "domain-no-environment-or-filesystem", from: DOMAIN_MESSAGE, to: "fs/promises" },
			/* Core modules are reported by dependency-cruiser without the `node:` prefix. */
			{ rule: "domain-no-environment-or-filesystem", from: DOMAIN_MESSAGE, to: "os" }
		]
	},
	{
		id: "domain-imports-configuration",
		boundary: "1 — domain cannot import configuration",
		tree: withBaseline({
			[DOMAIN_MESSAGE]: source(
				'import { loadAppConfig, readProcessEnv } from "../../../../shared/config/config.factory.js";',
				"",
				"export const settings = loadAppConfig(readProcessEnv());"
			)
		}),
		edges: [
			{
				rule: "domain-no-shared-infrastructure",
				from: DOMAIN_MESSAGE,
				to: "src/shared/config/config.factory.ts"
			}
		]
	},
	{
		id: "domain-imports-infrastructure",
		boundary: "1 — domain cannot import infrastructure (persistence plumbing)",
		tree: withBaseline({
			[DOMAIN_MESSAGE]: source(
				'import { createPgPool } from "../../../../shared/persistence/pg-pool.factory.js";',
				"",
				"export const pool = createPgPool();"
			)
		}),
		edges: [
			{
				rule: "domain-no-shared-infrastructure",
				from: DOMAIN_MESSAGE,
				to: "src/shared/persistence/pg-pool.factory.ts"
			}
		]
	},
	{
		id: "command-imports-transport-and-adapters",
		boundary: "2 — a command cannot import controllers, transport DTOs or concrete adapters",
		tree: withBaseline({
			/* A new use case file: nothing in the tree imports it, so the only possible violation here is
			   the one under test (no accidental cycle with the controller it reaches for). */
			[CONFIRM_COMMAND]: source(
				'import { MessagesController } from "../controllers/messages.controller.js";',
				'import type { MessageCountResponse } from "../models/responses/message-count.response.js";',
				'import type { CreateMessageRequest } from "../models/requests/create-message.request.js";',
				'import { PostgresMessageRepository } from "../repositories/postgres-message.repository.js";',
				'import { DiscordGateway } from "../gateways/discord.gateway.js";',
				"",
				"export class ConfirmMessageCommand {",
				"\tpublic readonly wiring = { MessagesController, PostgresMessageRepository, DiscordGateway };",
				"",
				"\tpublic execute(request: CreateMessageRequest): MessageCountResponse {",
				"\t\treturn request as unknown as MessageCountResponse;",
				"\t}",
				"}"
			)
		}),
		edges: [
			{
				rule: "use-case-no-transport-or-adapter",
				from: CONFIRM_COMMAND,
				to: "controllers/messages.controller.ts"
			},
			{
				rule: "use-case-no-transport-or-adapter",
				from: CONFIRM_COMMAND,
				to: "responses/message-count.response.ts"
			},
			{
				rule: "use-case-no-transport-or-adapter",
				from: CONFIRM_COMMAND,
				to: "requests/create-message.request.ts"
			},
			{
				rule: "use-case-no-transport-or-adapter",
				from: CONFIRM_COMMAND,
				to: "repositories/postgres-message.repository.ts"
			},
			{ rule: "use-case-no-transport-or-adapter", from: CONFIRM_COMMAND, to: "gateways/discord.gateway.ts" }
		]
	},
	{
		id: "query-imports-transport-and-gateway",
		boundary: "2 — a query cannot import transport DTOs or gateway adapters either",
		tree: withBaseline({
			[MESSAGE_EXPORT_QUERY]: source(
				'import type { CreateMessageRequest } from "../models/requests/create-message.request.js";',
				'import { DiscordGateway } from "../gateways/discord.gateway.js";',
				"",
				"export class MessageExportQuery {",
				"\tpublic readonly gateway = DiscordGateway;",
				"",
				"\tpublic execute(input: CreateMessageRequest): string {",
				"\t\treturn input.text;",
				"\t}",
				"}"
			)
		}),
		edges: [
			{
				rule: "use-case-no-transport-or-adapter",
				from: MESSAGE_EXPORT_QUERY,
				to: "requests/create-message.request.ts"
			},
			{ rule: "use-case-no-transport-or-adapter", from: MESSAGE_EXPORT_QUERY, to: "gateways/discord.gateway.ts" }
		]
	},
	{
		id: "controller-imports-driver-and-repository",
		boundary: "3 — a controller cannot import pg, SQL repositories or raw HTTP clients",
		tree: withBaseline({
			[MESSAGES_CONTROLLER]: source(
				'import { Controller, Get } from "@nestjs/common";',
				'import { Pool } from "pg";',
				'import { request } from "node:http";',
				'import { PostgresMessageRepository } from "../repositories/postgres-message.repository.js";',
				"",
				'@Controller("messages")',
				"export class MessagesController {",
				"\tprivate readonly pool = new Pool();",
				"",
				"\t@Get()",
				"\tpublic async count(): Promise<number> {",
				"\t\tconst repository = new PostgresMessageRepository(this.pool);",
				"\t\tconst pending = request;",
				"\t\treturn repository.count() + Number(pending !== undefined);",
				"\t}",
				"}"
			)
		}),
		edges: [
			{ rule: "controller-no-driver-or-repository", from: MESSAGES_CONTROLLER, to: "node_modules/pg" },
			{ rule: "controller-no-driver-or-repository", from: MESSAGES_CONTROLLER, to: "http" },
			{
				rule: "controller-no-driver-or-repository",
				from: MESSAGES_CONTROLLER,
				to: "repositories/postgres-message.repository.ts"
			},
			{ rule: "pg-only-in-persistence-boundary", from: MESSAGES_CONTROLLER, to: "node_modules/pg" }
		]
	},
	{
		id: "pg-imported-outside-persistence",
		boundary: "4 — pg may only be imported by PostgreSQL adapters and shared persistence",
		tree: withBaseline({
			[RESPONSE_MAPPER]: source(
				'import { Pool } from "pg";',
				'import type { MessageCountResponse } from "../responses/message-count.response.js";',
				"",
				"export class MessageResponseMapper {",
				"\tpublic constructor(private readonly pool: Pool) {}",
				"",
				"\tpublic toCount(count: number): MessageCountResponse {",
				"\t\treturn { count } as MessageCountResponse;",
				"\t}",
				"}"
			)
		}),
		edges: [{ rule: "pg-only-in-persistence-boundary", from: RESPONSE_MAPPER, to: "node_modules/pg" }]
	},
	{
		id: "cross-feature-internal-adapter",
		boundary: "5 — cross-feature access cannot import another feature's internal adapter",
		tree: withBaseline({
			[GUILD_MODULE]: source(
				'import { Module } from "@nestjs/common";',
				'import { PostgresMessageRepository } from "../messages/repositories/postgres-message.repository.js";',
				"",
				"@Module({ providers: [PostgresMessageRepository] })",
				"export class GuildStateModule {",
				"\tpublic constructor(private readonly repository: PostgresMessageRepository) {}",
				"}"
			)
		}),
		edges: [
			{
				rule: "no-cross-feature-internal-adapters",
				from: GUILD_MODULE,
				to: "src/features/messages/repositories/postgres-message.repository.ts"
			}
		]
	},
	{
		id: "circular-feature-dependency",
		boundary: "6 — cycles are detected",
		tree: withBaseline({
			[DOMAIN_MESSAGE]: source(
				'import { normalizeText } from "./text-value.js";',
				'import { describeText } from "./text-description.js";',
				"",
				"export class Message {",
				"\tpublic readonly summary = describeText(this.id);",
				"",
				"\tpublic constructor(",
				"\t\treadonly id: string,",
				"\t\treadonly text: string",
				"\t) {}",
				"",
				"\tpublic static fromText(text: string): Message {",
				'\t\treturn new Message("1", normalizeText(text));',
				"\t}",
				"}"
			),
			"src/features/messages/models/domain/text-description.ts": source(
				'import { Message } from "./message.js";',
				"",
				"export function describeText(id: string): string {",
				"\treturn `message ${id} ${Message.name}`;",
				"}"
			)
		}),
		edges: [
			{
				rule: "no-circular-dependencies",
				from: DOMAIN_MESSAGE,
				to: "text-description.ts"
			},
			{ rule: "no-circular-dependencies", from: TEXT_DESCRIPTION, to: "message.ts" }
		]
	},
	{
		id: "unresolved-import",
		boundary: "6 — unresolved imports (typo, missing file, unregistered alias) are detected",
		tree: withBaseline({
			"src/features/messages/queries/find-message.query.ts": source(
				'import type { Message } from "../models/domain/mesage.js";',
				'import type { MessageRepository } from "../repository/message.repository.js";',
				"",
				"export class FindMessageQuery {",
				"\tpublic constructor(private readonly repository: MessageRepository) {}",
				"",
				"\tpublic execute(): Promise<Message | undefined> {",
				'\t\treturn this.repository.findById("1");',
				"\t}",
				"}"
			)
		}),
		edges: [
			{
				rule: "no-unresolved-imports",
				from: "src/features/messages/queries/find-message.query.ts",
				to: "mesage"
			},
			{
				rule: "no-unresolved-imports",
				from: "src/features/messages/queries/find-message.query.ts",
				to: "repository/message.repository"
			}
		]
	}
];

/** Deep package paths must be caught too, not only the bare specifier (rule 6's alias/alt-path clause). */
const ALTERNATIVE_PATH_CASES: readonly BoundaryCase[] = [
	{
		id: "domain-imports-nestjs-deep-path",
		boundary: "6 — alternative resolved package paths are covered by the domain boundary",
		tree: withBaseline({
			[DOMAIN_MESSAGE]: source(
				'import { HttpException } from "@nestjs/common/exceptions/http.exception.js";',
				"",
				"export const failure = HttpException;"
			)
		}),
		edges: [
			{
				rule: "domain-no-framework-or-client-dependencies",
				from: DOMAIN_MESSAGE,
				to: "node_modules/@nestjs/common"
			}
		]
	},
	{
		id: "domain-imports-pg-deep-path",
		boundary: "6 — pg subpath imports are covered too",
		tree: withBaseline({
			[DOMAIN_MESSAGE]: source('import Query from "pg/lib/query.js";', "", "export const statement = Query;")
		}),
		edges: [
			{
				rule: "domain-no-framework-or-client-dependencies",
				from: DOMAIN_MESSAGE,
				to: "node_modules/pg/lib"
			},
			{ rule: "pg-only-in-persistence-boundary", from: DOMAIN_MESSAGE, to: "node_modules/pg/lib" }
		]
	}
];

async function cruiseCase(testCase: BoundaryCase): Promise<CruiseRun> {
	const baseDir = await writeFixture(testCase.id, testCase.tree);
	try {
		return await cruiseTree(baseDir);
	} finally {
		await removeFixture(testCase.id);
	}
}

describe("architecture boundary rules reject violating fixtures", () => {
	afterAll(async () => {
		await clearFixtures();
	});

	for (const testCase of [...BOUNDARY_CASES, ...ALTERNATIVE_PATH_CASES]) {
		it(testCase.id, async () => {
			const run = await cruiseCase(testCase);
			const expectedRules = [...new Set(testCase.edges.map((edge) => edge.rule))].sort();

			// The exact rule set: a fixture must trip the rule under test and nothing else.
			expect(run.ruleNames, testCase.boundary).toEqual(expectedRules);
			for (const edge of testCase.edges) {
				expect(reported(run, edge.rule, edge.from, edge.to), `${edge.from} -> ${edge.to}`).toBe(true);
			}

			// Violations must be reported with error severity, otherwise `npm run arch` would still exit 0.
			// Counted separately from `violations.length` because dependency-cruiser reports both directions
			// of a cycle as one violation.
			expect(run.errorCount).toBeGreaterThan(0);
			expect(run.violations.length).toBeGreaterThan(0);
		});
	}
});

describe("architecture boundary rules accept legitimate code", () => {
	afterAll(async () => {
		await clearFixtures();
	});

	it("the clean reference tree produces no violation", async () => {
		const run = await cruiseCase({
			id: "clean-reference-tree",
			boundary: "positive control",
			tree: BASELINE_TREE,
			edges: []
		});
		expect(run.violations).toEqual([]);
		expect(run.errorCount).toBe(0);
		await removeFixture("clean-reference-tree");
	});

	it("the application source tree produces no violation", async () => {
		const run = await cruiseTree(REPO_ROOT);
		expect(run.violations).toEqual([]);
		expect(run.errorCount).toBe(0);
	});
});

describe("every configured rule has a negative fixture", () => {
	it("no boundary rule is shipped without proof it can fail", async () => {
		const declared = await configuredRuleNames();
		const covered = new Set(
			[...BOUNDARY_CASES, ...ALTERNATIVE_PATH_CASES].flatMap((testCase) =>
				testCase.edges.map((edge) => edge.rule)
			)
		);
		const uncovered = declared.filter((rule) => !covered.has(rule));
		expect(uncovered).toEqual([]);
	});
});
