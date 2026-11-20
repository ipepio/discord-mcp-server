export const QUERY_TOOL_NAMES = [
	"search_messages",
	"list_channels",
	"get_channel_history",
	"get_thread_messages",
	"get_message_context",
	"get_recent_activity",
	// R17: the seventh tool, whose input is the empty closed object and whose answer is the hub's status.
	"get_hub_status"
] as const;
export type QueryToolName = (typeof QUERY_TOOL_NAMES)[number];
export interface ToolInput {
	readonly query?: string;
	readonly channelId?: string;
	readonly threadId?: string;
	readonly messageId?: string;
	readonly authorId?: string;
	readonly from?: string;
	readonly to?: string;
	/** R14's explicit lower bound; one window per call, so never together with `sinceByMyLastMessage`. */
	readonly since?: string;
	/** R14's anchor mode: the lower bound becomes the Requester's own newest message. */
	readonly sinceByMyLastMessage?: boolean;
	readonly pageSize: number;
	readonly windowSize: number;
	readonly cursor?: string;
}
export interface CursorKey {
	readonly messageId?: string;
	readonly createdAt?: string;
	readonly position?: number;
	readonly channelId?: string;
	readonly rank?: number;
}
