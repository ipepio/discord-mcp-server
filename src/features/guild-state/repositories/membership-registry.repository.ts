import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import type {
	RegistryBatchWriteResult,
	RegistryMembership,
	RegistryMembershipRemovalResult,
	RegistryRoleSetReplacementResult
} from "../models/domain/registry-records.js";

/**
 * Membership identity and the role set of each member (docs/features/guild-state.md R4, R5; Contracts:
 * "batch upsert memberships", "replace the role set of one membership", "delete a membership and its
 * dependents … in one transaction", "a member's role set" read).
 *
 * R5's rule shapes every method here: Discord's member payload carries the *whole* role set, so a stored
 * set is replaced, never merged, and never inferred by scanning audit history.
 */
export interface MembershipRegistryRepository {
	/**
	 * Create or replace memberships — identity rows and role sets together — in bounded batches, one
	 * transaction per batch. Replaying the same page changes nothing observable (R9).
	 */
	readonly upsertMemberships: (memberships: readonly RegistryMembership[]) => Promise<RegistryBatchWriteResult>;

	/**
	 * Replace one member's whole role set in one transaction. The membership row must already exist: the
	 * foreign key says so, and the event path that adds a member calls `upsertMemberships` first.
	 * @everyone is not stored here, because Discord does not send it (R3).
	 */
	readonly replaceMembershipRoles: (membership: RegistryMembership) => Promise<RegistryRoleSetReplacementResult>;

	/**
	 * R4: remove the membership with its role assignments, the member-targeted overwrites that named it and
	 * its private-thread membership edges, in one transaction. The message trail is untouched: audit keeps
	 * its own copy of who said what.
	 */
	readonly deleteMembershipAndDependents: (
		guildId: DiscordIdentifier,
		userId: DiscordIdentifier
	) => Promise<RegistryMembershipRemovalResult>;

	/**
	 * A member's stored role set, or `null` when the registry holds no membership row — which permission
	 * evaluation must read as "not a member", not as "a member with no roles" (R4, R12).
	 */
	readonly findMembership: (
		guildId: DiscordIdentifier,
		userId: DiscordIdentifier
	) => Promise<RegistryMembership | null>;

	/**
	 * R10: the Guild's member ids, ids only. A roster is the one registry set large enough that a resync
	 * must not pull whole rows to work out who is gone.
	 */
	readonly findMembershipUserIds: (guildId: DiscordIdentifier) => Promise<readonly DiscordIdentifier[]>;
}
