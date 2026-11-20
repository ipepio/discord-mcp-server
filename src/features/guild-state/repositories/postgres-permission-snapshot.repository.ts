import type { ChannelPermissionOverwrite } from "../../discord/index.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requirePermissionBitfield } from "../models/domain/permission-bitfield.js";
import type {
	RegistryChannel,
	RegistryChannelOverwriteSet,
	RegistryGuild,
	RegistryMembership,
	RegistryPermissionSnapshot,
	RegistryRolePermission
} from "../models/domain/registry-records.js";
import type { PermissionSnapshotRepository, PermissionSnapshotRequest } from "./permission-snapshot.repository.js";
import type { SqlExecutor } from "./sql-executor.js";

/**
 * The evaluation snapshot read (docs/features/guild-state.md R12; docs/adr/0005;
 * `repositories/permission-snapshot.repository.ts` for why this read exists beside the T1 projections).
 *
 * The contract this adapter exists to keep is a single sentence: *every* row the derivation uses comes from
 * one instant of the registry. It is kept by opening one read transaction, pinning it to
 * `REPEATABLE READ`, and issuing every statement on that one session. Without the isolation statement a
 * plain `BEGIN` is `READ COMMITTED`, where each *statement* takes a fresh snapshot — a base role updated
 * between statement two and statement five would then be combined with overwrite rows from before it, and
 * the mixed answer would be the one the hub logs as a decision. PostgreSQL takes the snapshot at the first
 * consistent read, so all six statements below see the same one.
 *
 * The other three rules it keeps:
 *
 * - **Guild scoping (R1).** Every statement binds `guild_id`, so no row of another Guild can enter a
 *   snapshot even if the registry were wrong about holding one Guild.
 * - **Text bitfields (R3).** Each `*_bitfield` column goes through `requirePermissionBitfield` on the way
 *   out, so a driver that ever handed back a number is refused here rather than silently rounded by the
 *   derivation.
 * - **No writes, and no runtime SQL.** Statements are frozen constants; only values are bound as
 *   parameters, and the narrow/wide split selects between two complete statements instead of building one.
 */

/**
 * The isolation pin, issued as the transaction's first statement so it applies to every read below.
 * `SET TRANSACTION` after `BEGIN` is the only way to ask for this without changing the shared transaction
 * runner, which is written for commit-ordered writes and must stay that way.
 */
const SNAPSHOT_ISOLATION_STATEMENT = "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ";

const FIND_GUILD_STATEMENT = `
	SELECT guild_id, guild_name
	FROM guild
	WHERE guild_id = $1
`;

const FIND_MEMBERSHIP_STATEMENT = `
	SELECT m.guild_id, m.user_id,
		COALESCE(ARRAY_AGG(r.role_id ORDER BY r.role_id) FILTER (WHERE r.role_id IS NOT NULL), '{}') AS role_ids
	FROM guild_membership AS m
	LEFT JOIN guild_membership_role AS r ON r.guild_id = m.guild_id AND r.user_id = m.user_id
	WHERE m.guild_id = $1 AND m.user_id = $2
	GROUP BY m.guild_id, m.user_id
`;

/**
 * The role rows the base stage folds, in one statement: `@everyone`, whose role id equals the Guild id (R3),
 * plus every role the member's assignment set names. A role id assigned but not present in `guild_role`
 * returns no row, which is R5's "an unknown id has no permissions to add" read back rather than invented.
 */
const FIND_FOLDED_ROLES_STATEMENT = `
	SELECT role.role_id, role.permissions_bitfield
	FROM guild_role AS role
	WHERE role.guild_id = $1
		AND (
			role.role_id = $1
			OR role.role_id IN (
				SELECT assignment.role_id
				FROM guild_membership_role AS assignment
				WHERE assignment.guild_id = $1 AND assignment.user_id = $2
			)
		)
	ORDER BY role.role_position, role.role_id
`;

/** Evaluation and accessible-list metadata share one bounded snapshot; names are never logged (R14). */
const SNAPSHOT_CHANNEL_COLUMNS = `channel_id, guild_id, channel_type, channel_name, channel_position, parent_channel_id`;

