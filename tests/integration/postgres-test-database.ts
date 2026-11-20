/**
 * Integration harness support (docs/architecture/testing.md: "Integration tests must create and drop their
 * own database, or a schema, and state the URL variable they need. Never truncate shared data").
 *
 * The rules this file exists to enforce:
 *
 * - `TEST_DATABASE_URL` is required, explicitly. It is never defaulted to `DATABASE_URL` and never
 *   inherited from an installation's own database: a harness that silently reuses a live registry would
 *   truncate somebody's real permission state. Without it there is no run to report, so the banner below
 *   says so in the test output and every database-backed suite is skipped — never passed.
 * - Each run creates its own database on the same server, applies the migrations programmatically through
 *   `node-pg-migrate`'s runner, and drops the database afterwards. The created and dropped names are
 *   printed, which is the evidence testing.md asks for.
 * - Cleanup between tests is a `TRUNCATE` of this feature's own tables, and only after the connection has
 *   confirmed it is talking to the database this harness created. `TRUNCATE` is never issued against the
 *   maintenance database or any name this file did not generate.
 * - The generated name is an identifier, and identifiers cannot be bound as parameters. It is built from a
 *   frozen prefix plus random hex, then matched against `^[a-z0-9_]+$` before it reaches any statement, so
 *   no caller-controlled text ever becomes part of a `CREATE`/`DROP DATABASE`.
 */

import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type { Pool } from "pg";
import { runner } from "node-pg-migrate";
import { createPgPool } from "../../src/shared/persistence/pg-pool.factory.js";
import type { PgPoolSettings } from "../../src/shared/persistence/pg-pool.settings.js";
import { PG_POOL_SETTINGS } from "../../src/shared/persistence/pg-pool.settings.js";
import { StructuredLogger } from "../../src/shared/logging/structured-logger.js";
import type { AppConfig } from "../../src/shared/config/app-config.interface.js";
import { createSqlExecutor } from "../../src/features/guild-state/repositories/sql-executor.js";
import type { SqlExecutor } from "../../src/features/guild-state/repositories/sql-executor.js";

/** The only connection source this harness will read. Never a fallback, never `DATABASE_URL`. */
export const TEST_DATABASE_URL_ENVIRONMENT_VARIABLE = "TEST_DATABASE_URL";

/**
 * Prefix of every database this file creates. Nothing else may be created or dropped here.
 * PostgreSQL silently truncates identifiers past 63 bytes, so this budget is hard: prefix + subject
 * + "_" + the 12-char hash must stay ≤ 63 (worst subject today is 25 chars, leaving 10 of headroom).
 */
const ISOLATED_DATABASE_PREFIX = "discord_mcp_it_";

/** The registry tables T1 created, in dependency order, for the between-test reset. */
export const GUILD_STATE_REGISTRY_TABLES = [
	"thread_membership",
	"channel_permission_overwrite",
	"channel",
	"guild_membership_role",
	"guild_membership",
	"guild_role",
	"guild"
] as const;

/**
 * The tables ingestion owns, in dependency order, for the between-test reset: the message store T1 created and
 * the import ledger `odd/tasks/ingestion-catchup.md` T1 added (docs/features/ingestion.md R14). Listed
 * separately from the registry's tables because they belong to a different feature: `resetRegistry` never sweeps
 * them and `resetMessageStore` never sweeps the registry, so one feature's suite cannot quietly empty the
 * other's tables and a cascade evidence read-back stays attributable (docs/architecture/testing.md).
 */
// The referencing embedding table must be named explicitly for TRUNCATE (never CASCADE).
export const INGESTION_MESSAGE_TABLES = [
	"message_embeddings",
	"message_attachment",
	"message",
	"import_channel_progress"
] as const;

/** Safe by construction: lower letters, digits and underscore, nothing that could close an identifier. */
const SAFE_DATABASE_IDENTIFIER = /^[a-z0-9_]+$/;

/** Registry table names are this file's own frozen list; the guard restates the rule at each use site. */
const SAFE_TABLE_IDENTIFIER = /^[a-z_]+$/;

/**
 * Identifiers cannot be bound as parameters, so the protection is the guard, not a placeholder. Every
 * dynamic statement in this file is built through one of the helpers below, which validate the name first
 * and are the only place an identifier is ever quoted; no query call site interpolates text.
 */
function quotedIdentifier(kind: "database" | "table", candidate: string): string {
	const pattern = kind === "database" ? SAFE_DATABASE_IDENTIFIER : SAFE_TABLE_IDENTIFIER;
	if (!pattern.test(candidate)) {
		throw new Error(`integration harness refused the ${kind} identifier ${JSON.stringify(candidate)}`);
	}
	return `"${candidate}"`;
}

function createDatabaseStatement(databaseName: string): string {
	return `CREATE DATABASE ${quotedIdentifier("database", databaseName)}`;
}

function dropDatabaseStatement(databaseName: string): string {
	return `DROP DATABASE ${quotedIdentifier("database", databaseName)}`;
}

