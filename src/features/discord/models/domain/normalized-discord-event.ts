import { DiscordEventKind } from "./discord-event-kind.enum.js";
import type {
	NormalizedChannelType,
	NormalizedMessageType,
	NormalizedOverwriteTargetType
} from "./discord-resource-types.js";

/**
 * Normalized application events published on the internal stream (spec R3). These are plain
 * framework-free types: no discord.js object, no raw payload and no wire field name crosses here.
 * Every event carries the configured Guild id — the source filter ran before normalization (R2).
 *
 * Absent versus empty is a deliberate distinction (R3, guild-state R10): an optional field is
 * simply not present when Discord did not send it, and is never filled with an empty value.
 */

/** Fields every normalized event carries. */
export interface NormalizedEventBase {
	readonly guildId: string;
}

export interface MessageAttachmentMetadata {
	readonly attachmentId: string;
	readonly filename: string;
	readonly url: string;
	readonly sizeBytes: number;
	/** Absent when Discord sent no content type; deliberately not an empty string. */
	readonly contentType?: string;
}

/** Message text, in memory only: ingestion stores it and no log line may carry it (R3, R11). */

/** Reply reference as an application fact: absent when the message replies to nothing. */
export interface NormalizedReplyReference {
	readonly messageId: string;
	readonly channelId?: string;
	readonly guildId?: string;
}

export interface MessageCreatedEvent extends NormalizedEventBase {
	readonly kind: typeof DiscordEventKind.messageCreated;
	readonly messageId: string;
	readonly channelId: string;
	readonly authorId: string;
	readonly authorUsername?: string;
	readonly authorIsBot?: boolean;
	/** Present only when the message arrived through a webhook. */
	readonly webhookId?: string;
	readonly content: string;
	readonly createdInstant: Date;
	readonly editedInstant?: Date;
	readonly messageType: NormalizedMessageType;
	readonly replyReference?: NormalizedReplyReference;
	/** Absent when the payload carried no attachment list; an empty list means the message has none. */
	readonly attachments?: readonly MessageAttachmentMetadata[];
}

export interface MessageUpdatedEvent extends NormalizedEventBase {
	readonly kind: typeof DiscordEventKind.messageUpdated;
	readonly messageId: string;
	readonly channelId: string;
	/** Present only when the update payload carried content (R3: absent is not empty). */
	readonly content?: string;
	readonly editedInstant?: Date;
	readonly messageType?: NormalizedMessageType;
}

export interface MessageDeletedEvent extends NormalizedEventBase {
	readonly kind: typeof DiscordEventKind.messageDeleted;
	readonly messageId: string;
	readonly channelId: string;
}

export interface MessageBulkDeletedEvent extends NormalizedEventBase {
	readonly kind: typeof DiscordEventKind.messageBulkDeleted;
	readonly channelId: string;
	readonly messageIds: readonly string[];
}

/** Permission overwrite entry as an application fact (guild-state R7 replaces whole sets). */
export interface ChannelPermissionOverwrite {
	readonly targetId: string;
	readonly targetType: NormalizedOverwriteTargetType;
	readonly allowBitfield: string;
	readonly denyBitfield: string;
}

export interface ChannelCreatedEvent extends NormalizedEventBase {
	readonly kind: typeof DiscordEventKind.channelCreated;
	readonly channelId: string;
	readonly channelType: NormalizedChannelType;
	readonly name?: string;
	readonly parentId?: string;
	/** Absent when the payload carried no overwrite set; an empty array means an explicit empty set. */
	readonly permissionOverwrites?: readonly ChannelPermissionOverwrite[];
}

export interface ChannelUpdatedEvent extends NormalizedEventBase {
	readonly kind: typeof DiscordEventKind.channelUpdated;
	readonly channelId: string;
	readonly channelType: NormalizedChannelType;
	readonly name?: string;
	readonly parentId?: string;
	readonly permissionOverwrites?: readonly ChannelPermissionOverwrite[];
}

export interface ChannelDeletedEvent extends NormalizedEventBase {
	readonly kind: typeof DiscordEventKind.channelDeleted;
	readonly channelId: string;
	readonly channelType: NormalizedChannelType;
}

export interface ThreadCreatedEvent extends NormalizedEventBase {
	readonly kind: typeof DiscordEventKind.threadCreated;
	readonly threadId: string;
	readonly parentChannelId?: string;
	readonly name?: string;
	readonly archived?: boolean;
	readonly threadType: NormalizedChannelType;
	/** Present only when the payload enumerated initial members (private-thread creation). */
	readonly memberIds?: readonly string[];
}

export interface ThreadUpdatedEvent extends NormalizedEventBase {
	readonly kind: typeof DiscordEventKind.threadUpdated;
	readonly threadId: string;
	readonly parentChannelId?: string;
	readonly name?: string;
	readonly archived?: boolean;
	readonly threadType: NormalizedChannelType;
}

export interface ThreadDeletedEvent extends NormalizedEventBase {
	readonly kind: typeof DiscordEventKind.threadDeleted;
	readonly threadId: string;
	readonly parentChannelId?: string;
}

export interface GuildUpdatedEvent extends NormalizedEventBase {
	readonly kind: typeof DiscordEventKind.guildUpdated;
	readonly guildName?: string;
	readonly ownerId?: string;
	readonly memberCount?: number;
}

