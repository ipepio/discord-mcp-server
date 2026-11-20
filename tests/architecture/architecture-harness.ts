/**
 * Test harness for the architecture boundary rules (docs/architecture/testing.md, "Architecture
 * acceptance checks"): every rule must be proven able to fail by a negative fixture, and clean code
 * must be proven to pass.
 *
 * Mechanism: the same `.depcruiser.cjs` configuration that `npm run arch` validates against `src/`
 * is run programmatically against a generated fixture tree. `baseDir` points at the fixture, so the
 * generated files appear to the rules exactly as `src/...` paths and the configured patterns are
 * exercised unmodified, together with their real resolution options (`tsPreCompilationDeps`,
 * `doNotFollow`, enhanced-resolve extensions). Nothing is written outside
 * `tests/architecture/.fixtures/`, and each case removes its own tree afterwards.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { cruise } from "dependency-cruiser";
import extractDepcruiseConfig from "dependency-cruiser/config-utl/extract-depcruise-config";

/** Repository root, resolved from this file so the harness never depends on the runner's cwd. */
export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/** The only location fixture sources may be written to; deleted after every case. */
export const FIXTURES_ROOT = join(REPO_ROOT, "tests", "architecture", ".fixtures");

const CONFIG_FILE = "./.depcruiser.cjs";

/** Fixture tree: cruise-relative source path -> file content. */
export type FixtureTree = Readonly<Record<string, string>>;

/** Joins source lines with LF so fixture content stays readable without literal tabs. */
export function source(...lines: readonly string[]): string {
	return `${lines.join("\n")}\n`;
}

const IMP = "import";

/**
 * A clean reference tree mirroring docs/architecture/structure.md: two features with domain models,
 * a command with its application input, a query, REST request/response contracts, a read mapper,
 * repository contracts with their PostgreSQL implementations, a gateway, feature modules wired with
 * explicit tokens/factories, a public feature barrel and the shared plumbing. It must produce zero
 * violations — that is the positive assertion that the rules do not reject legitimate architecture.
 */
