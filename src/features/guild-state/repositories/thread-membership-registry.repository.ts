import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import type {
	RegistryThreadMembership,
	RegistryThreadMembershipReplacementResult,
	RegistryThreadMembershipSet
} from "../models/domain/registry-records.js";

/**
 * Private-thread membership (docs/features/guild-state.md R8; Contracts: "upsert and delete thread
 * memberships"). This table is the only way R8's private-thread visibility can be answered, because a
 * private thread has no overwrites to read and Discord sends its members as ids only.
 *
 * Which facts keep it current is the open decision O1: Gateway events for the ordinary path, a REST
 * reconciliation for convergence. Both land here, so neither one is designed in from the start.
 */
export interface ThreadMembershipRegistryRepository {
	/**
	 * Replace the whole member set of one thread in one transaction — the shape a REST reconciliation
	 * converges to (R10). Edges for a thread that is not in the registry are refused by the foreign key.
	 */
	readonly replaceThreadMemberships: (
		set: RegistryThreadMembershipSet
	) => Promise<RegistryThreadMembershipReplacementResult>;

	/** `THREAD_MEMBERSHIP_ADD` (R8): one edge, present already is a no-op. Returns whether it was written. */
	readonly addThreadMembership: (membership: RegistryThreadMembership) => Promise<boolean>;

	/** `THREAD_MEMBERSHIP_REMOVE` (R8): one edge. Returns whether anything was removed. */
	readonly removeThreadMembership: (membership: RegistryThreadMembership) => Promise<boolean>;

	/** R8 boundary: the visible set of a private thread is exactly these ids. */
	readonly findThreadMemberUserIds: (
		guildId: DiscordIdentifier,
		threadId: DiscordIdentifier
	) => Promise<readonly DiscordIdentifier[]>;

	/**
	 * R8, the other direction: the private threads one member is in. `ListUserAccessibleChannelsQuery`
	 * reads it as part of one bounded set rather than looping per thread (spec Contracts).
	 */
	readonly findThreadIdsForMember: (
		guildId: DiscordIdentifier,
		userId: DiscordIdentifier
	) => Promise<readonly DiscordIdentifier[]>;
}
