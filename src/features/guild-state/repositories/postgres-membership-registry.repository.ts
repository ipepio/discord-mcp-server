import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import type {
	RegistryBatchWriteResult,
	RegistryMembership,
	RegistryMembershipRemovalResult,
	RegistryRoleSetReplacementResult
} from "../models/domain/registry-records.js";
import { splitWriteBatch } from "./registry-write-batch.js";
import type { MembershipRegistryRepository } from "./membership-registry.repository.js";
import type { SqlExecutor } from "./sql-executor.js";

/**
 * Membership identity and role sets (docs/features/guild-state.md R4, R5, R9).
 *
 * R5 is why the batch write replaces sets instead of adding to them: Discord's member payload carries the
 * whole `roles` array, so "merge" would invent state nobody sent. One batch is therefore three statements
 * in one transaction — identity rows, the sweep of exactly those members' assignments, and the new
 * assignments — which is also what makes a replay of the same roster page a no-op (R9): the swept set and
 * the inserted set are identical, and the identity insert conflicts and does nothing.
 *
 * The sweep is scoped by the batch's own (guild_id, user_id) pairs through an `UNNEST` source rather than a
 * loose `user_id = ANY(...)`, so a member of another Guild can never be swept by accident (R1).
 */

const UPSERT_MEMBERSHIP_IDENTITIES_STATEMENT = `
	INSERT INTO guild_membership (guild_id, user_id)
	SELECT s.guild_id, s.user_id
	FROM UNNEST($1::bigint[], $2::bigint[]) AS s(guild_id, user_id)
	ON CONFLICT (guild_id, user_id) DO NOTHING
`;

const DELETE_ROLES_FOR_BATCH_STATEMENT = `
	DELETE FROM guild_membership_role
	WHERE (guild_id, user_id) IN (
		SELECT s.guild_id, s.user_id
		FROM UNNEST($1::bigint[], $2::bigint[]) AS s(guild_id, user_id)
	)
	RETURNING role_id
`;

/**
 * One statement for both shapes of an assignment insert: a whole batch, or one member's set repeated across
 * the member columns. `ON CONFLICT DO NOTHING` keeps a replay from failing, and `RETURNING` counts only the
 * rows that were really added.
 */
const INSERT_MEMBERSHIP_ROLES_STATEMENT = `
	INSERT INTO guild_membership_role (guild_id, user_id, role_id)
	SELECT s.guild_id, s.user_id, s.role_id
	FROM UNNEST($1::bigint[], $2::bigint[], $3::bigint[]) AS s(guild_id, user_id, role_id)
	ON CONFLICT (guild_id, user_id, role_id) DO NOTHING
	RETURNING role_id
`;

const DELETE_MEMBERSHIP_ROLES_STATEMENT = `
	DELETE FROM guild_membership_role
	WHERE guild_id = $1 AND user_id = $2
	RETURNING role_id
`;

const DELETE_MEMBERSHIP_OVERWRITES_STATEMENT = `
	DELETE FROM channel_permission_overwrite
	WHERE guild_id = $1 AND overwrite_target_type = 'member' AND overwrite_target_id = $2
	RETURNING channel_id
`;

const DELETE_MEMBERSHIP_THREAD_MEMBERSHIPS_STATEMENT = `
	DELETE FROM thread_membership
	WHERE guild_id = $1 AND user_id = $2
	RETURNING thread_id
`;

const DELETE_MEMBERSHIP_STATEMENT = `
	DELETE FROM guild_membership
	WHERE guild_id = $1 AND user_id = $2
	RETURNING user_id
`;

/**
 * One statement, one read: the membership row and its role set aggregated. A member with no roles comes back
 * with an empty set; a member the registry does not have comes back as no row at all, which is the difference
 * R12 must see and R4's error case names (an evaluation for a non-member is not an evaluation for a member
 * with no grants). `pg` parses `bigint[]` elements as strings, so the set never passes through a number (R9).
 *
 * The `FILTER` clause is not decoration. A member who holds nothing is one `LEFT JOIN` row whose `role_id` is
 * null, and `ARRAY_AGG` over it is the one-element array `{NULL}` — which is not SQL null, so `COALESCE` never
 * replaces it. Without the filter, R5's valid "empty role set" state would read back as `[null]` and reach
 * evaluation as a phantom role id.
 */
const FIND_MEMBERSHIP_STATEMENT = `
	SELECT m.guild_id, m.user_id,
		COALESCE(ARRAY_AGG(r.role_id ORDER BY r.role_id) FILTER (WHERE r.role_id IS NOT NULL), '{}') AS role_ids
	FROM guild_membership AS m
	LEFT JOIN guild_membership_role AS r ON r.guild_id = m.guild_id AND r.user_id = m.user_id
	WHERE m.guild_id = $1 AND m.user_id = $2
	GROUP BY m.guild_id, m.user_id
`;

const FIND_MEMBERSHIP_USER_IDS_STATEMENT = `
	SELECT user_id
	FROM guild_membership
	WHERE guild_id = $1
	ORDER BY user_id
`;

type MembershipRow = { guild_id: string; user_id: string; role_ids: string[] };

/** One (member, role) pair, with the member's own columns alongside it. */
type MembershipRoleAssignment = {
	readonly guildId: DiscordIdentifier;
	readonly userId: DiscordIdentifier;
	readonly roleId: DiscordIdentifier;
};

function validateMembership(membership: RegistryMembership): RegistryMembership {
	return {
		guildId: requireDiscordIdentifier("guild_membership.guild_id", membership.guildId),
		userId: requireDiscordIdentifier("guild_membership.user_id", membership.userId),
		roleIds: membership.roleIds.map((roleId) => requireDiscordIdentifier("guild_membership_role.role_id", roleId))
	};
}

