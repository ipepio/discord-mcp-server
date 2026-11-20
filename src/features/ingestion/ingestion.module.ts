import { Module } from "@nestjs/common";
import type { DynamicModule, ModuleMetadata } from "@nestjs/common";
import type { EnvSource } from "../../shared/config/app-config.interface.js";
import { LoggingModule } from "../../shared/logging/logging.module.js";
import { APP_LOGGER_TOKEN } from "../../shared/logging/logging.tokens.js";
import type { AppLogger } from "../../shared/logging/logger.interface.js";
import { PersistenceModule } from "../../shared/persistence/persistence.module.js";
import { PG_POOL_TOKEN } from "../../shared/persistence/persistence.tokens.js";
import { DISCORD_CONFIG_TOKEN, DISCORD_REST_OPERATIONS_TOKEN, DISCORD_EVENT_STREAM_TOKEN } from "../discord/index.js";
import type { DiscordConfig, DiscordRestOperations, DiscordEventConsumer } from "../discord/index.js";
import { GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN } from "../guild-state/index.js";
import type { IngestionConfig, ImportWindowInput } from "./config/ingestion-config.interface.js";
import { createIngestionConfig } from "./config/ingestion-config.interface.js";
import {
	loadIngestionCatchUpConfig,
	loadIngestionImportWindow,
	loadIngestionResyncConfig
} from "./config/ingestion-config.validator.js";
import type { IngestibleChannelRegistry } from "./gateways/channel-registry-gateway.interface.js";
import { IngestionEventSubscription } from "./gateways/ingestion-event-subscription.gateway.js";
import { RecordMessageCommand } from "./commands/record-message.command.js";
import { ApplyMessageEditCommand } from "./commands/apply-message-edit.command.js";
import { ApplyMessageDeletionCommand } from "./commands/apply-message-deletion.command.js";
import { ExcludeChannelMessagesCommand } from "./commands/exclude-channel-messages.command.js";
import { BackfillChannelHistoryCommand } from "./commands/backfill-channel-history.command.js";
import { BackfillChannelAccessCommand } from "./commands/backfill-channel-access.command.js";
import { ImportChannelHistoryCommand } from "./commands/import-channel-history.command.js";
import { CatchUpOutstandingChannelsCommand } from "./commands/catch-up-outstanding-channels.command.js";
import { ResyncMessageHistoryCommand } from "./commands/resync-message-history.command.js";
import { IngestionCatchUpWorker } from "./ingestion-catch-up.worker.js";
import type { ImportProgressRepository } from "./repositories/import-progress.repository.js";
import { PostgresImportProgressRepository } from "./repositories/postgres-import-progress.repository.js";
import { PostgresMessageStoreRepository } from "./repositories/postgres-message-store.repository.js";
import type { MessageStoreRepository } from "./repositories/message-store.repository.js";
import { createSqlExecutor } from "./repositories/sql-executor.js";
import type { SqlClientSource } from "./repositories/sql-executor.js";
import {
	INGESTION_CONFIG_TOKEN,
	INGESTION_LOGGER_TOKEN,
	INGESTION_MESSAGE_STORE_TOKEN,
	INGESTION_RECORD_COMMAND_TOKEN,
	INGESTION_EDIT_COMMAND_TOKEN,
	INGESTION_DELETE_COMMAND_TOKEN,
	INGESTION_EXCLUDE_COMMAND_TOKEN,
	INGESTION_BACKFILL_COMMAND_TOKEN,
	INGESTION_ACCESS_BACKFILL_COMMAND_TOKEN,
	INGESTION_IMPORT_COMMAND_TOKEN,
	INGESTION_RESYNC_COMMAND_TOKEN,
	INGESTION_PROGRESS_REPOSITORY_TOKEN,
	INGESTION_CATCH_UP_COMMAND_TOKEN,
	INGESTION_CATCH_UP_WORKER_TOKEN,
	INGESTION_EVENT_SUBSCRIPTION_TOKEN
} from "./ingestion.tokens.js";

export type IngestionModuleSettings = {
	/** Composition supplies the Discord and guild-state modules, using their public tokens only. */
	readonly imports: NonNullable<ModuleMetadata["imports"]>;
	/** Learned connection identity, not a new environment variable. */
	readonly botUserId: string;
	readonly logger?: AppLogger;
	readonly clock?: () => Date;
} & (
	| { readonly env: EnvSource; readonly importWindow?: never }
	| { readonly importWindow: ImportWindowInput; readonly env?: never }
);

/** Provides resolved instances only: composition explicitly subscribes the binding and launches import
 * independently, so a history job never occupies the Gateway event delivery queue (R3).
 */