export const BASELINE_TREE: FixtureTree = {
	"src/main.ts": source(
		`${IMP} "reflect-metadata";`,
		`${IMP} { NestFactory } from "@nestjs/core";`,
		`${IMP} { AppModule } from "./app.module.js";`,
		"",
		"export async function bootstrap(): Promise<void> {",
		"\tawait NestFactory.create(AppModule);",
		"}"
	),
	"src/app.module.ts": source(
		`${IMP} { Module } from "@nestjs/common";`,
		`${IMP} { ConfigModule } from "./shared/config/config.module.js";`,
		`${IMP} { PersistenceModule } from "./shared/persistence/persistence.module.js";`,
		`${IMP} { HttpModule } from "./shared/http/http.module.js";`,
		`${IMP} { MessagesModule } from "./features/messages/messages.module.js";`,
		`${IMP} { GuildStateModule } from "./features/guild-state/guild-state.module.js";`,
		"",
		"@Module({ imports: [ConfigModule, PersistenceModule, HttpModule, MessagesModule, GuildStateModule] })",
		"export class AppModule {}"
	),
	"src/shared/config/config.module.ts": source(
		`${IMP} { Module } from "@nestjs/common";`,
		`${IMP} { loadAppConfig, readProcessEnv } from "./config.factory.js";`,
		`${IMP} { APP_CONFIG_TOKEN } from "./config.tokens.js";`,
		"",
		"@Module({",
		"\tproviders: [{ provide: APP_CONFIG_TOKEN, useFactory: () => loadAppConfig(readProcessEnv()) }],",
		"\texports: [APP_CONFIG_TOKEN]",
		"})",
		"export class ConfigModule {}"
	),
	"src/shared/config/config.factory.ts": source(
		`${IMP} type { EnvSource } from "./config.types.js";`,
		"",
		"export interface AppConfig {",
		"\treadonly database: { readonly url: string };",
		"}",
		"",
		"export function readProcessEnv(): EnvSource {",
		"\treturn process.env;",
		"}",
		"",
		"export function loadAppConfig(env: EnvSource): AppConfig {",
		'\treturn { database: { url: env["DATABASE_URL"] ?? "" } };',
		"}"
	),
	"src/shared/config/config.tokens.ts": source('export const APP_CONFIG_TOKEN = "APP_CONFIG_TOKEN";'),
	"src/shared/config/config.types.ts": source(
		"export type EnvSource = Readonly<Record<string, string | undefined>>;"
	),
	"src/shared/logging/logging.module.ts": source(
		`${IMP} { Module } from "@nestjs/common";`,
		`${IMP} { APP_LOGGER_TOKEN } from "./logging.tokens.js";`,
		`${IMP} { StructuredLogger } from "./structured-logger.js";`,
		"",
		"@Module({ providers: [{ provide: APP_LOGGER_TOKEN, useFactory: () => new StructuredLogger() }], exports: [APP_LOGGER_TOKEN] })",
		"export class LoggingModule {}"
	),
	"src/shared/logging/logging.tokens.ts": source('export const APP_LOGGER_TOKEN = "APP_LOGGER_TOKEN";'),
	"src/shared/logging/logger.interface.ts": source(
		"export interface AppLogger {",
		"\treadonly info: (message: string) => void;",
		"}"
	),
	"src/shared/logging/structured-logger.ts": source(
		`${IMP} type { AppLogger } from "./logger.interface.js";`,
		"",
		"export class StructuredLogger implements AppLogger {",
		"\tpublic info(message: string): void {",
		"\t\tprocess.stdout.write(`${message} registered`);",
		"\t}",
		"}"
	),
	"src/shared/persistence/persistence.module.ts": source(
		`${IMP} { Module } from "@nestjs/common";`,
		`${IMP} { createPgPool } from "./pg-pool.factory.js";`,
		`${IMP} { PG_POOL_TOKEN } from "./persistence.tokens.js";`,
		"",
		"@Module({",
		"\tproviders: [{ provide: PG_POOL_TOKEN, useFactory: createPgPool }],",
		"\texports: [PG_POOL_TOKEN]",
		"})",
		"export class PersistenceModule {}"
	),
	"src/shared/persistence/persistence.tokens.ts": source('export const PG_POOL_TOKEN = "PG_POOL_TOKEN";'),
	"src/shared/persistence/pg-pool.factory.ts": source(
		`${IMP} { Pool } from "pg";`,
		"",
		"export function createPgPool(): Pool {",
		"\treturn new Pool({ max: 10 });",
		"}"
	),
	"src/shared/http/http.module.ts": source(
		`${IMP} { Module } from "@nestjs/common";`,
		`${IMP} { HealthController } from "./health.controller.js";`,
		"",
		"@Module({ controllers: [HealthController] })",
		"export class HttpModule {}"
	),
	"src/shared/http/health.controller.ts": source(
		`${IMP} { Controller, Get } from "@nestjs/common";`,
		`${IMP} { HealthResponse } from "./health.response.js";`,
		"",
		'@Controller("health")',
		"export class HealthController {",
		"\t@Get()",
		"\tpublic check(): HealthResponse {",
		"\t\treturn new HealthResponse();",
		"\t}",
		"}"
	),
	"src/shared/http/health.response.ts": source(
		"export class HealthResponse {",
		'\tpublic readonly status = "ok";',
		"}"
	),
	"src/features/messages/messages.module.ts": source(
		`${IMP} { Module } from "@nestjs/common";`,
		`${IMP} { MessagesController } from "./controllers/messages.controller.js";`,
		`${IMP} { CreateMessageCommand } from "./commands/create-message.command.js";`,
		`${IMP} { MessageCountQuery } from "./queries/message-count.query.js";`,
		`${IMP} { MESSAGE_REPOSITORY_TOKEN } from "./repositories/message.repository.js";`,
		`${IMP} { PostgresMessageRepository } from "./repositories/postgres-message.repository.js";`,
		`${IMP} { PG_POOL_TOKEN } from "../../shared/persistence/persistence.tokens.js";`,
		"",
		"@Module({",
		"\tcontrollers: [MessagesController],",
		"\tproviders: [",
		"\t\t{",
		"\t\t\tprovide: MESSAGE_REPOSITORY_TOKEN,",
		"\t\t\tuseFactory: (pool) => new PostgresMessageRepository(pool),",
		"\t\t\tinject: [PG_POOL_TOKEN]",
		"\t\t},",
		"\t\t{ provide: CreateMessageCommand, useFactory: (repository) => new CreateMessageCommand(repository), inject: [MESSAGE_REPOSITORY_TOKEN] },",
		"\t\t{ provide: MessageCountQuery, useFactory: (repository) => new MessageCountQuery(repository), inject: [MESSAGE_REPOSITORY_TOKEN] }",
		"\t]",
		"}) ",
		"export class MessagesModule {}"
	),
	"src/features/messages/index.ts": source(
		`${IMP} { CreateMessageCommand } from "./commands/create-message.command.js";`,
		`${IMP} { MessageCountQuery } from "./queries/message-count.query.js";`,
		"",
		"export { CreateMessageCommand, MessageCountQuery };"
	),
	"src/features/messages/controllers/messages.controller.ts": source(
		`${IMP} { Body, Controller, Get, Post } from "@nestjs/common";`,
		`${IMP} type { CreateMessageCommand } from "../commands/create-message.command.js";`,
		`${IMP} type { CreateMessageInput } from "../commands/create-message.request.js";`,
		`${IMP} type { MessageCountQuery } from "../queries/message-count.query.js";`,
		`${IMP} type { CreateMessageRequest } from "../models/requests/create-message.request.js";`,
		`${IMP} type { MessageCountResponse } from "../models/responses/message-count.response.js";`,
		`${IMP} type { MessageResponseMapper } from "../models/mappers/message.response-mapper.js";`,
		"",
		'@Controller("messages")',
		"export class MessagesController {",
		"\tpublic constructor(",
		"\t\tprivate readonly createMessage: CreateMessageCommand,",
		"\t\tprivate readonly countMessages: MessageCountQuery,",
		"\t\tprivate readonly mapper: MessageResponseMapper",
		"\t) {}",
		"",
		"\t@Post()",
		"\tpublic async create(@Body() body: CreateMessageRequest): Promise<void> {",
		"\t\tconst input: CreateMessageInput = { text: body.text };",
		"\t\tawait this.createMessage.execute(input);",
		"\t}",
		"",
		"\t@Get()",
		"\tpublic async count(): Promise<MessageCountResponse> {",
		"\t\treturn this.mapper.toCount(await this.countMessages.execute());",
		"\t}",
		"}"
	),
	"src/features/messages/commands/create-message.request.ts": source(
		"export interface CreateMessageInput {",
		"\treadonly text: string;",
		"}"
	),
	"src/features/messages/commands/create-message.command.ts": source(
		`${IMP} { Message } from "../models/domain/message.js";`,
		`${IMP} type { MessageRepository } from "../repositories/message.repository.js";`,
		`${IMP} type { CreateMessageInput } from "./create-message.request.js";`,
		"",
		"export class CreateMessageCommand {",
		"\tpublic constructor(private readonly repository: MessageRepository) {}",
		"",
		"\tpublic async execute(input: CreateMessageInput): Promise<Message> {",
		"\t\tconst message = Message.fromText(input.text);",
		"\t\tawait this.repository.save(message);",
		"\t\treturn message;",
		"\t}",
		"}"
	),
	"src/features/messages/queries/message-count.query.ts": source(
		`${IMP} type { MessageRepository } from "../repositories/message.repository.js";`,
		"",
		"export class MessageCountQuery {",
		"\tpublic constructor(private readonly repository: MessageRepository) {}",
		"",
		"\tpublic async execute(): Promise<number> {",
		"\t\treturn this.repository.count();",
		"\t}",
		"}"
	),
	"src/features/messages/models/domain/message.ts": source(
		`${IMP} { normalizeText } from "./text-value.js";`,
		"",
		"export class Message {",
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
	"src/features/messages/models/domain/text-value.ts": source(
		"export function normalizeText(text: string): string {",
		"\treturn text.trim();",
		"}"
	),
	"src/features/messages/models/dtos/message-row.dto.ts": source(
		"export interface MessageRow {",
		"\treadonly id: string;",
		"\treadonly text: string;",
		"}"
	),
	"src/features/messages/models/requests/create-message.request.ts": source(
		"export class CreateMessageRequest {",
		"\tpublic readonly text!: string;",
		"}"
	),
	"src/features/messages/models/responses/message-count.response.ts": source(
		"export class MessageCountResponse {",
		"\tpublic readonly count!: number;",
		"}"
	),
	"src/features/messages/models/mappers/message.response-mapper.ts": source(
		`${IMP} type { MessageCountResponse } from "../responses/message-count.response.js";`,
		"",
		"export class MessageResponseMapper {",
		"\tpublic toCount(count: number): MessageCountResponse {",
		"\t\treturn { count } as MessageCountResponse;",
		"\t}",
		"}"
	),
	"src/features/messages/repositories/message.repository.ts": source(
		`${IMP} type { Message } from "../models/domain/message.js";`,
		"",
		'export const MESSAGE_REPOSITORY_TOKEN = "MESSAGE_REPOSITORY_TOKEN";',
		"",
		"export interface MessageRepository {",
		"\tsave(message: Message): Promise<void>;",
		"\tcount(): Promise<number>;",
		"}"
	),
	"src/features/messages/repositories/postgres-message.repository.ts": source(
		`${IMP} type { Pool } from "pg";`,
		`${IMP} { Message } from "../models/domain/message.js";`,
		`${IMP} type { MessageRow } from "../models/dtos/message-row.dto.js";`,
		`${IMP} type { MessageRepository } from "./message.repository.js";`,
		"",
		"export class PostgresMessageRepository implements MessageRepository {",
		"\tpublic constructor(private readonly pool: Pool) {}",
		"",
		"\tpublic async save(message: Message): Promise<void> {",
		'\t\tawait this.pool.query("insert into messages (id, text) values ($1, $2)", [message.id, message.text]);',
		"\t}",
		"",
		"\tpublic async count(): Promise<number> {",
		'\t\tconst result = await this.pool.query("select count(*) as total from messages");',
		'\t\treturn Number(result.rows[0]?.["total"] ?? 0);',
		"\t}",
		"",
		"\tpublic toDomain(row: MessageRow): Message {",
		"\t\treturn new Message(row.id, row.text);",
		"\t}",
		"}"
	),
	"src/features/messages/gateways/discord.gateway.ts": source(
		"export interface DiscordMessagePayload {",
		"\treadonly id: string;",
		"}",
		"",
		"export class DiscordGateway {",
		"\tpublic async fetchMessage(id: string): Promise<DiscordMessagePayload> {",
		"\t\treturn { id };",
		"\t}",
		"}"
	),
	"src/features/guild-state/guild-state.module.ts": source(
		`${IMP} { Module } from "@nestjs/common";`,
		`${IMP} { GUILD_REPOSITORY_TOKEN } from "./repositories/guild.repository.js";`,
		`${IMP} { PostgresGuildRepository } from "./repositories/postgres-guild.repository.js";`,
		`${IMP} { GuildSummaryQuery } from "./queries/guild-summary.query.js";`,
		`${IMP} { PG_POOL_TOKEN } from "../../shared/persistence/persistence.tokens.js";`,
		"",
		"@Module({",
		"\tproviders: [",
		"\t\t{",
		"\t\t\tprovide: GUILD_REPOSITORY_TOKEN,",
		"\t\t\tuseFactory: (pool) => new PostgresGuildRepository(pool),",
		"\t\t\tinject: [PG_POOL_TOKEN]",
		"\t\t},",
		"\t\t{ provide: GuildSummaryQuery, useFactory: (repository) => new GuildSummaryQuery(repository), inject: [GUILD_REPOSITORY_TOKEN] }",
		"\t]",
		"})",
		"export class GuildStateModule {}"
	),
	"src/features/guild-state/queries/guild-summary.query.ts": source(
		`${IMP} type { GuildRepository } from "../repositories/guild.repository.js";`,
		`${IMP} type { GuildSummary } from "../models/domain/guild-summary.js";`,
		"",
		"export class GuildSummaryQuery {",
		"\tpublic constructor(private readonly repository: GuildRepository) {}",
		"",
		"\tpublic async execute(): Promise<GuildSummary> {",
		"\t\treturn this.repository.summary();",
		"\t}",
		"}"
	),
	"src/features/guild-state/models/domain/guild-summary.ts": source(
		"export interface GuildSummary {",
		"\treadonly guildId: string;",
		"}"
	),
	"src/features/guild-state/repositories/guild.repository.ts": source(
		`${IMP} type { GuildSummary } from "../models/domain/guild-summary.js";`,
		"",
		'export const GUILD_REPOSITORY_TOKEN = "GUILD_REPOSITORY_TOKEN";',
		"",
		"export interface GuildRepository {",
		"\tsummary(): Promise<GuildSummary>;",
		"}"
	),
	"src/features/guild-state/repositories/postgres-guild.repository.ts": source(
		`${IMP} type { Pool } from "pg";`,
		`${IMP} type { GuildSummary } from "../models/domain/guild-summary.js";`,
		`${IMP} type { GuildRepository } from "./guild.repository.js";`,
		"",
		"export class PostgresGuildRepository implements GuildRepository {",
		"\tpublic constructor(private readonly pool: Pool) {}",
		"",
		"\tpublic async summary(): Promise<GuildSummary> {",
		'\t\tconst result = await this.pool.query("select guild_id from guild_state limit 1");',
		'\t\treturn { guildId: String(result.rows[0]?.["guild_id"] ?? "") };',
		"\t}",
		"}"
	)
};

/** Baseline tree plus the case-specific files or overrides. */
export function withBaseline(overrides: FixtureTree): FixtureTree {
	return { ...BASELINE_TREE, ...overrides };
}

/** Writes a fixture tree and returns the directory to cruise it from. */
export async function writeFixture(name: string, tree: FixtureTree): Promise<string> {
	const baseDir = join(FIXTURES_ROOT, name);
	for (const [relativePath, content] of Object.entries(tree)) {
		const target = join(baseDir, relativePath);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content, "utf8");
	}

	return baseDir;
}