export interface RoleCreatedEvent extends NormalizedEventBase {
	readonly kind: typeof DiscordEventKind.roleCreated;
	readonly roleId: string;
	readonly roleName?: string;
	readonly permissionsBitfield?: string;
}

export interface RoleUpdatedEvent extends NormalizedEventBase {
	readonly kind: typeof DiscordEventKind.roleUpdated;
	readonly roleId: string;
	readonly roleName?: string;
	readonly permissionsBitfield?: string;
}

export interface RoleDeletedEvent extends NormalizedEventBase {
	readonly kind: typeof DiscordEventKind.roleDeleted;
	readonly roleId: string;
}

export interface MemberAddedEvent extends NormalizedEventBase {
	readonly kind: typeof DiscordEventKind.memberAdded;
	readonly userId: string;
	/** The complete role set at that instant: consumers replace, never merge (guild-state R5). */
	readonly roleIds: readonly string[];
	readonly nickname?: string;
	readonly joinedInstant?: Date;
	readonly isPending?: boolean;
}

export interface MemberUpdatedEvent extends NormalizedEventBase {
	readonly kind: typeof DiscordEventKind.memberUpdated;
	readonly userId: string;
	readonly roleIds: readonly string[];
	readonly nickname?: string;
	readonly joinedInstant?: Date;
	readonly isPending?: boolean;
}

export interface MemberRemovedEvent extends NormalizedEventBase {
	readonly kind: typeof DiscordEventKind.memberRemoved;
	readonly userId: string;
}

export interface ThreadMemberAddedEvent extends NormalizedEventBase {
	readonly kind: typeof DiscordEventKind.threadMemberAdded;
	readonly threadId: string;
	readonly userId: string;
}

export interface ThreadMemberRemovedEvent extends NormalizedEventBase {
	readonly kind: typeof DiscordEventKind.threadMemberRemoved;
	readonly threadId: string;
	readonly userId: string;
}

/**
 * The gap signal (spec R5, R4). `affectedKinds` is absent for a whole-connection gap and present
 * when the gap is narrowed to specific kinds (a dropped delivery, a drain expiry).
 */
export interface ResyncNeededEvent extends NormalizedEventBase {
	readonly kind: typeof DiscordEventKind.resyncNeeded;
	readonly epoch: number;
	readonly reconnectAttempts: number;
	/** Absent when nothing was delivered before the gap. */
	readonly lastDeliveredInstant?: Date;
	readonly affectedKinds?: readonly DiscordEventKind[];
}

export type NormalizedDiscordEvent =
	| MessageCreatedEvent
	| MessageUpdatedEvent
	| MessageDeletedEvent
	| MessageBulkDeletedEvent
	| ChannelCreatedEvent
	| ChannelUpdatedEvent
	| ChannelDeletedEvent
	| ThreadCreatedEvent
	| ThreadUpdatedEvent
	| ThreadDeletedEvent
	| GuildUpdatedEvent
	| RoleCreatedEvent
	| RoleUpdatedEvent
	| RoleDeletedEvent
	| MemberAddedEvent
	| MemberUpdatedEvent
	| MemberRemovedEvent
	| ThreadMemberAddedEvent
	| ThreadMemberRemovedEvent
	| ResyncNeededEvent;

/** The event type published for one enumerated kind. */
export type NormalizedEventOf<K extends DiscordEventKind> = Extract<NormalizedDiscordEvent, { readonly kind: K }>;

/**
 * Log-safe identifiers of an event (spec R11): ids, kinds and counts only — never content,
 * never attachment data, never a credential.
 */
export function describeEventIds(event: NormalizedDiscordEvent): Record<string, string | number> {
	const ids: Record<string, string | number> = { kind: event.kind, guildId: event.guildId };

	switch (event.kind) {
		case DiscordEventKind.messageCreated:
		case DiscordEventKind.messageUpdated:
		case DiscordEventKind.messageDeleted:
			ids["messageId"] = event.messageId;
			ids["channelId"] = event.channelId;
			break;
		case DiscordEventKind.messageBulkDeleted:
			ids["channelId"] = event.channelId;
			ids["messageCount"] = event.messageIds.length;
			break;
		case DiscordEventKind.channelCreated:
		case DiscordEventKind.channelUpdated:
		case DiscordEventKind.channelDeleted:
			ids["channelId"] = event.channelId;
			break;
		case DiscordEventKind.threadCreated:
		case DiscordEventKind.threadUpdated:
		case DiscordEventKind.threadDeleted:
			ids["threadId"] = event.threadId;
			break;
		case DiscordEventKind.guildUpdated:
			break;
		case DiscordEventKind.roleCreated:
		case DiscordEventKind.roleUpdated:
		case DiscordEventKind.roleDeleted:
			ids["roleId"] = event.roleId;
			break;
		case DiscordEventKind.memberAdded:
		case DiscordEventKind.memberUpdated:
		case DiscordEventKind.memberRemoved:
			ids["userId"] = event.userId;
			break;
		case DiscordEventKind.threadMemberAdded:
		case DiscordEventKind.threadMemberRemoved:
			ids["threadId"] = event.threadId;
			ids["userId"] = event.userId;
			break;
		case DiscordEventKind.resyncNeeded:
			ids["epoch"] = event.epoch;
			ids["reconnectAttempts"] = event.reconnectAttempts;
			break;
	}

	return ids;
}
