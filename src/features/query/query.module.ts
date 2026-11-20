import { Module } from "@nestjs/common";
import type { DynamicModule, ModuleMetadata } from "@nestjs/common";
import {
	GUILD_STATE_STATUS_QUERY_TOKEN,
	GUILD_STATE_USER_ACCESSIBLE_CHANNELS_QUERY_TOKEN,
	GUILD_STATE_GUILD_IDENTITY_QUERY_TOKEN,
	GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN
} from "../guild-state/index.js";
import type { GetGuildIdentityQuery } from "../guild-state/index.js";
import type { QueryConfig } from "../../shared/config/query-config.factory.js";
import type { AppLogger } from "../../shared/logging/logger.interface.js";
import { APP_LOGGER_TOKEN } from "../../shared/logging/logging.tokens.js";
import { LoggingModule } from "../../shared/logging/logging.module.js";
import { PG_POOL_TOKEN } from "../../shared/persistence/persistence.tokens.js";
import { PersistenceModule } from "../../shared/persistence/persistence.module.js";
import { PostgresMessageReadRepository } from "./repositories/postgres-message-read.repository.js";
import type { QuerySqlExecutor } from "./repositories/postgres-message-read.repository.js";
import type { MessageReadRepository } from "./repositories/message-read.repository.js";
import type { ActivityReadRepository } from "./repositories/message-read.repository.js";
import { QueryAccessPolicy } from "./queries/query-access.policy.js";
import type { RegistryStatusReader, RegistryAccessReader } from "./queries/query-access.policy.js";
import { QueryPayloadPolicy } from "./queries/query-payload.policy.js";
import type { HybridRetrieval } from "./queries/hybrid-retrieval.contract.js";
import { SearchCandidatesQuery } from "./queries/search-candidates.query.js";
import { SearchMessagesQuery } from "./queries/search-messages.query.js";
import { ListChannelsQuery } from "./queries/list-channels.query.js";
import type { BotViewableChannelsReader } from "./queries/list-channels.query.js";
import { GetChannelHistoryQuery } from "./queries/get-channel-history.query.js";
import { GetThreadMessagesQuery } from "./queries/get-thread-messages.query.js";
import { GetMessageContextQuery } from "./queries/get-message-context.query.js";
import { GetRecentActivityQuery } from "./queries/get-recent-activity.query.js";
import { GetHubStatusQuery } from "./queries/get-hub-status.query.js";
import { GetServerMetadataQuery } from "./queries/get-server-metadata.query.js";
import { McpController } from "./controllers/mcp.controller.js";
import { QueryToolsAdapter } from "./mcp/query-tools.adapter.js";
import {
	QUERY_HYBRID_RETRIEVAL_TOKEN,
	QUERY_PAYLOAD_TOKEN,
	QUERY_ACCESS_TOKEN,
	QUERY_MESSAGE_READ_TOKEN,
	QUERY_SEARCH_CANDIDATES_TOKEN,
	QUERY_SEARCH_MESSAGES_TOKEN,
	QUERY_LIST_CHANNELS_TOKEN,
	QUERY_CHANNEL_HISTORY_TOKEN,
	QUERY_THREAD_MESSAGES_TOKEN,
	QUERY_MESSAGE_CONTEXT_TOKEN,
	QUERY_RECENT_ACTIVITY_TOKEN,
	QUERY_HUB_STATUS_TOKEN,
	QUERY_SERVER_METADATA_TOKEN,
	QUERY_TOOLS_ADAPTER_TOKEN
} from "./query.tokens.js";

