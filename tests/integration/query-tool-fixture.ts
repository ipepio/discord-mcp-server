import { QueryAccessPolicy } from "../../src/features/query/queries/query-access.policy.js";
import type {
	RegistryAccessReader,
	RegistryStatusReader
} from "../../src/features/query/queries/query-access.policy.js";
import { SearchCandidatesQuery } from "../../src/features/query/queries/search-candidates.query.js";
import { SearchMessagesQuery } from "../../src/features/query/queries/search-messages.query.js";
import { ListChannelsQuery } from "../../src/features/query/queries/list-channels.query.js";
import type { BotViewableChannelsReader } from "../../src/features/query/queries/bot-access.js";
import { GetChannelHistoryQuery } from "../../src/features/query/queries/get-channel-history.query.js";
import { GetThreadMessagesQuery } from "../../src/features/query/queries/get-thread-messages.query.js";
import { GetMessageContextQuery } from "../../src/features/query/queries/get-message-context.query.js";
import { GetRecentActivityQuery } from "../../src/features/query/queries/get-recent-activity.query.js";
import { GetHubStatusQuery } from "../../src/features/query/queries/get-hub-status.query.js";
import type { HybridRetrieval } from "../../src/features/query/queries/hybrid-retrieval.contract.js";
import type { QueryPayloadPolicy } from "../../src/features/query/queries/query-payload.policy.js";
import type {
	ActivityReadRepository,
	MessageReadRepository
} from "../../src/features/query/repositories/message-read.repository.js";
import type { AppLogger } from "../../src/shared/logging/logger.interface.js";
export const queryTestLogger: AppLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	withContext: () => queryTestLogger
};
/**
 * The bot-access axis (query R12) as a double: the bot views exactly `channelIds`. Every other suite keeps its
 * fixtures about the axis it is proving, and `list-channels-ingestible-only` supplies the real registry
 * queries on both axes instead.
 */
export function botViewsChannels(channelIds: readonly string[]): BotViewableChannelsReader {
	return {
		execute: async () => ({
			channels: channelIds.map((channelId) => ({ channelId })),
			botCannotViewChannelIds: [],
			botMembershipRegistered: true
		})
	};
}
export function queryToolFixture(
	messages: MessageReadRepository & ActivityReadRepository,
	registry: RegistryAccessReader,
	retrieval: HybridRetrieval,
	bot: BotViewableChannelsReader,
	status: RegistryStatusReader = { execute: async () => ({ guildId: "1", status: "current" }) },
	extras: { readonly payload?: QueryPayloadPolicy; readonly clock?: () => Date } = {}
) {
	const access = new QueryAccessPolicy(status, registry);
	return {
		list_channels: new ListChannelsQuery(access, bot, "99", extras.payload),
		get_channel_history: new GetChannelHistoryQuery(access, messages, extras.payload),
		get_thread_messages: new GetThreadMessagesQuery(access, messages, extras.payload),
		get_message_context: new GetMessageContextQuery(access, messages, extras.payload),
		get_recent_activity: new GetRecentActivityQuery(access, bot, "99", messages, extras.payload, extras.clock),
		// R17: the status tool composes the same status/seam contracts the gated tools consume, plus R8's
		// identity read; it answers the status instead of refusing under R11.
		get_hub_status: new GetHubStatusQuery(
			status,
			{
				execute: async () => ({
					status: "registered" as const,
					guild: { guildId: "1", guildName: "Fixture guild" }
				})
			},
			access,
			bot,
			"99"
		),
		search_messages: new SearchMessagesQuery(
			access,
			new SearchCandidatesQuery(retrieval, queryTestLogger),
			messages,
			extras.payload
		)
	};
}