const FIND_SNAPSHOT_CHANNELS_STATEMENT = `
	SELECT ${SNAPSHOT_CHANNEL_COLUMNS}
	FROM channel
	WHERE guild_id = $1
	ORDER BY channel_position, channel_id
`;

/**
 * The narrow form: the evaluated channel and, when it is a thread, the parent channel whose overwrite set
 * still applies (Contracts' thread rule). The parent is fetched by the same statement so the two levels
 * cannot come from different instants, which is the whole reason this read exists.
 */
const FIND_SNAPSHOT_CHANNEL_WITH_PARENT_STATEMENT = `
	SELECT ${SNAPSHOT_CHANNEL_COLUMNS}
	FROM channel
	WHERE guild_id = $1
		AND (
			channel_id = $2
			OR channel_id = (
				SELECT parent_channel_id FROM channel WHERE guild_id = $1 AND channel_id = $2
			)
		)
	ORDER BY channel_position, channel_id
`;

const FIND_SNAPSHOT_OVERWRITES_STATEMENT = `
	SELECT channel_id, overwrite_target_id, overwrite_target_type, allow_bitfield, deny_bitfield
	FROM channel_permission_overwrite
	WHERE guild_id = $1
	ORDER BY channel_id, overwrite_target_id
`;

const FIND_SNAPSHOT_CHANNEL_OVERWRITES_STATEMENT = `
	SELECT channel_id, overwrite_target_id, overwrite_target_type, allow_bitfield, deny_bitfield
	FROM channel_permission_overwrite
	WHERE guild_id = $1
		AND (
			channel_id = $2
			OR channel_id = (
				SELECT parent_channel_id FROM channel WHERE guild_id = $1 AND channel_id = $2
			)
		)
	ORDER BY channel_id, overwrite_target_id
`;

/** R8's admission fact, one row per private-thread edge the member holds. Bounded by the Guild's thread count. */
const FIND_PRIVATE_THREAD_IDS_STATEMENT = `
	SELECT thread_id
	FROM thread_membership
	WHERE guild_id = $1 AND user_id = $2
	ORDER BY thread_id
`;

type GuildRow = { guild_id: string; guild_name: string };

type MembershipRow = { guild_id: string; user_id: string; role_ids: string[] };

type RoleRow = { role_id: string; permissions_bitfield: string };

type ChannelRow = {
	channel_id: string;
	guild_id: string;
	channel_type: string;
	channel_name: string | null;
	channel_position: number | null;
	parent_channel_id: string | null;
};

type OverwriteRow = {
	channel_id: string;
	overwrite_target_id: string;
	overwrite_target_type: string;
	allow_bitfield: string;
	deny_bitfield: string;
};

type ThreadRow = { thread_id: string };

/** The two column casts stay in these mappers, exactly as the channel adapter keeps its own (R6). */
function toRegistryChannel(row: ChannelRow): RegistryChannel {
	return {
		guildId: row.guild_id,
		channelId: row.channel_id,
		channelType: row.channel_type as RegistryChannel["channelType"],
		name: row.channel_name,
		position: row.channel_position,
		parentChannelId: row.parent_channel_id
	};
}

function toOverwrite(row: OverwriteRow): ChannelPermissionOverwrite {
	return {
		targetId: requireDiscordIdentifier("channel_permission_overwrite.overwrite_target_id", row.overwrite_target_id),
		targetType: row.overwrite_target_type as ChannelPermissionOverwrite["targetType"],
		allowBitfield: requirePermissionBitfield("channel_permission_overwrite.allow_bitfield", row.allow_bitfield),
		denyBitfield: requirePermissionBitfield("channel_permission_overwrite.deny_bitfield", row.deny_bitfield)
	};
}

export class PostgresPermissionSnapshotRepository implements PermissionSnapshotRepository {
	public constructor(private readonly deps: { readonly executor: SqlExecutor }) {}

