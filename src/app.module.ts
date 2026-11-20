import type { DynamicModule } from "@nestjs/common";
import type { EnvSource } from "./shared/config/app-config.interface.js";
import { loadBrandConfig } from "./shared/config/brand-config.js";
import { loadQueryConfig } from "./shared/config/query-config.factory.js";
import { ApplicationLifecycle } from "./application-lifecycle.js";
import type { ApplicationLifecycleDependencies } from "./application-lifecycle.js";
import {
	DiscordModule,
	DISCORD_CONNECTION_TOKEN,
	DISCORD_SHUTDOWN_TOKEN,
	DISCORD_EVENT_STREAM_TOKEN
} from "./features/discord/index.js";
import {
	GuildStateModule,
	GUILD_STATE_EVENT_SUBSCRIPTION_TOKEN,
	GUILD_STATE_INGESTIBILITY_GAINED_PORT_TOKEN
} from "./features/guild-state/index.js";
import {
	IngestionModule,
	INGESTION_ACCESS_BACKFILL_COMMAND_TOKEN,
	INGESTION_EVENT_SUBSCRIPTION_TOKEN,
	INGESTION_IMPORT_COMMAND_TOKEN
} from "./features/ingestion/index.js";
import { AuthorizationModule } from "./features/authorization/index.js";
import { SemanticIndexModule } from "./features/semantic-index/index.js";
import { QueryModule } from "./features/query/index.js";
import { APP_LOGGER_TOKEN } from "./shared/logging/logging.tokens.js";
import { Module } from "@nestjs/common";
import { ConfigModule } from "./shared/config/config.module.js";
import { HttpModule } from "./shared/http/http.module.js";
import { LoggingModule } from "./shared/logging/logging.module.js";
import { PersistenceModule } from "./shared/persistence/persistence.module.js";

/**
 * Application composition root: shared technical capabilities plus the auxiliary HTTP surface.
 * The static export remains auxiliary-only; forRoot composes the complete installation explicitly.
 */
@Module({
	imports: [ConfigModule, LoggingModule, PersistenceModule, HttpModule]
})
export class AppModule {
	public static forRoot(settings: { readonly botUserId: string; readonly env: EnvSource }): DynamicModule {
		const { botUserId, env } = settings;
		const brand = loadBrandConfig(env);
		// Reuse these exact objects at every edge: calling forRoot twice opens a second connection.
		const discord = DiscordModule.forRoot({ env });
		// The bot's own Membership id is passed where it is a fact about this Installation, and nowhere else: it is
		// what guild-state evaluates a channel's bot viewability for, and what ingestion enumerates with.
		const guildState = GuildStateModule.forRoot({ imports: [discord], botUserId });
		const ingestion = IngestionModule.forRoot({ imports: [discord, guildState], botUserId, env });
		const authorization = AuthorizationModule.forRoot({ imports: [discord, guildState] });
		const semanticIndex = SemanticIndexModule.register(env);
		const query = QueryModule.register({
			imports: [guildState, semanticIndex, authorization],
			config: loadQueryConfig(env),
			brandName: brand.name,
			// O10: the connect-time instructions are composed in the operator's configured locale.
			brandLocale: brand.locale,
			// The same validated identity ingestion enumerates with: R12's bot-access axis is evaluated for it.
			botUserId
		});
		return {
			module: AppModule,
			imports: [ConfigModule.forRoot(env), discord, guildState, ingestion, authorization, semanticIndex, query],
			providers: [
				{
					provide: ApplicationLifecycle,
					inject: [
						DISCORD_CONNECTION_TOKEN,
						DISCORD_SHUTDOWN_TOKEN,
						GUILD_STATE_EVENT_SUBSCRIPTION_TOKEN,
						INGESTION_EVENT_SUBSCRIPTION_TOKEN,
						DISCORD_EVENT_STREAM_TOKEN,
						INGESTION_IMPORT_COMMAND_TOKEN,
						// The access trigger's two ends, joined here and nowhere else: guild-state publishes the fact, and
						// ingestion walks the channel. Neither feature imports the other (S3).
						GUILD_STATE_INGESTIBILITY_GAINED_PORT_TOKEN,
						INGESTION_ACCESS_BACKFILL_COMMAND_TOKEN,
						APP_LOGGER_TOKEN
					],
					useFactory: (
						connection: ApplicationLifecycleDependencies["connection"],
						shutdown: ApplicationLifecycleDependencies["shutdown"],
						guildState: ApplicationLifecycleDependencies["guildState"],
						ingestion: ApplicationLifecycleDependencies["ingestion"],
						events: ApplicationLifecycleDependencies["events"],
						history: ApplicationLifecycleDependencies["history"],
						accessGained: ApplicationLifecycleDependencies["accessGained"],
						accessBackfill: ApplicationLifecycleDependencies["accessBackfill"],
						logger: ApplicationLifecycleDependencies["logger"]
					) =>
						new ApplicationLifecycle({
							connection,
							shutdown,
							guildState,
							ingestion,
							events,
							history,
							accessGained,
							accessBackfill,
							botUserId,
							logger
						})
				}
			]
		};
	}
}
