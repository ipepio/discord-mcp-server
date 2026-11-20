import type {
	ChannelPermissionOverwrite,
	MessageAttachmentMetadata,
	NormalizedReplyReference
} from "./normalized-discord-event.js";
import type { NormalizedChannelType, NormalizedMessageType } from "./discord-resource-types.js";

/**
 * Application-typed results of the Discord REST reads (spec R7). These are the only shapes a REST read
 * can return: no discord.js object, no raw payload and no wire field name leaves the boundary.
 *
 * Absent is never empty (R3, guild-state R10): a field Discord did not send stays absent, and an empty
 * list is reported as an empty list, never as a missing one. Completeness is explicit too — a roster that
 * stopped at its page bound says so, and is never reported as the whole Guild (R7 example).
 */

export interface DiscordGuildSnapshot {
	readonly guildId: string;
	readonly name: string;
	readonly ownerId?: string;
	readonly memberCount?: number;
	/** Present only when Discord marked this Guild unavailable for the connection. */
	readonly isUnavailable?: boolean;
}

export interface DiscordRoleRecord {
	readonly guildId: string;
	readonly roleId: string;
	readonly name: string;
	readonly permissionsBitfield: string;
	readonly position: number;
	readonly isManaged?: boolean;
}

export interface DiscordChannelRecord {
	readonly guildId: string;
	readonly channelId: string;
	readonly channelType: NormalizedChannelType;
	readonly position?: number;
	readonly name?: string;
	readonly parentId?: string;
	/** Absent when the channel object carried no overwrite list; an empty list is an explicit empty set. */
	readonly permissionOverwrites?: readonly ChannelPermissionOverwrite[];
}

export interface DiscordMemberRecord {
	readonly guildId: string;
	readonly userId: string;
	/** The whole role set as Discord sent it: consumers replace stored state, never merge (guild-state R5). */
	readonly roleIds: readonly string[];
	readonly username?: string;
	readonly isBot?: boolean;
	readonly nickname?: string;
	readonly joinedInstant?: Date;
	readonly isPending?: boolean;
}

/** Why a roster stopped early. Absent only when the roster is complete. */
export type RosterTruncation = "page-limit" | "member-limit";

export interface DiscordMemberRoster {
	readonly guildId: string;
	readonly members: readonly DiscordMemberRecord[];
	readonly pages: number;
	/** True only when the last page came back short, i.e. Discord had nothing more to give. */
	readonly complete: boolean;
	readonly truncatedBy?: RosterTruncation;
}

export interface DiscordMessageRecord {
	readonly messageId: string;
	readonly channelId: string;
	readonly authorId: string;
	readonly content: string;
	readonly createdInstant: Date;
	readonly editedInstant?: Date;
	readonly messageType: NormalizedMessageType;
	readonly authorUsername?: string;
	readonly authorIsBot?: boolean;
	readonly webhookId?: string;
	readonly isPinned?: boolean;
	readonly replyReference?: NormalizedReplyReference;
	/** Absent when the message object carried no attachment list; an empty list means it has none. */
	readonly attachments?: readonly MessageAttachmentMetadata[];
}

/**
 * One channel history page. Messages keep Discord's own order (R7 boundary: a history read returns pages
 * exactly as Discord ordered them, never re-sorted by the transport). `hasMore` plus `nextBeforeId` are the
 * bounded cursor facts ingestion needs to decide whether to ask for another page; that policy is ingestion's.
 */
export interface DiscordMessageHistoryPage {
	readonly channelId: string;
	readonly messages: readonly DiscordMessageRecord[];
	readonly requestedLimit: number;
	readonly hasMore: boolean;
	/** Present only when there is an older page to ask for. */
	readonly nextBeforeId?: string;
}

export interface DiscordThreadMemberRecord {
	readonly threadId: string;
	readonly userId: string;
	readonly joinInstant?: Date;
}

/** Thread-member read: the endpoint allows a bounded page with an `after` cursor. */
export interface DiscordThreadMemberPage {
	readonly threadId: string;
	readonly members: readonly DiscordThreadMemberRecord[];
	readonly requestedLimit: number;
	readonly hasMore: boolean;
	/** Present only when there is a further page to ask for. */
	readonly nextAfterId?: string;
}