	public readonly loadSnapshot = async (request: PermissionSnapshotRequest): Promise<RegistryPermissionSnapshot> => {
		const guildId = requireDiscordIdentifier("guild.guild_id", request.guildId);
		const userId = requireDiscordIdentifier("guild_membership.user_id", request.userId);
		const channelId =
			request.channelId === null ? null : requireDiscordIdentifier("channel.channel_id", request.channelId);

		return this.deps.executor.transaction(async (session) => {
			await session.query(SNAPSHOT_ISOLATION_STATEMENT);

			const guildRows = await session.query<GuildRow>(FIND_GUILD_STATEMENT, [guildId]);
			const membershipRows = await session.query<MembershipRow>(FIND_MEMBERSHIP_STATEMENT, [guildId, userId]);
			const roleRows = await session.query<RoleRow>(FIND_FOLDED_ROLES_STATEMENT, [guildId, userId]);
			const channelRows =
				channelId === null
					? await session.query<ChannelRow>(FIND_SNAPSHOT_CHANNELS_STATEMENT, [guildId])
					: await session.query<ChannelRow>(FIND_SNAPSHOT_CHANNEL_WITH_PARENT_STATEMENT, [
							guildId,
							channelId
						]);
			const overwriteRows =
				channelId === null
					? await session.query<OverwriteRow>(FIND_SNAPSHOT_OVERWRITES_STATEMENT, [guildId])
					: await session.query<OverwriteRow>(FIND_SNAPSHOT_CHANNEL_OVERWRITES_STATEMENT, [
							guildId,
							channelId
						]);
			const threadRows = await session.query<ThreadRow>(FIND_PRIVATE_THREAD_IDS_STATEMENT, [guildId, userId]);

			return toSnapshot(
				guildId,
				guildRows.rows,
				membershipRows.rows,
				roleRows.rows,
				channelRows.rows,
				overwriteRows.rows,
				threadRows.rows
			);
		});
	};
}

/**
 * Rows to projection. The overwrite rows are grouped in the order the channels were read, so the wide form's
 * `channels`/`overwriteSets` arrays stay deterministic across runs — the registry's own ordering rule
 * (docs/architecture/persistence.md), which the list queries inherit instead of re-sorting.
 */
function toSnapshot(
	guildId: DiscordIdentifier,
	guildRows: readonly GuildRow[],
	membershipRows: readonly MembershipRow[],
	roleRows: readonly RoleRow[],
	channelRows: readonly ChannelRow[],
	overwriteRows: readonly OverwriteRow[],
	threadRows: readonly ThreadRow[]
): RegistryPermissionSnapshot {
	const channels = channelRows.map(toRegistryChannel);

	const overwritesByChannel = new Map<DiscordIdentifier, ChannelPermissionOverwrite[]>();
	for (const row of overwriteRows) {
		const bucket = overwritesByChannel.get(row.channel_id);
		if (bucket === undefined) {
			overwritesByChannel.set(row.channel_id, [toOverwrite(row)]);
			continue;
		}
		bucket.push(toOverwrite(row));
	}
	// Every channel in the projection carries a set, including the ones with no rows: R7's replacement rule
	// makes "no rows" mean "no overwrites", which is a real state and not an unknown one.
	const overwriteSets: RegistryChannelOverwriteSet[] = channels.map((channel) => ({
		guildId,
		channelId: channel.channelId,
		overwrites: overwritesByChannel.get(channel.channelId) ?? []
	}));

	// @everyone is folded by its natural key — the Guild id (R3) — and reported apart from the member's own
	// roles, because stage 1 needs it whether or not the assignment set names it, and the set never does.
	const everyoneRow = roleRows.find((row) => row.role_id === guildId);
	const rolePermissions: RegistryRolePermission[] = roleRows
		.filter((row) => row.role_id !== guildId)
		.map((row) => ({
			roleId: row.role_id,
			permissionsBitfield: requirePermissionBitfield("guild_role.permissions_bitfield", row.permissions_bitfield)
		}));

	const membershipRow = membershipRows[0];
	const membership: RegistryMembership | null =
		membershipRow === undefined
			? null
			: { guildId, userId: membershipRow.user_id, roleIds: membershipRow.role_ids };

	const guildRow = guildRows[0];
	const guild: RegistryGuild | null = guildRow === undefined ? null : { guildId, guildName: guildRow.guild_name };

	return {
		guild,
		membership,
		everyonePermissions:
			everyoneRow === undefined
				? null
				: requirePermissionBitfield(
						"guild_role.permissions_bitfield(@everyone)",
						everyoneRow.permissions_bitfield
					),
		rolePermissions,
		channels,
		overwriteSets,
		privateThreadIds: threadRows.map((row) => row.thread_id)
	};
}
