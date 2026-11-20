import { Module } from "@nestjs/common";
import type { AppConfig } from "../config/app-config.interface.js";
import { APP_CONFIG_TOKEN } from "../config/config.tokens.js";
import { ConfigModule } from "../config/config.module.js";
import { LoggingModule } from "../logging/logging.module.js";
import { APP_LOGGER_TOKEN } from "../logging/logging.tokens.js";
import type { AppLogger } from "../logging/logger.interface.js";
import { PgPoolShutdown } from "./pg-pool.shutdown.js";
import { createPgPool } from "./pg-pool.factory.js";
import { PG_POOL_TOKEN } from "./persistence.tokens.js";

/**
 * Owns the pool lifecycle for the whole application instance. Feature modules receive `PG_POOL_TOKEN`;
 * they never construct a pool and no migration runs from here (docs/architecture/persistence.md).
 */
@Module({
	imports: [ConfigModule, LoggingModule],
	providers: [
		{
			provide: PG_POOL_TOKEN,
			useFactory: (config: AppConfig, logger: AppLogger) => createPgPool(config, logger),
			inject: [APP_CONFIG_TOKEN, APP_LOGGER_TOKEN]
		},
		PgPoolShutdown
	],
	exports: [PG_POOL_TOKEN]
})
export class PersistenceModule {}
