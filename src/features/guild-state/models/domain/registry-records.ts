import type { ChannelPermissionOverwrite, NormalizedChannelType } from "../../../discord/index.js";
import type { DiscordIdentifier } from "./discord-identifier.js";
import type { PermissionBitfield } from "./permission-bitfield.js";

/**
 * The application records the permission registry stores and reads back
 * (docs/features/guild-state.md Contracts: "the registry record types"). Every id is a
 * {@link DiscordIdentifier} string and every bitfield a {@link PermissionBitfield} string, so no record
 * here can carry a coerced number (R3, R9). A nullable column is `T | null`, never an optional property:
 * "Discord did not send it" and "the caller forgot to say" must not look the same to a repository
 * (docs/features/discord.md: absent is never empty).
 *
 * These types are the repository contracts' vocabulary. A PostgreSQL row shape never appears here — row
 * types belong to the adapter file that reads them (docs/architecture/persistence.md).
 */

/** The one Guild row (R1); `guildName` is what `GetGuildIdentityQuery` answers with (R13). */
export interface RegistryGuild {
	readonly guildId: DiscordIdentifier;
	readonly guildName: string;
}

/** A role, @everyone included; `permissionsBitfield` is Discord's text verbatim (R3). */
export interface RegistryRole {
	readonly guildId: DiscordIdentifier;
	readonly roleId: DiscordIdentifier;
	readonly roleName: string;
	readonly permissionsBitfield: PermissionBitfield;
	readonly position: number;
}

/** A member's identity plus the whole role set as Discord sent it (R4). */
export interface RegistryMembership {
	readonly guildId: DiscordIdentifier;
	readonly userId: DiscordIdentifier;
	readonly roleIds: readonly DiscordIdentifier[];
}

/**
 * One row of the single channel/thread registry (R6). `isThread` is derived from `channelType` by
 * {@link ./registry-rules.ts} rather than sent by a caller: a caller cannot claim a thread is a channel
 * and dodge the parent rule.
 */
export interface RegistryChannel {
	readonly guildId: DiscordIdentifier;
	readonly channelId: DiscordIdentifier;
	readonly channelType: NormalizedChannelType;
	readonly name: string | null;
	readonly position: number | null;
	/** Mandatory for a thread, absent for a top-level channel; a category parent when Discord named one (R6, R7). */
	readonly parentChannelId: DiscordIdentifier | null;
}

/** The overwrite set of one channel or thread — the whole set, because replacement is the only rule (R6). */
export interface RegistryChannelOverwriteSet {
	readonly guildId: DiscordIdentifier;
	readonly channelId: DiscordIdentifier;
	readonly overwrites: readonly ChannelPermissionOverwrite[];
}

/**
 * One overwrite row of a channel's set, named from the record that carries it (R7). Domain rules take this
 * name rather than importing the `discord` feature's own type: the row shape is fixed here, at the record,
 * so the derivation reads guild-state's vocabulary and the Discord names stay in the boundary files.
 */
export type RegistryChannelOverwrite = RegistryChannelOverwriteSet["overwrites"][number];

/** The private-thread membership set of one thread, as user ids (R8). */
export interface RegistryThreadMembershipSet {
	readonly guildId: DiscordIdentifier;
	readonly threadId: DiscordIdentifier;
	readonly userIds: readonly DiscordIdentifier[];
}

/** One private-thread membership edge, the shape `THREAD_MEMBERSHIP_*` applies (R8). */
export interface RegistryThreadMembership {
	readonly guildId: DiscordIdentifier;
	readonly threadId: DiscordIdentifier;
	readonly userId: DiscordIdentifier;
}

/** Read projection: a role's stored bitfield, the row permission evaluation folds (R12). */
export interface RegistryRolePermission {
	readonly roleId: DiscordIdentifier;
	readonly permissionsBitfield: PermissionBitfield;
}

/** R6: an overwrite replacement reports both sides, so a stale grant that disappeared is provable. */
/** How many rows a bounded batch wrote, in how many transactions. R14's "what was applied" for a bulk write. */
export interface RegistryBatchWriteResult {
	readonly rowsWritten: number;
	readonly batches: number;
}

/** R3: the removal of a role reports the dependents its cascade took with it. */
export interface RegistryRoleRemovalResult {
	readonly roleRemoved: boolean;
	readonly membershipLinksRemoved: number;
	readonly overwritesRemoved: number;
}

/** R4: removing a member reports the role links, member-targeted overwrites and thread edges it cascades. */
export interface RegistryMembershipRemovalResult {
	readonly membershipRemoved: boolean;
	readonly roleLinksRemoved: number;
	readonly overwritesRemoved: number;
	readonly threadMembershipsRemoved: number;
}

/** R6: removing a channel or thread reports the child threads, overwrite rows and thread edges it cascades. */
export interface RegistryChannelRemovalResult {
	readonly channelRemoved: boolean;
	readonly childThreadsRemoved: number;
	readonly overwritesRemoved: number;
	readonly threadMembershipsRemoved: number;
}

/** R4: a role-set replacement reports both sides of the replace, which is what makes it not a merge. */
export interface RegistryRoleSetReplacementResult {
	readonly roleLinksRemoved: number;
	readonly roleLinksWritten: number;
}

/** R6: an overwrite replacement reports both sides, so a stale grant that disappeared is provable. */
export interface RegistryOverwriteReplacementResult {
	readonly overwritesRemoved: number;
	readonly overwritesWritten: number;
}

/** R8: a thread-membership replacement reports both sides for the same reason. */
export interface RegistryThreadMembershipReplacementResult {
	readonly membershipsRemoved: number;
	readonly membershipsWritten: number;
}

/**
 * One consistent read of everything permission evaluation needs for one User (R12; docs/adr/0005: "the
 * evaluation reads its inputs from one consistent snapshot"). This is a read projection, not a table: the
 * rows it carries come from six registry statements issued inside one snapshot, and nothing in it can be
 * written — there is no vocabulary for "the evaluation changed a grant" here (R13).
 *
 * Two shapes of the same projection, and the difference is only how wide the read was:
 *
 * - one channel's evaluation: `channels` holds the target and, for a thread, its parent;
 * - one User's whole registry scan: `channels` and `overwriteSets` hold every stored row, bounded by
 *   Discord's own per-Guild ceilings, so a list query never loops per channel (spec Contracts).
 *
 * The nullable rows are the fail-closed facts, stated as `null` rather than as an empty set: a missing
 * membership is "not a member" (R4), a missing Guild is "never bootstrapped" (R2), and a `@everyone` role
 * with no row is an incomplete base the derivation must refuse rather than fold as zero (R3).
 */
export interface RegistryPermissionSnapshot {
	readonly guild: RegistryGuild | null;
	readonly membership: RegistryMembership | null;
	/** `@everyone`'s stored bitfield, keyed by the Guild id (R3). Null means the role row is absent. */
	readonly everyonePermissions: PermissionBitfield | null;
	/** Bitfields for the member's own roles — ids the registry does not hold are simply not present (R5). */
	readonly rolePermissions: readonly RegistryRolePermission[];
	readonly channels: readonly RegistryChannel[];
	/** The overwrite set of each channel in `channels`, grouped per channel, in Discord's target vocabulary. */
	readonly overwriteSets: readonly RegistryChannelOverwriteSet[];
	/** The private-thread ids the registry holds a membership edge for, for this User (R8). */
	readonly privateThreadIds: readonly DiscordIdentifier[];
}
