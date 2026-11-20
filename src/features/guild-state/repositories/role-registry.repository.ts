import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import type {
	RegistryBatchWriteResult,
	RegistryRole,
	RegistryRolePermission,
	RegistryRoleRemovalResult
} from "../models/domain/registry-records.js";

/**
 * Roles and their bitfields (docs/features/guild-state.md R3, R10; Contracts: "batch upsert roles",
 * "delete a role and its dependents … in one transaction", "role bitfields" read).
 *
 * The bitfield travels as Discord's own text and is never widened to a number by anything here (R3).
 * Removal is the interesting operation: a deleted role must not survive as an assignment or as an
 * overwrite, so the cascade is part of the same call and the same transaction.
 */
export interface RoleRegistryRepository {
	/** Create or replace roles in bounded batches, one transaction per batch. @everyone is a role like any other. */
	readonly upsertRoles: (roles: readonly RegistryRole[]) => Promise<RegistryBatchWriteResult>;

	/**
	 * R3: remove one role with the `guild_membership_role` rows that assigned it and the
	 * `channel_permission_overwrite` rows that named it, in one transaction. A member who held only that
	 * role loses no other grant, because nothing here touches the rest of their set.
	 */
	readonly deleteRoleAndDependents: (
		guildId: DiscordIdentifier,
		roleId: DiscordIdentifier
	) => Promise<RegistryRoleRemovalResult>;

	/** Every stored role, @everyone included. Bounded by Discord's own per-Guild role ceiling. */
	readonly findRoles: (guildId: DiscordIdentifier) => Promise<readonly RegistryRole[]>;

	/**
	 * The bitfield projection permission evaluation folds (R12). Ids not stored are absent from the result —
	 * an unknown role is not a zero-permission role, and the caller decides what its absence means.
	 */
	readonly findRolePermissions: (
		guildId: DiscordIdentifier,
		roleIds: readonly DiscordIdentifier[]
	) => Promise<readonly RegistryRolePermission[]>;
}
