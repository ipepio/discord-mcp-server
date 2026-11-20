import type { ChannelPermissionOverwrite } from "../../discord/index.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requirePermissionBitfield } from "../models/domain/permission-bitfield.js";
import type {
	RegistryBatchWriteResult,
	RegistryChannel,
	RegistryChannelOverwriteSet,
	RegistryChannelRemovalResult,
	RegistryOverwriteReplacementResult
} from "../models/domain/registry-records.js";
import { registryChannelIsThread, requireThreadParent } from "../models/domain/registry-rules.js";
import { splitWriteBatch } from "./registry-write-batch.js";
import type { ChannelRegistryRepository } from "./channel-registry.repository.js";
import type { SqlExecutor } from "./sql-executor.js";

/**
 * The single channel/thread registry and its overwrite sets (docs/features/guild-state.md R6, R7).
 *
 * A thread's parent must already be in the registry, so a batch is written in two passes — non-thread rows
 * first, thread rows second — each pass in its own bounded transactions. That is the ordering rule R6
 * implies, made explicit rather than left to whatever order Discord's list came back in. A thread whose
 * parent exists nowhere gets a rejected write from `requireThreadParent` and, if a caller somehow bypasses
 * it, from the `channel_thread_has_parent` check and the parent foreign key.
 *
 * Overwrite replacement is one transaction that deletes the channel's whole set and inserts the new one, so
 * a grant that disappeared from the payload cannot survive as a stale row (R6, and the case the task calls
 * "overwrite replacement removes stale grants").
 */

const UPSERT_CHANNELS_STATEMENT = `
	INSERT INTO channel (channel_id, guild_id, channel_type, channel_name, channel_position, is_thread, parent_channel_id)
	SELECT s.channel_id, s.guild_id, s.channel_type, s.channel_name, s.channel_position, s.is_thread, s.parent_channel_id
	FROM UNNEST($1::bigint[], $2::bigint[], $3::text[], $4::text[], $5::integer[], $6::boolean[], $7::bigint[])
		AS s(channel_id, guild_id, channel_type, channel_name, channel_position, is_thread, parent_channel_id)
	ON CONFLICT (channel_id) DO UPDATE SET
		guild_id = EXCLUDED.guild_id,
		channel_type = EXCLUDED.channel_type,
		channel_name = EXCLUDED.channel_name,
		channel_position = EXCLUDED.channel_position,
		is_thread = EXCLUDED.is_thread,
		parent_channel_id = EXCLUDED.parent_channel_id
`;

const FIND_CHILD_THREADS_STATEMENT = `
	SELECT channel_id
	FROM channel
	WHERE guild_id = $1 AND parent_channel_id = $2
`;

const DELETE_CHANNEL_OVERWRITES_STATEMENT = `
	DELETE FROM channel_permission_overwrite
	WHERE guild_id = $1 AND channel_id = ANY($2::bigint[])
	RETURNING overwrite_target_id
`;

const DELETE_CHANNEL_THREAD_MEMBERSHIPS_STATEMENT = `
	DELETE FROM thread_membership
	WHERE guild_id = $1 AND thread_id = ANY($2::bigint[])
	RETURNING user_id
`;

const DELETE_CHILD_THREADS_STATEMENT = `
	DELETE FROM channel
	WHERE guild_id = $1 AND channel_id = ANY($2::bigint[])
	RETURNING channel_id
`;

const DELETE_CHANNEL_STATEMENT = `
	DELETE FROM channel
	WHERE guild_id = $1 AND channel_id = $2
	RETURNING channel_id
`;

const DELETE_CHANNEL_OVERWRITE_SET_STATEMENT = `
	DELETE FROM channel_permission_overwrite
	WHERE guild_id = $1 AND channel_id = $2
	RETURNING overwrite_target_id
`;

const INSERT_CHANNEL_OVERWRITES_STATEMENT = `
	INSERT INTO channel_permission_overwrite
		(guild_id, channel_id, overwrite_target_id, overwrite_target_type, allow_bitfield, deny_bitfield)
	SELECT s.guild_id, s.channel_id, s.overwrite_target_id, s.overwrite_target_type, s.allow_bitfield, s.deny_bitfield
	FROM UNNEST($1::bigint[], $2::bigint[], $3::bigint[], $4::text[], $5::text[], $6::text[])
		AS s(guild_id, channel_id, overwrite_target_id, overwrite_target_type, allow_bitfield, deny_bitfield)
	ON CONFLICT (channel_id, overwrite_target_id) DO UPDATE SET
		guild_id = EXCLUDED.guild_id,
		overwrite_target_type = EXCLUDED.overwrite_target_type,
		allow_bitfield = EXCLUDED.allow_bitfield,
		deny_bitfield = EXCLUDED.deny_bitfield
	RETURNING overwrite_target_id
`;

