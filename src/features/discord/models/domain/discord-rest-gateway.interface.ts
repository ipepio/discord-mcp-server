import type {
	DiscordChannelRecord,
	DiscordGuildSnapshot,
	DiscordMemberRoster,
	DiscordMessageHistoryPage,
	DiscordMessageRecord,
	DiscordRoleRecord,
	DiscordThreadMemberPage
} from "./discord-rest-results.js";

/**
 * The Discord REST read contracts (spec R7). These are the only Discord operations this feature exposes:
 * every one of them is a read, and the guild-scoped reads take no Guild id at all because the adapter is
 * constructed with the configured Guild — a caller cannot ask it for another Guild's data (R2 applied to
 * REST). Resource ids a caller does supply are validated before they reach a request path.
 *
 * Ownership note, per the spec's Contracts section: these interfaces are deliberately narrow and
 * application-typed. When [guild-state](../../../../docs/features/guild-state.md) lands, its own
 * consumer-owned `GuildStateGateway` contract names the same reads and this adapter satisfies it
 * structurally; when [ingestion](../../../../docs/features/ingestion.md) lands, its message-read contract is
 * satisfied by `readMessageHistoryPage` (backfill) and `readMessage` (one message whole, to reconcile a
 * partial update). The import direction stays type-only in both cases
 * (those features import these types, this feature imports neither), and the application composition
 * module wires the instance, exactly as the spec's composition note requires.
 */

/** Bounded roster read. Both bounds are caps the caller asks for; the adapter's policy caps apply too. */
export interface MemberRosterRead {
	/** Read at most this many pages; the policy bound is the ceiling either way. */
	readonly maxPages?: number;
	/** Stop after this many members and report the roster as truncated. */
	readonly maxMembers?: number;
}

/** One bounded channel-history page. `before` and `after` are Discord cursors, never both. */
export interface MessageHistoryRead {
	readonly channelId: string;
	/** Ask for messages older than this id — the direction a backfill walks. */
	readonly before?: string;
	/** Ask for messages newer than this id. */
	readonly after?: string;
	/** Page size request, clamped to the policy bound and to Discord's ceiling. */
	readonly limit?: number;
}

/**
 * One message read whole by id (docs/features/ingestion.md R5).
 *
 * The channel id is part of the request because that is what Discord's route is: a message id alone is not
 * addressable, so the read is scoped to the container the event named — a thread's own id when the message
 * was posted in a thread. The response must confirm both ids or it is refused as a validation failure.
 */
export interface MessageRead {
	readonly channelId: string;
	readonly messageId: string;
}

/** One bounded thread-member page, where the API allows the read. */
export interface ThreadMemberRead {
	readonly threadId: string;
	readonly after?: string;
	readonly limit?: number;
}

/** The guild-state-shaped reads: snapshot, roles, channels with overwrites, roster, thread members. */
export interface DiscordGuildStateRestOperations {
	readonly readGuildSnapshot: () => Promise<DiscordGuildSnapshot>;
	readonly readRoles: () => Promise<readonly DiscordRoleRecord[]>;
	readonly readChannels: () => Promise<readonly DiscordChannelRecord[]>;
	readonly readMemberRoster: (read?: MemberRosterRead) => Promise<DiscordMemberRoster>;
	readonly readThreadMembers: (read: ThreadMemberRead) => Promise<DiscordThreadMemberPage>;
}

/**
 * Ingestion's message reads: a bounded history page for backfill, and one message whole by id to reconcile
 * a partial Gateway update (docs/features/ingestion.md R3, R5). The single read carries no page, no cursor
 * and no scan — one request for one resource is the whole bound.
 */
export interface DiscordMessageHistoryRestOperations {
	readonly readMessageHistoryPage: (read: MessageHistoryRead) => Promise<DiscordMessageHistoryPage>;
	readonly readMessage: (read: MessageRead) => Promise<DiscordMessageRecord>;
}

/** Everything the Discord REST adapter promises a consumer. Reads only (R8). */
export interface DiscordRestOperations extends DiscordGuildStateRestOperations, DiscordMessageHistoryRestOperations {}
