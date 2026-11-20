import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import type {
	RegistryThreadMembership,
	RegistryThreadMembershipReplacementResult,
	RegistryThreadMembershipSet
} from "../models/domain/registry-records.js";
import type { ThreadMembershipRegistryRepository } from "./thread-membership-registry.repository.js";
import type { SqlExecutor } from "./sql-executor.js";

/**
 * Private-thread membership (docs/features/guild-state.md R8). This table is the only way R8's
 * private-thread visibility can be answered: a private thread has no overwrite rows to read and Discord
 * sends its members as user ids, so the fact is stored as (thread, member) edges and nothing else.
 *
 * Two write shapes because two futures need them. `replaceThreadMemberships` is what a REST reconciliation
 * converges to — the whole set, one transaction, so an edge that Discord no longer reports cannot stay
 * visible (R10). `addThreadMembership` / `removeThreadMembership` are what a `THREAD_MEMBERSHIP_ADD` or
 * `_REMOVE` event applies, one edge each. Which of the two feeds the table is open decision O1; both are
 * here so O1 can be settled without rewriting this file.
 *
 * The thread must exist in the registry: the composite foreign key on (guild_id, thread_id) refuses an edge
 * for an unknown thread and refuses one carried over from another Guild (R1). There is deliberately no
 * foreign key from `user_id` to `guild_membership` — R8's fact stands on its own, and a reconciliation that
 * runs before the roster page lands must not fail on ordering.
 */

const DELETE_THREAD_MEMBERSHIP_SET_STATEMENT = `
	DELETE FROM thread_membership
	WHERE guild_id = $1 AND thread_id = $2
	RETURNING user_id
`;

const INSERT_THREAD_MEMBERSHIPS_STATEMENT = `
	INSERT INTO thread_membership (guild_id, thread_id, user_id)
	SELECT s.guild_id, s.thread_id, s.user_id
	FROM UNNEST($1::bigint[], $2::bigint[], $3::bigint[]) AS s(guild_id, thread_id, user_id)
	ON CONFLICT (thread_id, user_id) DO NOTHING
	RETURNING user_id
`;

const INSERT_THREAD_MEMBERSHIP_STATEMENT = `
	INSERT INTO thread_membership (guild_id, thread_id, user_id)
	VALUES ($1, $2, $3)
	ON CONFLICT (thread_id, user_id) DO NOTHING
	RETURNING user_id
`;

const DELETE_THREAD_MEMBERSHIP_STATEMENT = `
	DELETE FROM thread_membership
	WHERE guild_id = $1 AND thread_id = $2 AND user_id = $3
	RETURNING user_id
`;

const FIND_THREAD_MEMBER_USER_IDS_STATEMENT = `
	SELECT user_id
	FROM thread_membership
	WHERE guild_id = $1 AND thread_id = $2
	ORDER BY user_id
`;

/** R8 and spec Contracts together: the accessible-thread list is one bounded set read, never a per-thread loop. */
const FIND_THREAD_IDS_FOR_MEMBER_STATEMENT = `
	SELECT thread_id
	FROM thread_membership
	WHERE guild_id = $1 AND user_id = $2
	ORDER BY thread_id
`;

export class PostgresThreadMembershipRegistryRepository implements ThreadMembershipRegistryRepository {
	public constructor(
		private readonly deps: {
			readonly executor: SqlExecutor;
		}
	) {}

	public readonly replaceThreadMemberships = async (
		set: RegistryThreadMembershipSet
	): Promise<RegistryThreadMembershipReplacementResult> => {
		const guildId = requireDiscordIdentifier("thread_membership.guild_id", set.guildId);
		const threadId = requireDiscordIdentifier("thread_membership.thread_id", set.threadId);
		const userIds = set.userIds.map((userId) => requireDiscordIdentifier("thread_membership.user_id", userId));

		return this.deps.executor.transaction(async (session) => {
			const removed = await session.query<{ user_id: string }>(DELETE_THREAD_MEMBERSHIP_SET_STATEMENT, [
				guildId,
				threadId
			]);
			if (userIds.length === 0) {
				return { membershipsRemoved: removed.rows.length, membershipsWritten: 0 };
			}
			const written = await session.query<{ user_id: string }>(INSERT_THREAD_MEMBERSHIPS_STATEMENT, [
				userIds.map(() => guildId),
				userIds.map(() => threadId),
				userIds
			]);
			return { membershipsRemoved: removed.rows.length, membershipsWritten: written.rows.length };
		});
	};

	public readonly addThreadMembership = async (membership: RegistryThreadMembership): Promise<boolean> => {
		const written = await this.deps.executor.query<{ user_id: string }>(INSERT_THREAD_MEMBERSHIP_STATEMENT, [
			requireDiscordIdentifier("thread_membership.guild_id", membership.guildId),
			requireDiscordIdentifier("thread_membership.thread_id", membership.threadId),
			requireDiscordIdentifier("thread_membership.user_id", membership.userId)
		]);
		return written.rows.length > 0;
	};

	public readonly removeThreadMembership = async (membership: RegistryThreadMembership): Promise<boolean> => {
		const removed = await this.deps.executor.query<{ user_id: string }>(DELETE_THREAD_MEMBERSHIP_STATEMENT, [
			requireDiscordIdentifier("thread_membership.guild_id", membership.guildId),
			requireDiscordIdentifier("thread_membership.thread_id", membership.threadId),
			requireDiscordIdentifier("thread_membership.user_id", membership.userId)
		]);
		return removed.rows.length > 0;
	};

	public readonly findThreadMemberUserIds = async (
		guildId: DiscordIdentifier,
		threadId: DiscordIdentifier
	): Promise<readonly DiscordIdentifier[]> => {
		const { rows } = await this.deps.executor.query<{ user_id: string }>(FIND_THREAD_MEMBER_USER_IDS_STATEMENT, [
			requireDiscordIdentifier("thread_membership.guild_id", guildId),
			requireDiscordIdentifier("thread_membership.thread_id", threadId)
		]);
		return rows.map((row) => row.user_id);
	};

	public readonly findThreadIdsForMember = async (
		guildId: DiscordIdentifier,
		userId: DiscordIdentifier
	): Promise<readonly DiscordIdentifier[]> => {
		const { rows } = await this.deps.executor.query<{ thread_id: string }>(FIND_THREAD_IDS_FOR_MEMBER_STATEMENT, [
			requireDiscordIdentifier("thread_membership.guild_id", guildId),
			requireDiscordIdentifier("thread_membership.user_id", userId)
		]);
		return rows.map((row) => row.thread_id);
	};
}