@Module({ imports: [LoggingModule, PersistenceModule] })
export class IngestionModule {
	public static forRoot(settings: IngestionModuleSettings): DynamicModule {
		// Fail startup before any provider can open network connections.
		const window = settings.importWindow ?? loadIngestionImportWindow(settings.env);
		// R14: absent variables keep their documented defaults, and a value that is present and wrong fails startup.
		const catchUp = settings.env === undefined ? {} : loadIngestionCatchUpConfig(settings.env);
		// R9: the same rule for the resync's page bound, so a restart cannot re-read a channel's whole mirror.
		const resync = settings.env === undefined ? {} : loadIngestionResyncConfig(settings.env);
		return {
			module: IngestionModule,
			imports: settings.imports,
			providers: [
				{
					provide: INGESTION_CONFIG_TOKEN,
					useFactory: (discord: DiscordConfig) =>
						createIngestionConfig({
							guildId: discord.guildId,
							importWindow: window,
							...catchUp,
							...resync
						}),
					inject: [DISCORD_CONFIG_TOKEN]
				},
				{
					provide: INGESTION_LOGGER_TOKEN,
					useFactory: (logger: AppLogger) => settings.logger ?? logger.withContext({ feature: "ingestion" }),
					inject: [APP_LOGGER_TOKEN]
				},
				{
					provide: INGESTION_MESSAGE_STORE_TOKEN,
					useFactory: (pool: SqlClientSource, config: IngestionConfig) =>
						new PostgresMessageStoreRepository({ executor: createSqlExecutor(pool), ...config.store }),
					inject: [PG_POOL_TOKEN, INGESTION_CONFIG_TOKEN]
				},
				{
					provide: INGESTION_PROGRESS_REPOSITORY_TOKEN,
					// R14's ledger: one table, the same driver-free executor the message store takes, no configuration.
					useFactory: (pool: SqlClientSource) =>
						new PostgresImportProgressRepository(createSqlExecutor(pool)),
					inject: [PG_POOL_TOKEN]
				},
				{
					provide: INGESTION_RECORD_COMMAND_TOKEN,
					useFactory: (config: IngestionConfig, messageStore: MessageStoreRepository, logger: AppLogger) =>
						new RecordMessageCommand({ config, messageStore, logger }),
					inject: [INGESTION_CONFIG_TOKEN, INGESTION_MESSAGE_STORE_TOKEN, INGESTION_LOGGER_TOKEN]
				},
				{
					provide: INGESTION_EDIT_COMMAND_TOKEN,
					useFactory: (
						config: IngestionConfig,
						messageStore: MessageStoreRepository,
						logger: AppLogger,
						rest: DiscordRestOperations
					) => new ApplyMessageEditCommand({ config, messageStore, logger, messageRest: rest }),
					inject: [
						INGESTION_CONFIG_TOKEN,
						INGESTION_MESSAGE_STORE_TOKEN,
						INGESTION_LOGGER_TOKEN,
						DISCORD_REST_OPERATIONS_TOKEN
					]
				},
				{
					provide: INGESTION_DELETE_COMMAND_TOKEN,
					useFactory: (config: IngestionConfig, messageStore: MessageStoreRepository, logger: AppLogger) =>
						new ApplyMessageDeletionCommand({
							config,
							messageStore,
							logger,
							...(settings.clock === undefined ? {} : { clock: settings.clock })
						}),
					inject: [INGESTION_CONFIG_TOKEN, INGESTION_MESSAGE_STORE_TOKEN, INGESTION_LOGGER_TOKEN]
				},
				{
					provide: INGESTION_EXCLUDE_COMMAND_TOKEN,
					useFactory: (config: IngestionConfig, messageStore: MessageStoreRepository, logger: AppLogger) =>
						new ExcludeChannelMessagesCommand({ config, messageStore, logger }),
					inject: [INGESTION_CONFIG_TOKEN, INGESTION_MESSAGE_STORE_TOKEN, INGESTION_LOGGER_TOKEN]
				},
				{
					provide: INGESTION_BACKFILL_COMMAND_TOKEN,
					useFactory: (
						config: IngestionConfig,
						messageStore: MessageStoreRepository,
						logger: AppLogger,
						history: DiscordRestOperations
					) => new BackfillChannelHistoryCommand({ config, messageStore, logger, history }),
					inject: [
						INGESTION_CONFIG_TOKEN,
						INGESTION_MESSAGE_STORE_TOKEN,
						INGESTION_LOGGER_TOKEN,
						DISCORD_REST_OPERATIONS_TOKEN
					]
				},
				{
					provide: INGESTION_ACCESS_BACKFILL_COMMAND_TOKEN,
					// One channel, one walk, the bootstrap window: the other side of guild-state's access-trigger port
					// (S1, S3). It starts nothing by itself — the lifecycle binds the port that reaches it — and it reuses
					// the walk above rather than a second paging loop.
					useFactory: (
						config: IngestionConfig,
						backfill: BackfillChannelHistoryCommand,
						logger: AppLogger
					): BackfillChannelAccessCommand =>
						new BackfillChannelAccessCommand({
							config,
							backfill,
							logger,
							...(settings.clock === undefined ? {} : { clock: settings.clock })
						}),
					inject: [INGESTION_CONFIG_TOKEN, INGESTION_BACKFILL_COMMAND_TOKEN, INGESTION_LOGGER_TOKEN]
				},
				{
					provide: INGESTION_IMPORT_COMMAND_TOKEN,
					useFactory: (
						config: IngestionConfig,
						channels: IngestibleChannelRegistry,
						backfill: BackfillChannelHistoryCommand,
						progress: ImportProgressRepository,
						logger: AppLogger
					) =>
						new ImportChannelHistoryCommand({
							config,
							channels,
							backfill,
							progress,
							logger,
							...(settings.clock === undefined ? {} : { clock: settings.clock })
						}),
					inject: [
						INGESTION_CONFIG_TOKEN,
						GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN,
						INGESTION_BACKFILL_COMMAND_TOKEN,
						INGESTION_PROGRESS_REPOSITORY_TOKEN,
						INGESTION_LOGGER_TOKEN
					]
				},
				{
					provide: INGESTION_CATCH_UP_COMMAND_TOKEN,
					// R14's bounded tick: the same walk the import uses, over the durable ledger's outstanding page.
					useFactory: (
						config: IngestionConfig,
						progress: ImportProgressRepository,
						backfill: BackfillChannelHistoryCommand,
						logger: AppLogger
					) =>
						new CatchUpOutstandingChannelsCommand({
							config,
							progress,
							backfill,
							logger,
							...(settings.clock === undefined ? {} : { clock: settings.clock })
						}),
					inject: [
						INGESTION_CONFIG_TOKEN,
						INGESTION_PROGRESS_REPOSITORY_TOKEN,
						INGESTION_BACKFILL_COMMAND_TOKEN,
						INGESTION_LOGGER_TOKEN
					]
				},
				{
					provide: INGESTION_CATCH_UP_WORKER_TOKEN,
					// Nest calls its own `onModuleInit` / `beforeApplicationShutdown`: the job starts with the application and
					// drains before the pool closes, exactly as the embedding worker does.
					useFactory: (
						command: CatchUpOutstandingChannelsCommand,
						config: IngestionConfig,
						logger: AppLogger
					) => new IngestionCatchUpWorker(command, config, logger),
					inject: [INGESTION_CATCH_UP_COMMAND_TOKEN, INGESTION_CONFIG_TOKEN, INGESTION_LOGGER_TOKEN]
				},
				{
					provide: INGESTION_RESYNC_COMMAND_TOKEN,
					useFactory: (
						config: IngestionConfig,
						channels: IngestibleChannelRegistry,
						backfill: BackfillChannelHistoryCommand,
						logger: AppLogger
					) => new ResyncMessageHistoryCommand({ config, channels, backfill, logger }),
					inject: [
						INGESTION_CONFIG_TOKEN,
						GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN,
						INGESTION_BACKFILL_COMMAND_TOKEN,
						INGESTION_LOGGER_TOKEN
					]
				},
				{
					provide: INGESTION_EVENT_SUBSCRIPTION_TOKEN,
					useFactory: (
						config: IngestionConfig,
						consumer: DiscordEventConsumer,
						logger: AppLogger,
						record: RecordMessageCommand,
						edit: ApplyMessageEditCommand,
						remove: ApplyMessageDeletionCommand,
						exclude: ExcludeChannelMessagesCommand,
						resync: ResyncMessageHistoryCommand
					) =>
						new IngestionEventSubscription({
							config,
							consumer,
							logger,
							record,
							edit,
							remove,
							exclude,
							resync,
							botUserId: settings.botUserId,
							...(settings.clock === undefined ? {} : { clock: settings.clock })
						}),
					inject: [
						INGESTION_CONFIG_TOKEN,
						DISCORD_EVENT_STREAM_TOKEN,
						INGESTION_LOGGER_TOKEN,
						INGESTION_RECORD_COMMAND_TOKEN,
						INGESTION_EDIT_COMMAND_TOKEN,
						INGESTION_DELETE_COMMAND_TOKEN,
						INGESTION_EXCLUDE_COMMAND_TOKEN,
						INGESTION_RESYNC_COMMAND_TOKEN
					]
				}
			],
			exports: [
				INGESTION_IMPORT_COMMAND_TOKEN,
				INGESTION_EVENT_SUBSCRIPTION_TOKEN,
				INGESTION_ACCESS_BACKFILL_COMMAND_TOKEN
			]
		};
	}
}