export interface QueryModuleSettings {
	/** The MCP server metadata and login pages announce this deployment identity. */
	readonly brandName?: string;
	/** O10: the interface locale R15's instruction text is composed in; English when it is unset. */
	readonly brandLocale?: "es" | "en";
	/**
	 * The bot's own Discord User id, from the same validated startup configuration ingestion uses. R12's
	 * bot-access axis is evaluated for this Membership per call; the id never arrives from a tool argument (R1).
	 */
	readonly botUserId: string;
	/** Root supplies modules exporting the registry public tokens and the hybrid retrieval contract token. */
	readonly imports: NonNullable<ModuleMetadata["imports"]>;
	/** Root validates startup environment through loadQueryConfig; no environment read inside this feature. */
	readonly config: QueryConfig;
}
@Module({})
export class QueryModule {
	public static register(settings: QueryModuleSettings): DynamicModule {
		return {
			module: QueryModule,
			imports: [LoggingModule, PersistenceModule, ...settings.imports],
			controllers: [McpController],
			providers: [
				{ provide: QUERY_PAYLOAD_TOKEN, useFactory: () => new QueryPayloadPolicy(settings.config) },
				{
					provide: QUERY_MESSAGE_READ_TOKEN,
					inject: [PG_POOL_TOKEN],
					useFactory: (pool: QuerySqlExecutor) => new PostgresMessageReadRepository(pool)
				},
				{
					provide: QUERY_ACCESS_TOKEN,
					inject: [GUILD_STATE_STATUS_QUERY_TOKEN, GUILD_STATE_USER_ACCESSIBLE_CHANNELS_QUERY_TOKEN],
					useFactory: (status: RegistryStatusReader, registry: RegistryAccessReader) =>
						new QueryAccessPolicy(status, registry)
				},
				{
					provide: QUERY_SEARCH_CANDIDATES_TOKEN,
					inject: [QUERY_HYBRID_RETRIEVAL_TOKEN, APP_LOGGER_TOKEN],
					useFactory: (retrieval: HybridRetrieval, logger: AppLogger) =>
						new SearchCandidatesQuery(retrieval, logger)
				},
				{
					provide: QUERY_LIST_CHANNELS_TOKEN,
					// R12: the entry set is the intersection of the Requester's viewable entries and the bot-viewable
					// ones, so the ingestible-channels contract is injected beside the access policy and the bot's own
					// User id is supplied by composition configuration, never by a tool argument.
					inject: [QUERY_ACCESS_TOKEN, GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN, QUERY_PAYLOAD_TOKEN],
					useFactory: (
						access: QueryAccessPolicy,
						bot: BotViewableChannelsReader,
						payload: QueryPayloadPolicy
					) => new ListChannelsQuery(access, bot, settings.botUserId, payload)
				},
				{
					provide: QUERY_CHANNEL_HISTORY_TOKEN,
					inject: [QUERY_ACCESS_TOKEN, QUERY_MESSAGE_READ_TOKEN, QUERY_PAYLOAD_TOKEN],
					useFactory: (
						access: QueryAccessPolicy,
						messages: MessageReadRepository,
						payload: QueryPayloadPolicy
					) => new GetChannelHistoryQuery(access, messages, payload)
				},
				{
					provide: QUERY_THREAD_MESSAGES_TOKEN,
					inject: [QUERY_ACCESS_TOKEN, QUERY_MESSAGE_READ_TOKEN, QUERY_PAYLOAD_TOKEN],
					useFactory: (
						access: QueryAccessPolicy,
						messages: MessageReadRepository,
						payload: QueryPayloadPolicy
					) => new GetThreadMessagesQuery(access, messages, payload)
				},
				{
					provide: QUERY_MESSAGE_CONTEXT_TOKEN,
					inject: [QUERY_ACCESS_TOKEN, QUERY_MESSAGE_READ_TOKEN, QUERY_PAYLOAD_TOKEN],
					useFactory: (
						access: QueryAccessPolicy,
						messages: MessageReadRepository,
						payload: QueryPayloadPolicy
					) => new GetMessageContextQuery(access, messages, payload)
				},
				{
					provide: QUERY_SEARCH_MESSAGES_TOKEN,
					inject: [
						QUERY_ACCESS_TOKEN,
						QUERY_SEARCH_CANDIDATES_TOKEN,
						QUERY_MESSAGE_READ_TOKEN,
						QUERY_PAYLOAD_TOKEN
					],
					useFactory: (
						access: QueryAccessPolicy,
						search: SearchCandidatesQuery,
						messages: MessageReadRepository,
						payload: QueryPayloadPolicy
					) => new SearchMessagesQuery(access, search, messages, payload)
				},
				{
					provide: QUERY_RECENT_ACTIVITY_TOKEN,
					// R14: the digest composes R12's intersection (access policy + the ingestible contract) with one
					// grouped count and one partitioned page read; the bot's User id comes from composition, never a
					// tool argument, and the clock is the process clock the query-time `now` is read from.
					inject: [
						QUERY_ACCESS_TOKEN,
						GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN,
						QUERY_MESSAGE_READ_TOKEN,
						QUERY_PAYLOAD_TOKEN
					],
					useFactory: (
						access: QueryAccessPolicy,
						bot: BotViewableChannelsReader,
						messages: ActivityReadRepository,
						payload: QueryPayloadPolicy
					) => new GetRecentActivityQuery(access, bot, settings.botUserId, messages, payload)
				},
				{
					provide: QUERY_HUB_STATUS_TOKEN,
					// R17: the count composes the same two axes the other tools consume (visibility gate + the
					// ingestible contract), and the status/identity reads are the contracts R8 and R11 already use.
					// It is not gated by R11 here: the use case reads the status itself and reports it.
					inject: [
						GUILD_STATE_STATUS_QUERY_TOKEN,
						GUILD_STATE_GUILD_IDENTITY_QUERY_TOKEN,
						QUERY_ACCESS_TOKEN,
						GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN
					],
					useFactory: (
						status: RegistryStatusReader,
						identity: Pick<GetGuildIdentityQuery, "execute">,
						access: QueryAccessPolicy,
						bot: BotViewableChannelsReader
					) => new GetHubStatusQuery(status, identity, access, bot, settings.botUserId)
				},
				{
					provide: QUERY_SERVER_METADATA_TOKEN,
					inject: [GUILD_STATE_STATUS_QUERY_TOKEN, GUILD_STATE_GUILD_IDENTITY_QUERY_TOKEN, APP_LOGGER_TOKEN],
					useFactory: (
						status: RegistryStatusReader,
						identity: Pick<GetGuildIdentityQuery, "execute">,
						logger: AppLogger
					) =>
						new GetServerMetadataQuery(
							status,
							identity,
							logger,
							settings.brandName ?? "Discord MCP Server",
							settings.brandLocale ?? "en"
						)
				},
				{
					provide: QUERY_TOOLS_ADAPTER_TOKEN,
					inject: [
						QUERY_SEARCH_MESSAGES_TOKEN,
						QUERY_LIST_CHANNELS_TOKEN,
						QUERY_CHANNEL_HISTORY_TOKEN,
						QUERY_THREAD_MESSAGES_TOKEN,
						QUERY_MESSAGE_CONTEXT_TOKEN,
						QUERY_RECENT_ACTIVITY_TOKEN,
						QUERY_HUB_STATUS_TOKEN,
						QUERY_SERVER_METADATA_TOKEN
					],
					useFactory: (
						search: SearchMessagesQuery,
						list: ListChannelsQuery,
						history: GetChannelHistoryQuery,
						thread: GetThreadMessagesQuery,
						context: GetMessageContextQuery,
						activity: GetRecentActivityQuery,
						hubStatus: GetHubStatusQuery,
						metadata: GetServerMetadataQuery
					) =>
						new QueryToolsAdapter(
							{
								search_messages: search,
								list_channels: list,
								get_channel_history: history,
								get_thread_messages: thread,
								get_message_context: context,
								get_recent_activity: activity,
								get_hub_status: hubStatus
							},
							metadata
						)
				}
			],
			exports: [
				QUERY_TOOLS_ADAPTER_TOKEN,
				QUERY_SERVER_METADATA_TOKEN,
				QUERY_SEARCH_MESSAGES_TOKEN,
				QUERY_LIST_CHANNELS_TOKEN,
				QUERY_CHANNEL_HISTORY_TOKEN,
				QUERY_THREAD_MESSAGES_TOKEN,
				QUERY_MESSAGE_CONTEXT_TOKEN,
				QUERY_RECENT_ACTIVITY_TOKEN,
				QUERY_HUB_STATUS_TOKEN
			]
		};
	}
}
