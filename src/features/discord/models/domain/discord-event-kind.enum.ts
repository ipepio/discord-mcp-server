/**
 * The explicitly enumerated normalized event kinds this feature publishes (spec R3). Raw Discord
 * event names never appear here: the internal stream speaks these kinds only. The set is a
 * cross-feature contract (spec "Compatibility"): adding a kind is additive, while renaming, removing
 * or reshaping one needs an explicit decision.
 */
export const DiscordEventKind = {
	messageCreated: "message-created",
	messageUpdated: "message-updated",
	messageDeleted: "message-deleted",
	messageBulkDeleted: "message-bulk-deleted",
	channelCreated: "channel-created",
	channelUpdated: "channel-updated",
	channelDeleted: "channel-deleted",
	threadCreated: "thread-created",
	threadUpdated: "thread-updated",
	threadDeleted: "thread-deleted",
	guildUpdated: "guild-updated",
	roleCreated: "role-created",
	roleUpdated: "role-updated",
	roleDeleted: "role-deleted",
	memberAdded: "member-added",
	memberUpdated: "member-updated",
	memberRemoved: "member-removed",
	threadMemberAdded: "thread-member-added",
	threadMemberRemoved: "thread-member-removed",
	resyncNeeded: "resync-needed"
} as const;

export type DiscordEventKind = (typeof DiscordEventKind)[keyof typeof DiscordEventKind];

/** Every enumerated kind; used for counting and for the subscription contract. */
export const DISCORD_EVENT_KINDS: readonly DiscordEventKind[] = Object.values(DiscordEventKind);

const KIND_SET: ReadonlySet<string> = new Set<string>(DISCORD_EVENT_KINDS);

/** Narrows a kind arriving from an untrusted boundary; never invents a nearest known kind (R3). */
export function isDiscordEventKind(candidate: string): candidate is DiscordEventKind {
	return KIND_SET.has(candidate);
}