/** The between-test reset: this feature's own tables, from the frozen list, and nothing else. */
function truncateRegistryTablesStatement(): string {
	const tables = GUILD_STATE_REGISTRY_TABLES.map((table) => quotedIdentifier("table", table)).join(", ");
	return `TRUNCATE TABLE ${tables} RESTART IDENTITY`;
}

/** The message store's own reset, and the same rule: only the tables this file names for that feature. */
function truncateMessageTablesStatement(): string {
	const tables = INGESTION_MESSAGE_TABLES.map((table) => quotedIdentifier("table", table)).join(", ");
	return `TRUNCATE TABLE ${tables} RESTART IDENTITY`;
}

/** Row count of one allowlisted registry table — the cascade evidence a test reads back. */
function countRegistryRowsStatement(table: string): string {
	return `SELECT COUNT(*) AS total FROM ${quotedIdentifier("table", table)}`;
}

function report(line: string): void {
	process.stderr.write(`[integration] ${line}\n`);
}

/**
 * Loud and unconditional, because a skipped suite is invisible in a green run. This is the "UNAVAILABLE
 * evidence" the task asks for: the reason, the variable name, and the command that produces real evidence.
 */
function reportUnavailable(reason: string): void {
	report(
		`UNAVAILABLE — integration evidence is missing: ${reason} ` +
			`Set ${TEST_DATABASE_URL_ENVIRONMENT_VARIABLE} and re-run \`npm run test:integration\`. ` +
			"Skipped is not passed: nothing here proves PostgreSQL behaviour."
	);
	report(
		`UNAVAILABLE — how to get real evidence: PostgreSQL is not host-published, so run inside the compose ` +
			"network with docker compose run --rm -e " +
			`${TEST_DATABASE_URL_ENVIRONMENT_VARIABLE}=postgresql://<user>:<password>@postgres:5432/<db> app ` +
			`sh -c "npm ci && npm run test:integration"`
	);
}

/** The configured URL, or `undefined` when the run has no explicit integration database. */
export function testDatabaseUrl(): string | undefined {
	const configured = process.env[TEST_DATABASE_URL_ENVIRONMENT_VARIABLE];
	if (typeof configured !== "string" || configured.trim() === "") {
		return undefined;
	}
	return configured.trim();
}

/** True when this process can reach a database it owns. Read once, so the banner and the gate agree. */
export const HAS_TEST_DATABASE = testDatabaseUrl() !== undefined;

if (!HAS_TEST_DATABASE) {
	reportUnavailable(`${TEST_DATABASE_URL_ENVIRONMENT_VARIABLE} is not set (or is blank)`);
}

export function guildStateMigrationsDirectory(): string {
	// tests/integration/<this file> -> the repository root's migrations directory.
	const here = dirname(fileURLToPath(import.meta.url));
	return resolve(here, "../../migrations");
}

/** A connection string for one database name on the same server the configured URL points at. */
function urlForDatabase(base: string, databaseName: string): string {
	const url = new URL(base);
	url.pathname = `/${databaseName}`;
	return url.toString();
}

export function isolatedDatabaseName(label: string): string {
	const suffix = randomBytes(6).toString("hex");
	const prefix = label.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
	const candidate = `${ISOLATED_DATABASE_PREFIX}${prefix}_${suffix}`;
	if (!SAFE_DATABASE_IDENTIFIER.test(candidate)) {
		throw new Error(`integration harness refused the generated database name ${candidate}`);
	}
	return candidate;
}

export interface IsolatedTestDatabase {
	readonly databaseName: string;
	/** The pool the repositories under test run on: the same factory the application composes with. */
	readonly pool: Pool;
	/** The driver-free seam every guild-state PostgreSQL repository takes. */
	readonly executor: SqlExecutor;
	/** Proves the connection is on the database this harness created and that the registry tables exist. */
	readonly assertIsolation: () => Promise<void>;
	/** Empty every registry table. Guarded by `assertIsolation`, so it can only ever hit this run's database. */
	readonly resetRegistry: () => Promise<void>;
	/** Empty every message-store table, and only those. Guarded the same way `resetRegistry` is. */
	readonly resetMessageStore: () => Promise<void>;
	/** Count rows in one allowlisted table of either feature, for the cascade evidence a test reads back. */
	readonly countRows: (table: string) => Promise<number>;
	/** Pool closed, database dropped. Idempotent. */
	readonly close: () => Promise<void>;
}

/**
 * Create a database, apply the migrations into it, hand back a usable pool. The caller must `close()` it;
 * a failure anywhere in between still drops what was created, because a leaked test database on a shared
 * server is somebody else's confusing inventory.
 */