const CHANNEL_COLUMNS = `channel_id, guild_id, channel_type, channel_name, channel_position, is_thread, parent_channel_id`;

const FIND_CHANNELS_STATEMENT = `
	SELECT ${CHANNEL_COLUMNS}
	FROM channel
	WHERE guild_id = $1
	ORDER BY channel_position, channel_id
`;

const FIND_CHANNEL_STATEMENT = `
	SELECT ${CHANNEL_COLUMNS}
	FROM channel
	WHERE guild_id = $1 AND channel_id = $2
`;

const FIND_CHANNEL_OVERWRITES_STATEMENT = `
	SELECT overwrite_target_id, overwrite_target_type, allow_bitfield, deny_bitfield
	FROM channel_permission_overwrite
	WHERE guild_id = $1 AND channel_id = $2
	ORDER BY overwrite_target_id
`;

type ChannelRow = {
	channel_id: string;
	guild_id: string;
	channel_type: string;
	channel_name: string | null;
	channel_position: number | null;
	is_thread: boolean;
	parent_channel_id: string | null;
};

type OverwriteRow = {
	overwrite_target_id: string;
	overwrite_target_type: string;
	allow_bitfield: string;
	deny_bitfield: string;
};

/**
 * The two casts below are confined to this mapper on purpose. The columns are `text` because the type names
 * are the `discord` feature's normalized vocabulary and stay open to new kinds (R6, and its own rule that an
 * unknown code becomes `unknown` rather than being dropped), so reading one back is a widening the schema
 * already made. Nowhere below this file sees anything but the application type.
 */
function toRegistryChannel(row: ChannelRow): RegistryChannel {
	return {
		guildId: row.guild_id,
		channelId: row.channel_id,
		// The column is `text` because the normalized type names belong to the `discord` feature's vocabulary
		// and stay open to new kinds; the registry stores what it was given and hands back the same name (R6).
		channelType: row.channel_type as RegistryChannel["channelType"],
		name: row.channel_name,
		position: row.channel_position,
		parentChannelId: row.parent_channel_id
	};
}

function toChannelOverwrite(row: OverwriteRow): ChannelPermissionOverwrite {
	return {
		targetId: row.overwrite_target_id,
		targetType: row.overwrite_target_type as ChannelPermissionOverwrite["targetType"],
		allowBitfield: row.allow_bitfield,
		denyBitfield: row.deny_bitfield
	};
}

export class PostgresChannelRegistryRepository implements ChannelRegistryRepository {
	public constructor(
		private readonly deps: {
			readonly executor: SqlExecutor;
			readonly writeBatchSize: number;
		}
	) {}

	public readonly upsertChannels = async (
		channels: readonly RegistryChannel[]
	): Promise<RegistryBatchWriteResult> => {
		const validated = channels.map((channel) => {
			const scoped: RegistryChannel = {
				guildId: requireDiscordIdentifier("channel.guild_id", channel.guildId),
				channelId: requireDiscordIdentifier("channel.channel_id", channel.channelId),
				channelType: channel.channelType,
				name: channel.name,
				position: channel.position,
				parentChannelId:
					channel.parentChannelId === null
						? null
						: requireDiscordIdentifier("channel.parent_channel_id", channel.parentChannelId)
			};
			requireThreadParent(scoped);
			return scoped;
		});

		const parents = validated.filter((channel) => !registryChannelIsThread(channel));
		const threads = validated.filter(registryChannelIsThread);

		const parentResult = await this.writeChannelBatch(parents);
		const threadResult = await this.writeChannelBatch(threads);

		return {
			rowsWritten: parentResult.rowsWritten + threadResult.rowsWritten,
			batches: parentResult.batches + threadResult.batches
		};
	};

	public readonly deleteChannelAndDependents = async (
		guildId: DiscordIdentifier,
		channelId: DiscordIdentifier
	): Promise<RegistryChannelRemovalResult> => {
		const scopedGuildId = requireDiscordIdentifier("channel.guild_id", guildId);
		const scopedChannelId = requireDiscordIdentifier("channel.channel_id", channelId);

		return this.deps.executor.transaction(async (session) => {
			const children = await session.query<{ channel_id: string }>(FIND_CHILD_THREADS_STATEMENT, [
				scopedGuildId,
				scopedChannelId
			]);
			// The row being removed and any threads under it: one id set for the dependent sweeps, so the
			// parent foreign key never outlives the rows it points at.
			const affectedIds = [scopedChannelId, ...children.rows.map((row) => row.channel_id)];

			const overwrites = await session.query<{ overwrite_target_id: string }>(
				DELETE_CHANNEL_OVERWRITES_STATEMENT,
				[scopedGuildId, affectedIds]
			);
			const threadMemberships = await session.query<{ user_id: string }>(
				DELETE_CHANNEL_THREAD_MEMBERSHIPS_STATEMENT,
				[scopedGuildId, affectedIds]
			);
			const removedChildren = await session.query<{ channel_id: string }>(DELETE_CHILD_THREADS_STATEMENT, [
				scopedGuildId,
				children.rows.map((row) => row.channel_id)
			]);
			const channel = await session.query<{ channel_id: string }>(DELETE_CHANNEL_STATEMENT, [
				scopedGuildId,
				scopedChannelId
			]);

			return {
				channelRemoved: channel.rows.length > 0,
				childThreadsRemoved: removedChildren.rows.length,
				overwritesRemoved: overwrites.rows.length,
				threadMembershipsRemoved: threadMemberships.rows.length
			};
		});
	};

