import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requirePermissionBitfield } from "../models/domain/permission-bitfield.js";
import type {
	RegistryBatchWriteResult,
	RegistryRole,
	RegistryRolePermission,
	RegistryRoleRemovalResult
} from "../models/domain/registry-records.js";
import { splitWriteBatch } from "./registry-write-batch.js";
import type { RoleRegistryRepository } from "./role-registry.repository.js";
import type { SqlExecutor } from "./sql-executor.js";

/**
 * Roles and bitfields (docs/features/guild-state.md R3, R10).
 *
 * Three things this file is careful about:
 *
 * - The bitfield is bound as `text[]` and validated as text (`requirePermissionBitfield`), so a value that
 *   reached the repository as a JS number is refused before it can silently round a permission bit away (R3).
 * - A batch is one statement with one bound array per column. The column count is fixed by the table, so no
 *   statement in this feature assembles SQL text at runtime — only the number of *elements* varies, and
 *   `splitWriteBatch` bounds that.
 * - `deleteRoleAndDependents` is one transaction over three statements, ordered dependents-then-role so no
 *   foreign key ever points at a row that has already gone. Each removal is `RETURNING`, so the counts R14
 *   asks a log line to carry are the database's answer, not the caller's estimate. The overwrite sweep
 *   filters `overwrite_target_type = 'role'`: a role and a member can share an id space, and "the overwrites
 *   naming it" must mean the role and only the role (R3).
 */

type RoleRow = {
	role_id: string;
	guild_id: string;
	role_name: string;
	permissions_bitfield: string;
	role_position: number;
};

const UPSERT_ROLES_STATEMENT = `
	INSERT INTO guild_role (guild_id, role_id, role_name, permissions_bitfield, role_position)
	SELECT guild_id, role_id, role_name, permissions_bitfield, role_position
	FROM UNNEST($1::bigint[], $2::bigint[], $3::text[], $4::text[], $5::integer[])
		AS s(guild_id, role_id, role_name, permissions_bitfield, role_position)
	ON CONFLICT (role_id) DO UPDATE SET
		guild_id = EXCLUDED.guild_id,
		role_name = EXCLUDED.role_name,
		permissions_bitfield = EXCLUDED.permissions_bitfield,
		role_position = EXCLUDED.role_position
`;

const DELETE_ROLE_ASSIGNMENTS_STATEMENT = `
	DELETE FROM guild_membership_role
	WHERE guild_id = $1 AND role_id = $2
	RETURNING user_id
`;

const DELETE_ROLE_OVERWRITES_STATEMENT = `
	DELETE FROM channel_permission_overwrite
	WHERE guild_id = $1 AND overwrite_target_type = 'role' AND overwrite_target_id = $2
	RETURNING channel_id, overwrite_target_id
`;

const DELETE_ROLE_STATEMENT = `
	DELETE FROM guild_role
	WHERE guild_id = $1 AND role_id = $2
	RETURNING role_id
`;

const FIND_ROLES_STATEMENT = `
	SELECT role_id, guild_id, role_name, permissions_bitfield, role_position
	FROM guild_role
	WHERE guild_id = $1
	ORDER BY role_position, role_id
`;

const FIND_ROLE_PERMISSIONS_STATEMENT = `
	SELECT role_id, permissions_bitfield
	FROM guild_role
	WHERE guild_id = $1 AND role_id = ANY($2::bigint[])
	ORDER BY role_position, role_id
`;

function toRegistryRole(row: RoleRow): RegistryRole {
	return {
		guildId: row.guild_id,
		roleId: row.role_id,
		roleName: row.role_name,
		permissionsBitfield: row.permissions_bitfield,
		position: row.role_position
	};
}

export class PostgresRoleRegistryRepository implements RoleRegistryRepository {
	public constructor(
		private readonly deps: {
			readonly executor: SqlExecutor;
			readonly writeBatchSize: number;
		}
	) {}

	public readonly upsertRoles = async (roles: readonly RegistryRole[]): Promise<RegistryBatchWriteResult> => {
		// Validated in full before anything is written: a half-applied role list is the "incomplete but claimed
		// complete" state R2 forbids, and a non-Discord bitfield must never reach a column.
		const guildIds = roles.map((role) => requireDiscordIdentifier("guild_role.guild_id", role.guildId));
		const roleIds = roles.map((role) => requireDiscordIdentifier("guild_role.role_id", role.roleId));
		const roleNames = roles.map((role) => role.roleName);
		const bitfields = roles.map((role) =>
			requirePermissionBitfield("guild_role.permissions_bitfield", role.permissionsBitfield)
		);
		const positions = roles.map((role) => role.position);

		let written = 0;
		let batchCount = 0;
		let cursor = 0;
		for (const batch of splitWriteBatch(roles, this.deps.writeBatchSize)) {
			const start = cursor;
			cursor += batch.length;
			batchCount += 1;
			// One transaction per bounded batch, so a failure costs a batch and not the whole list (R9).
			await this.deps.executor.transaction(async (session) => {
				await session.query(UPSERT_ROLES_STATEMENT, [
					guildIds.slice(start, cursor),
					roleIds.slice(start, cursor),
					roleNames.slice(start, cursor),
					bitfields.slice(start, cursor),
					positions.slice(start, cursor)
				]);
			});
			written += batch.length;
		}

		return { rowsWritten: written, batches: batchCount };
	};

	public readonly deleteRoleAndDependents = async (
		guildId: DiscordIdentifier,
		roleId: DiscordIdentifier
	): Promise<RegistryRoleRemovalResult> => {
		const scopedGuildId = requireDiscordIdentifier("guild_role.guild_id", guildId);
		const scopedRoleId = requireDiscordIdentifier("guild_role.role_id", roleId);

		return this.deps.executor.transaction(async (session) => {
			const assignments = await session.query<{ user_id: string }>(DELETE_ROLE_ASSIGNMENTS_STATEMENT, [
				scopedGuildId,
				scopedRoleId
			]);
			const overwrites = await session.query<{ channel_id: string; overwrite_target_id: string }>(
				DELETE_ROLE_OVERWRITES_STATEMENT,
				[scopedGuildId, scopedRoleId]
			);
			const role = await session.query<{ role_id: string }>(DELETE_ROLE_STATEMENT, [scopedGuildId, scopedRoleId]);

			return {
				roleRemoved: role.rows.length > 0,
				membershipLinksRemoved: assignments.rows.length,
				overwritesRemoved: overwrites.rows.length
			};
		});
	};

	public readonly findRoles = async (guildId: DiscordIdentifier): Promise<readonly RegistryRole[]> => {
		const { rows } = await this.deps.executor.query<RoleRow>(FIND_ROLES_STATEMENT, [
			requireDiscordIdentifier("guild_role.guild_id", guildId)
		]);
		return rows.map(toRegistryRole);
	};

	public readonly findRolePermissions = async (
		guildId: DiscordIdentifier,
		roleIds: readonly DiscordIdentifier[]
	): Promise<readonly RegistryRolePermission[]> => {
		if (roleIds.length === 0) {
			return [];
		}
		const { rows } = await this.deps.executor.query<{ role_id: string; permissions_bitfield: string }>(
			FIND_ROLE_PERMISSIONS_STATEMENT,
			[requireDiscordIdentifier("guild_role.guild_id", guildId), [...roleIds]]
		);
		return rows.map((row) => ({
			roleId: row.role_id,
			permissionsBitfield: row.permissions_bitfield
		}));
	};
}