export async function openIsolatedTestDatabase(label: string): Promise<IsolatedTestDatabase> {
	const base = testDatabaseUrl();
	if (base === undefined) {
		throw new Error(`integration harness refuses to run without ${TEST_DATABASE_URL_ENVIRONMENT_VARIABLE}`);
	}

	const databaseName = isolatedDatabaseName(label);
	const maintenanceDatabase = new URL(base).pathname.replace(/^\//, "") || "postgres";
	const admin = new Client({ connectionString: urlForDatabase(base, maintenanceDatabase) });
	await admin.connect();

	try {
		// Not caller-controlled text: `databaseName` was built above from a frozen prefix plus random hex, and
		// `safeIdentifier` re-checks it here at the statement site.
		await admin.query(createDatabaseStatement(databaseName));
	} catch (failure) {
		await admin.end();
		throw failure;
	}
	report(`created isolated database "${databaseName}" (maintenance database "${maintenanceDatabase}")`);

	const config: AppConfig = {
		authorization: {
			discordClientId: "fixture",
			discordClientSecret: "fixture",
			publicBaseUrl: "https://hub.example",
			sessionTtlSeconds: 300
		},
		database: { url: urlForDatabase(base, databaseName) },
		http: { port: 0 },
		logging: { level: "info" }
	};
	const settings: PgPoolSettings = {
		...PG_POOL_SETTINGS,
		maxConnections: 4,
		applicationName: "discord-mcp-integration-harness"
	};
	// The application's own pool factory, so the harness exercises the composition path under test rather than
	// a hand-built client. Creating a pool opens no connection.
	const pool = createPgPool(config, new StructuredLogger("error", (line: string) => report(line)), settings);

	const drop = async (): Promise<void> => {
		// Terminate this harness's own connections first: Postgres refuses to drop a database in use.
		await admin.query(
			`
				SELECT PG_TERMINATE_BACKEND(PID)
				FROM PG_STAT_ACTIVITY
				WHERE DATNAME = $1 AND PID <> PG_BACKEND_PID()
			`,
			[databaseName]
		);
		await admin.query(dropDatabaseStatement(databaseName));
		report(`dropped isolated database "${databaseName}"`);
		await admin.end();
	};

	try {
		// `runner` resolves to one entry per applied migration (`RunMigration`), so the evidence line names
		// them rather than stringifying objects. `logger` — not `log` — is the object-shaped option; `log`
		// takes a single function and would be called as one.
		const migrations = await runner({
			direction: "up",
			dir: guildStateMigrationsDirectory(),
			databaseUrl: urlForDatabase(base, databaseName),
			migrationsTable: "pgmigrations",
			migrationsSchema: "public",
			schema: "public",
			logger: {
				info: (line: string) => report(line),
				warn: (line: string) => report(line),
				error: (line: string) => report(line)
			}
		});
		const appliedNames = migrations.map((migration) => migration.name).join(", ");
		report(`applied ${migrations.length} migration(s) into "${databaseName}": ${appliedNames}`);

		const executor = createSqlExecutor(pool);

		const assertIsolation = async (): Promise<void> => {
			const { rows } = await pool.query<{ current: string }>("SELECT CURRENT_DATABASE() AS current");
			const on = rows[0]?.current;
			if (on !== databaseName) {
				throw new Error(
					`integration harness expected to be on "${databaseName}" but the connection says "${String(on)}"`
				);
			}
			const tables = await pool.query<{ table_name: string }>(
				`
					SELECT table_name
					FROM information_schema.tables
					WHERE table_schema = 'public' AND table_name = ANY($1::text[])
				`,
				[[...GUILD_STATE_REGISTRY_TABLES, ...INGESTION_MESSAGE_TABLES]]
			);
			const expected = [...GUILD_STATE_REGISTRY_TABLES, ...INGESTION_MESSAGE_TABLES];
			if (tables.rows.length !== expected.length) {
				const found = tables.rows.map((row) => row.table_name);
				throw new Error(
					`integration harness expected the full registry and message-store schema on "${databaseName}" and found ${found.join(", ")}`
				);
			}
		};

		await assertIsolation();
		report(`isolation confirmed before setup: connected to "${databaseName}" with the registry schema`);

		return {
			databaseName,
			pool,
			executor,
			assertIsolation,
			resetRegistry: async () => {
				await assertIsolation();
				// Every table named here is one this harness created and listed; a shared database can never be
				// reached, because `assertIsolation` just proved the connection's own database name.
				await pool.query(truncateRegistryTablesStatement());
			},
			resetMessageStore: async () => {
				await assertIsolation();
				await pool.query(truncateMessageTablesStatement());
			},
			countRows: async (table: string) => {
				const allowlisted = [...GUILD_STATE_REGISTRY_TABLES, ...INGESTION_MESSAGE_TABLES];
				if (!allowlisted.some((candidate) => candidate === table)) {
					throw new Error(
						`integration harness will not count rows of ${table}: it is not a guild-state registry table ` +
							"or an ingestion message-store table"
					);
				}
				const { rows } = await pool.query<{ total: string }>(countRegistryRowsStatement(table));
				return Number(rows[0]?.total ?? "0");
			},
			close: async () => {
				await pool.end();
				await drop();
			}
		};
	} catch (failure) {
		await pool.end();
		await drop();
		throw failure;
	}
}