/** Removes a fixture tree; called by every case so no generated source survives the run. */
export async function removeFixture(name: string): Promise<void> {
	await rm(join(FIXTURES_ROOT, name), { recursive: true, force: true });
}

/** Removes the whole fixture root, including any tree left behind by an interrupted run. */
export async function clearFixtures(): Promise<void> {
	await rm(FIXTURES_ROOT, { recursive: true, force: true });
}

export interface Violation {
	readonly from: string;
	readonly to: string;
	readonly rule: string;
}

export interface CruiseRun {
	readonly violations: readonly Violation[];
	/** Distinct violated rule names, sorted for stable assertions. */
	readonly ruleNames: readonly string[];
	readonly errorCount: number;
}

interface CruiseRule {
	readonly name?: string;
}

interface CruiseDependency {
	readonly specifier: string;
	readonly resolved?: string;
	readonly rules?: readonly CruiseRule[];
}

interface CruiseModule {
	readonly source: string;
	readonly rules?: readonly CruiseRule[];
	readonly dependencies?: readonly CruiseDependency[];
}

interface CruiseJsonResult {
	readonly modules: readonly CruiseModule[];
	readonly summary: { readonly error?: number };
}

const configLoader = extractDepcruiseConfig(CONFIG_FILE, undefined, REPO_ROOT).then((config) => ({
	options: (config.options ?? {}) as Record<string, unknown>,
	forbidden: config.forbidden ?? [],
	ruleNames: (config.forbidden ?? []).map((rule) => rule.name ?? "<unnamed>")
}));

