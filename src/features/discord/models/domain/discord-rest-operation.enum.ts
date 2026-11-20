/**
 * The Discord REST reads this Installation performs (spec R7). Each name is what a failure or a log line
 * reports, so a named technical failure always points at one identifiable read. The set mirrors R7's list:
 * Guild snapshot, role list, channel list with permission overwrites, paginated member roster, channel
 * message history pages, one message by id, and thread-member reads.
 */
export const DiscordRestOperation = {
	botIdentity: "discord-rest.bot-identity",
	guildSnapshot: "discord-rest.guild-snapshot",
	roles: "discord-rest.roles",
	channels: "discord-rest.channels",
	memberRoster: "discord-rest.member-roster",
	messageHistory: "discord-rest.message-history",
	/**
	 * One message read whole by id (docs/features/ingestion.md R5: a partial update is reconciled by fetching
	 * the message before overwriting). A named operation per read is what makes a reconciliation failure
	 * attributable to the one request that caused it.
	 */
	message: "discord-rest.message",
	threadMembers: "discord-rest.thread-members"
} as const;

export type DiscordRestOperation = (typeof DiscordRestOperation)[keyof typeof DiscordRestOperation];

/** Every enumerated operation; the read-only structural proof asserts the reads cover exactly these. */
export const DISCORD_REST_OPERATIONS: readonly DiscordRestOperation[] = Object.values(DiscordRestOperation);
