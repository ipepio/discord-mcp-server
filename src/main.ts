import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { loadAppConfig, readProcessEnv } from "./shared/config/config.factory.js";
import { brandOrDefault } from "./shared/config/brand-config.js";
import { loadEmbeddingConfig, loadFullTextLanguage } from "./features/semantic-index/index.js";
import { loadIngestionImportWindow } from "./features/ingestion/index.js";
import { loadQueryConfig } from "./shared/config/query-config.factory.js";
import { resolveBotIdentity } from "./features/discord/index.js";
import { AppModule } from "./app.module.js";
import type { AppConfig } from "./shared/config/app-config.interface.js";
import { APP_CONFIG_TOKEN } from "./shared/config/config.tokens.js";
import { NestLoggerAdapter } from "./shared/logging/nest-logger.adapter.js";
import { APP_LOGGER_TOKEN } from "./shared/logging/logging.tokens.js";
import type { AppLogger } from "./shared/logging/logger.interface.js";

/** Bootstrap only: compose, unify framework logging, document the auxiliary REST surface and listen. */
async function bootstrap(): Promise<void> {
	// The container owns the logger, so Nest's default console logger is disabled from the start.
	const env = Object.freeze({ ...readProcessEnv() });
	// Validate all required configuration before the first (bounded) identity read.
	loadAppConfig(env);
	loadEmbeddingConfig(env);
	loadFullTextLanguage(env);
	loadIngestionImportWindow(env);
	loadQueryConfig(env);
	const botUserId = await resolveBotIdentity(env);
	const app = await NestFactory.create(AppModule.forRoot({ botUserId, env }), { logger: false });
	app.useLogger(app.get(NestLoggerAdapter));
	const config = app.get<AppConfig>(APP_CONFIG_TOKEN);

	// Required so the shared persistence pool is closed on termination signals.
	app.enableShutdownHooks();

	const openApiDocument = SwaggerModule.createDocument(
		app,
		new DocumentBuilder()
			.setTitle(`${brandOrDefault(config.brand).name} — auxiliary REST`)
			.setVersion("1.0.0")
			.setDescription(
				"Operational endpoints only. The functional contract is MCP over Streamable HTTP (ADR 0004)."
			)
			.build()
	);
	SwaggerModule.setup("docs", app, openApiDocument);

	try {
		await app.listen(config.http.port, "0.0.0.0");
	} catch (error) {
		await app.close();
		throw error;
	}
	app.get<AppLogger>(APP_LOGGER_TOKEN).info("Application listening", { port: config.http.port });
}

void bootstrap().catch((error: unknown) => {
	// Upstream login/configuration failures can contain credentials; do not print their message/stack.
	void error;
	process.stderr.write("Application startup failed\n");
	process.exitCode = 1;
});
