/** Intentional read-only public capability; no SQL, repository token, command or external provider. */
export { QueryModule } from "./query.module.js";
export type { QueryModuleSettings } from "./query.module.js";
export { QueryToolsAdapter, QueryAuthenticationError } from "./mcp/query-tools.adapter.js";
export type { QuerySessionIdentity, QueryToolHandlers } from "./mcp/query-tools.adapter.js";
export { SearchMessagesQuery } from "./queries/search-messages.query.js";
export { ListChannelsQuery } from "./queries/list-channels.query.js";
export { GetChannelHistoryQuery } from "./queries/get-channel-history.query.js";
export { GetThreadMessagesQuery } from "./queries/get-thread-messages.query.js";
export { GetMessageContextQuery } from "./queries/get-message-context.query.js";
export { GetRecentActivityQuery } from "./queries/get-recent-activity.query.js";
export { GetHubStatusQuery } from "./queries/get-hub-status.query.js";
export { GetServerMetadataQuery } from "./queries/get-server-metadata.query.js";
export type { HybridRetrieval, HybridRetrievalInput, HybridCandidate } from "./queries/hybrid-retrieval.contract.js";
export type { ToolInput, QueryToolName } from "./models/domain/tool-input.js";
export type {
	ToolResult,
	QueryToolResult,
	HubStatusResult,
	MessageResult,
	ChannelResult,
	ActivityGroup,
	ActivityWindow
} from "./models/domain/tool-result.js";
export { QueryError } from "./models/domain/query.errors.js";
export { QUERY_TOOL_SCHEMAS } from "./models/dtos/tool-schema.dto.js";
export {
	QUERY_HYBRID_RETRIEVAL_TOKEN,
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
