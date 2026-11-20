import { Pool } from "pg";
import type { AppConfig } from "../config/app-config.interface.js";
import type { AppLogger } from "../logging/logger.interface.js";
import { PG_POOL_SETTINGS, validatePgPoolSettings } from "./pg-pool.settings.js";
import type { PgPoolSettings } from "./pg-pool.settings.js";

/**
 * Creates the single managed pool. Only this file and the shared persistence plumbing may import
 * `pg`; feature code receives the pool through `PG_POOL_TOKEN` and never sees driver configuration.
 * Creating a pool opens no connection, so startup does not require a reachable database.
 */
export function createPgPool(config: AppConfig, logger: AppLogger, settings: PgPoolSettings = PG_POOL_SETTINGS): Pool {
	validatePgPoolSettings(settings);

	const pool = new Pool({
		connectionString: config.database.url,
		max: settings.maxConnections,
		connectionTimeoutMillis: settings.connectionTimeoutMillis,
		idleTimeoutMillis: settings.idleTimeoutMillis,
		keepAlive: true,
		statement_timeout: settings.statementTimeoutMillis,
		application_name: settings.applicationName
	});

	// An idle client failure must not crash the process; it is reported without connection details.
	pool.on("error", (error: Error) => {
		logger.error("PostgreSQL idle client error", { error });
	});

	return pool;
}
