import type { StoredMessage } from "./message.js";
import type { GuildRegistryStatus } from "../../../guild-state/index.js";
export interface MessageResult extends StoredMessage {
	readonly channelName: string;
	readonly parentChannelId: string | null;
	readonly truncated: boolean;
}
export interface ChannelResult {
	readonly channelId: string;
	readonly name: string;
	readonly kind: "channel" | "thread";
	readonly parentChannelId: string | null;
	readonly position: number;
}
export interface Pagination {
	readonly pageSize: number;
	readonly hasNext: boolean;
	readonly nextCursor: string | null;
}
export interface ToolResult {
	readonly data: readonly (MessageResult | ChannelResult | ActivityGroup)[];
	readonly pagination?: Pagination;
	readonly retrieval?: "hybrid" | "full-text-only";
	readonly anchorMessageId?: string;
	readonly windowTruncated?: boolean;
	readonly threadId?: string;
	readonly parentChannelId?: string;
	/** R14's digest envelope: the window the digest decided, and no single page-level cursor. */
	readonly window?: ActivityWindow;
}

/** One container's slice of the digest. `categoryId` is absent by O4's resolution (docs/features/query.md). */
export interface ActivityGroup {
	readonly channelId: string;
	readonly channelName: string;
	readonly parentChannelId: string | null;
	readonly messageCount: number;
	readonly returnedCount: number;
	readonly messages: readonly MessageResult[];
	readonly pagination: Pagination;
}

/** How R14's effective lower bound was decided, reported so a client can state the window it received. */
export interface ActivityWindow {
	readonly since: string | null;
	readonly anchor: "since" | "my-last-message" | "default-24h";
}

/**
 * R17's fourth documented envelope: one status object, with no `data` array and no pagination, because a
 * single status is neither a page nor a group. O11 resolves the identity to `null` (never a placeholder
 * string) while the registry holds no Guild row, and O12 resolves the count to `null` (never `0`, which is a
 * claim) while the registry is not current (docs/features/query.md "Implementation resolutions").
 */
export interface HubStatusResult {
	readonly guild: { readonly name: string | null; readonly id: string | null };
	readonly registry: { readonly status: GuildRegistryStatus };
	readonly mirror: { readonly visibleAndMirroredChannelCount: number | null };
}

/** What a tool handler answers: a page/bounded digest, or R17's status object. */
export type QueryToolResult = ToolResult | HubStatusResult;