	public readonly replaceChannelOverwrites = async (
		set: RegistryChannelOverwriteSet
	): Promise<RegistryOverwriteReplacementResult> => {
		const guildId = requireDiscordIdentifier("channel_permission_overwrite.guild_id", set.guildId);
		const channelId = requireDiscordIdentifier("channel_permission_overwrite.channel_id", set.channelId);
		const overwrites = set.overwrites.map((overwrite) => ({
			targetId: requireDiscordIdentifier("channel_permission_overwrite.overwrite_target_id", overwrite.targetId),
			targetType: overwrite.targetType,
			allowBitfield: requirePermissionBitfield(
				"channel_permission_overwrite.allow_bitfield",
				overwrite.allowBitfield
			),
			denyBitfield: requirePermissionBitfield(
				"channel_permission_overwrite.deny_bitfield",
				overwrite.denyBitfield
			)
		}));

		return this.deps.executor.transaction(async (session) => {
			const removed = await session.query<{ overwrite_target_id: string }>(
				DELETE_CHANNEL_OVERWRITE_SET_STATEMENT,
				[guildId, channelId]
			);
			if (overwrites.length === 0) {
				return { overwritesRemoved: removed.rows.length, overwritesWritten: 0 };
			}
			const written = await session.query<{ overwrite_target_id: string }>(INSERT_CHANNEL_OVERWRITES_STATEMENT, [
				overwrites.map(() => guildId),
				overwrites.map(() => channelId),
				overwrites.map((overwrite) => overwrite.targetId),
				overwrites.map((overwrite) => overwrite.targetType),
				overwrites.map((overwrite) => overwrite.allowBitfield),
				overwrites.map((overwrite) => overwrite.denyBitfield)
			]);
			return { overwritesRemoved: removed.rows.length, overwritesWritten: written.rows.length };
		});
	};

	public readonly findChannels = async (guildId: DiscordIdentifier): Promise<readonly RegistryChannel[]> => {
		const { rows } = await this.deps.executor.query<ChannelRow>(FIND_CHANNELS_STATEMENT, [
			requireDiscordIdentifier("channel.guild_id", guildId)
		]);
		return rows.map(toRegistryChannel);
	};

	public readonly findChannel = async (
		guildId: DiscordIdentifier,
		channelId: DiscordIdentifier
	): Promise<RegistryChannel | null> => {
		const { rows } = await this.deps.executor.query<ChannelRow>(FIND_CHANNEL_STATEMENT, [
			requireDiscordIdentifier("channel.guild_id", guildId),
			requireDiscordIdentifier("channel.channel_id", channelId)
		]);
		const row = rows[0];
		return row === undefined ? null : toRegistryChannel(row);
	};

	public readonly findChannelOverwrites = async (
		guildId: DiscordIdentifier,
		channelId: DiscordIdentifier
	): Promise<readonly ChannelPermissionOverwrite[]> => {
		const { rows } = await this.deps.executor.query<OverwriteRow>(FIND_CHANNEL_OVERWRITES_STATEMENT, [
			requireDiscordIdentifier("channel_permission_overwrite.guild_id", guildId),
			requireDiscordIdentifier("channel_permission_overwrite.channel_id", channelId)
		]);
		return rows.map(toChannelOverwrite);
	};

	/** One bounded batch of the channel registry, in one transaction. */
	private readonly writeChannelBatch = async (
		channels: readonly RegistryChannel[]
	): Promise<RegistryBatchWriteResult> => {
		let rowsWritten = 0;
		let batches = 0;
		for (const batch of splitWriteBatch(channels, this.deps.writeBatchSize)) {
			batches += 1;
			rowsWritten += batch.length;
			await this.deps.executor.transaction(async (session) => {
				await session.query(UPSERT_CHANNELS_STATEMENT, [
					batch.map((channel) => channel.channelId),
					batch.map((channel) => channel.guildId),
					batch.map((channel) => channel.channelType),
					batch.map((channel) => channel.name),
					batch.map((channel) => channel.position),
					batch.map((channel) => registryChannelIsThread(channel)),
					batch.map((channel) => channel.parentChannelId)
				]);
			});
		}
		return { rowsWritten, batches };
	};
}