/** The rule names declared in `.depcruiser.cjs` — used to prove every rule has a negative fixture. */
export async function configuredRuleNames(): Promise<readonly string[]> {
	const config = await configLoader;
	return config.ruleNames;
}

/**
 * Runs the repository's real dependency-cruiser configuration against the tree rooted at `baseDir`.
 * `baseDir` makes the fixture's own `src/` directory the cruise root, so configured `^src/...`
 * patterns match fixture files exactly as they match application files.
 */
export async function cruiseTree(baseDir: string): Promise<CruiseRun> {
	const config = await configLoader;
	const result = await cruise(["src"], {
		...config.options,
		baseDir,
		validate: true,
		ruleSet: { forbidden: config.forbidden },
		/* No `outputType`/reporter: the API returns the cruise result as an object, which is exactly what
		   the violation walk below reads. Naming a reporter here would only stringify that object. */
		cache: false
	});

	const output = result.output as unknown as CruiseJsonResult;
	const violations: Violation[] = [];
	for (const module of output.modules) {
		if (!module.source.startsWith("src/")) {
			continue;
		}

		for (const rule of module.rules ?? []) {
			violations.push({ from: module.source, to: module.source, rule: rule.name ?? "<unnamed>" });
		}

		for (const dependency of module.dependencies ?? []) {
			for (const rule of dependency.rules ?? []) {
				violations.push({
					from: module.source,
					to: dependency.resolved ?? dependency.specifier,
					rule: rule.name ?? "<unnamed>"
				});
			}
		}
	}

	return {
		violations,
		ruleNames: [...new Set(violations.map((violation) => violation.rule))].sort(),
		errorCount: output.summary.error ?? 0
	};
}

/**
 * True when the run reported `ruleName` for an edge from `fromPath` whose target path contains
 * `toFragment`. Used to name the exact dependency a rule must catch, not just any violation.
 */
export function reported(run: CruiseRun, ruleName: string, fromPath: string, toFragment: string): boolean {
	return run.violations.some(
		(violation) => violation.rule === ruleName && violation.from === fromPath && violation.to.includes(toFragment)
	);
}