function assignmentsOf(memberships: readonly RegistryMembership[]): readonly MembershipRoleAssignment[] {
	return memberships.flatMap((membership) =>
		membership.roleIds.map((roleId): MembershipRoleAssignment => ({
			guildId: membership.guildId,
			userId: membership.userId,
			roleId
		}))
	);
}

export class PostgresMembershipRegistryRepository implements MembershipRegistryRepository {
	public constructor(
		private readonly deps: {
			readonly executor: SqlExecutor;
			readonly writeBatchSize: number;
		}
	) {}

	public readonly upsertMemberships = async (
		memberships: readonly RegistryMembership[]
	): Promise<RegistryBatchWriteResult> => {
		let membersWritten = 0;
		let linksWritten = 0;
		let batchCount = 0;

		for (const memberBatch of splitWriteBatch(memberships, this.deps.writeBatchSize)) {
			batchCount += 1;
			// Validated per batch, before that batch's transaction opens. A batch that fails leaves the earlier
			// ones stored and this part pending, which is R2 and R9's resumable shape rather than a partial lie.
			const batch = memberBatch.map(validateMembership);
			const guildIds = batch.map((membership) => membership.guildId);
			const userIds = batch.map((membership) => membership.userId);
			const assignments = assignmentsOf(batch);

			membersWritten += batch.length;
			linksWritten += await this.deps.executor.transaction(async (session) => {
				await session.query(UPSERT_MEMBERSHIP_IDENTITIES_STATEMENT, [guildIds, userIds]);
				await session.query(DELETE_ROLES_FOR_BATCH_STATEMENT, [guildIds, userIds]);
				if (assignments.length === 0) {
					return 0;
				}
				const inserted = await session.query<{ role_id: string }>(INSERT_MEMBERSHIP_ROLES_STATEMENT, [
					assignments.map((assignment) => assignment.guildId),
					assignments.map((assignment) => assignment.userId),
					assignments.map((assignment) => assignment.roleId)
				]);
				return inserted.rows.length;
			});
		}

		return { rowsWritten: membersWritten + linksWritten, batches: batchCount };
	};

	public readonly replaceMembershipRoles = async (
		membership: RegistryMembership
	): Promise<RegistryRoleSetReplacementResult> => {
		const validated = validateMembership(membership);

		return this.deps.executor.transaction(async (session) => {
			const removed = await session.query<{ role_id: string }>(DELETE_MEMBERSHIP_ROLES_STATEMENT, [
				validated.guildId,
				validated.userId
			]);
			if (validated.roleIds.length === 0) {
				return { roleLinksRemoved: removed.rows.length, roleLinksWritten: 0 };
			}
			const inserted = await session.query<{ role_id: string }>(INSERT_MEMBERSHIP_ROLES_STATEMENT, [
				validated.roleIds.map(() => validated.guildId),
				validated.roleIds.map(() => validated.userId),
				validated.roleIds
			]);
			return { roleLinksRemoved: removed.rows.length, roleLinksWritten: inserted.rows.length };
		});
	};

	public readonly deleteMembershipAndDependents = async (
		guildId: DiscordIdentifier,
		userId: DiscordIdentifier
	): Promise<RegistryMembershipRemovalResult> => {
		const scopedGuildId = requireDiscordIdentifier("guild_membership.guild_id", guildId);
		const scopedUserId = requireDiscordIdentifier("guild_membership.user_id", userId);

		return this.deps.executor.transaction(async (session) => {
			const links = await session.query<{ role_id: string }>(DELETE_MEMBERSHIP_ROLES_STATEMENT, [
				scopedGuildId,
				scopedUserId
			]);
			const overwrites = await session.query<{ channel_id: string }>(DELETE_MEMBERSHIP_OVERWRITES_STATEMENT, [
				scopedGuildId,
				scopedUserId
			]);
			const threads = await session.query<{ thread_id: string }>(DELETE_MEMBERSHIP_THREAD_MEMBERSHIPS_STATEMENT, [
				scopedGuildId,
				scopedUserId
			]);
			const membership = await session.query<{ user_id: string }>(DELETE_MEMBERSHIP_STATEMENT, [
				scopedGuildId,
				scopedUserId
			]);

			return {
				membershipRemoved: membership.rows.length > 0,
				roleLinksRemoved: links.rows.length,
				overwritesRemoved: overwrites.rows.length,
				threadMembershipsRemoved: threads.rows.length
			};
		});
	};

	public readonly findMembership = async (
		guildId: DiscordIdentifier,
		userId: DiscordIdentifier
	): Promise<RegistryMembership | null> => {
		const { rows } = await this.deps.executor.query<MembershipRow>(FIND_MEMBERSHIP_STATEMENT, [
			requireDiscordIdentifier("guild_membership.guild_id", guildId),
			requireDiscordIdentifier("guild_membership.user_id", userId)
		]);
		const row = rows[0];
		if (row === undefined) {
			return null;
		}
		return { guildId: row.guild_id, userId: row.user_id, roleIds: [...row.role_ids] };
	};

	public readonly findMembershipUserIds = async (
		guildId: DiscordIdentifier
	): Promise<readonly DiscordIdentifier[]> => {
		const { rows } = await this.deps.executor.query<{ user_id: string }>(FIND_MEMBERSHIP_USER_IDS_STATEMENT, [
			requireDiscordIdentifier("guild_membership.guild_id", guildId)
		]);
		return rows.map((row) => row.user_id);
	};
}
