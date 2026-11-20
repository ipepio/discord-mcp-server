import { Module } from "@nestjs/common";
import { ConfigModule } from "../config/config.module.js";
import { APP_CONFIG_TOKEN } from "../config/config.tokens.js";
import type { AppConfig } from "../config/app-config.interface.js";
import { APP_LOGGER_TOKEN } from "./logging.tokens.js";
import type { AppLogger } from "./logger.interface.js";
import { NestLoggerAdapter } from "./nest-logger.adapter.js";
import { StructuredLogger, writeStdout } from "./structured-logger.js";

/** Binds the logger contract to its structured transport for the whole application. */
@Module({
	imports: [ConfigModule],
	providers: [
		{
			provide: APP_LOGGER_TOKEN,
			useFactory: (config: AppConfig): AppLogger => new StructuredLogger(config.logging.level, writeStdout),
			inject: [APP_CONFIG_TOKEN]
		},
		NestLoggerAdapter
	],
	exports: [APP_LOGGER_TOKEN, NestLoggerAdapter]
})
export class LoggingModule {}
