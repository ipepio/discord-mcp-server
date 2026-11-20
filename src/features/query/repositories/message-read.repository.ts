import type { MessageKey, StoredMessage } from "../models/domain/message.js";

/** These IDs must come from the live registry evaluation: deleted containers (and their threads) are absent. */
export interface MessageReadScope {
	readonly guildId: string;
	readonly accessibleChannelIds: readonly string[];
}
export interface MessagePageInput extends MessageReadScope {
	readonly channelId: string;
	readonly pageSize: number;
	/**
	 * R13's backward key: the key of the last row the previous page returned, so the read yields strictly
	 * older rows. Naming it `before` is the seam's statement that the traversal walks toward the past.
	 */
	readonly before?: MessageKey;
	readonly from?: string;
	readonly to?: string;
}
export interface MessageWindowInput extends MessageReadScope {
	readonly messageId: string;
	readonly windowSize: number;
}
export interface CandidateReadInput extends MessageReadScope {
	readonly messageIds: readonly string[];
	readonly pageSize: number;
}
export interface MessageReadRepository {
	readonly readPage: (input: MessagePageInput) => Promise<readonly StoredMessage[]>;
	readonly readWindow: (input: MessageWindowInput) => Promise<readonly StoredMessage[]>;
	readonly readCandidates: (input: CandidateReadInput) => Promise<readonly StoredMessage[]>;
}

/** R14's effective window: `[since, until]`, inclusive at both ends, both resolved by the use case. */
export interface ActivityWindowScope extends MessageReadScope {
	readonly since: string;
	readonly until: string;
}
/** A continuation key is the position of the last row the previous digest page returned (R4, R14). */
export interface ActivityReadInput extends ActivityWindowScope {
	readonly before?: MessageKey;
}
export interface ActivityPageInput extends ActivityReadInput {
	readonly pageSize: number;
}
export interface ActivityChannelCount {
	readonly channelId: string;
	readonly messageCount: number;
}
/**
 * R14's read contract: one grouped window count over the whole scope set, one partitioned page read, and one
 * anchor lookup — a bounded number of statements that does not follow the number of digested containers, and
 * never a per-container query loop. `accessibleChannelIds` is the digest's scope set (the R12 intersection, or
 * the one container `channelId` narrowed it to), so a call that is not permission-scoped cannot be built here
 * either. Tombstone and deleted-container exclusion is unconditional, as on every other read path (R6).
 */
export interface ActivityReadRepository {
	readonly countWindowMessages: (input: ActivityReadInput) => Promise<readonly ActivityChannelCount[]>;
	readonly readActivityPage: (input: ActivityPageInput) => Promise<readonly StoredMessage[]>;
	/** The Requester's newest authored instant inside the scope, or `null` when they never posted in it (O7). */
	readonly readMyLastMessageAt: (input: MessageReadScope & { readonly authorId: string }) => Promise<string | null>;
}
