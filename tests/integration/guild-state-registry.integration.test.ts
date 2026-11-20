import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPermissionOverwrite } from "../../src/features/discord/index.js";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";
import { PostgresGuildRegistryRepository } from "../../src/features/guild-state/repositories/postgres-guild-registry.repository.js";
import { PostgresRoleRegistryRepository } from "../../src/features/guild-state/repositories/postgres-role-registry.repository.js";
import { PostgresMembershipRegistryRepository } from "../../src/features/guild-state/repositories/postgres-membership-registry.repository.js";
import { PostgresChannelRegistryRepository } from "../../src/features/guild-state/repositories/postgres-channel-registry.repository.js";
import { PostgresThreadMembershipRegistryRepository } from "../../src/features/guild-state/repositories/postgres-thread-membership-registry.repository.js";
import {
	InvalidPermissionBitfieldError,
	SingleGuildViolationError
} from "../../src/features/guild-state/models/domain/guild-state-registry.errors.js";
import type {
	RegistryChannel,
	RegistryMembership,
	RegistryRole
} from "../../src/features/guild-state/models/domain/registry-records.js";

/**
 * T1 evidence — the permission registry against a real PostgreSQL.
 *
 * `docs/architecture/testing.md` is the reason this file exists: repository behaviour, constraints and
 * transaction atomicity are proven with real SQL, and a mocked `pg` would prove only call construction. So
 * every case below drives the actual `postgres-*` adapters over the actual migrations, in a database this
 * run created and drops again (see `postgres-test-database.ts`). When `TEST_DATABASE_URL` is absent the whole
 * suite is skipped and the harness prints the UNAVAILABLE banner — skipped is reported as missing evidence,
 * never counted as a pass.
 *
 * What the suite is about, rule by rule:
 * - R9  natural keys make a re-run change nothing observable.
 * - R3  a role deletion takes its membership rows and its overwrites with it, in one transaction, with the
 *       counts the log line is supposed to carry (R14).
 * - R4  ending a membership takes the role set, the member's thread edges and its member-targeted overwrites.
 * - R7  overwrite replacement removes a grant that disappeared instead of layering a new set on top of it.
 * - R6  a thread is never stored parentless — by the repository, and by the schema underneath it.
 * - R1  a second Guild row is structurally impossible, and a dependent row cannot be attached to another Guild.
 * - Contracts: the read projections the evaluation (T7) is built from return exactly the stored state.
 *
 * Two facts this suite pins that the owner should note, because they come from the schema rather than from
 * a preference: a role id the registry has never seen cannot be assigned to a member (the composite foreign
 * key on `guild_membership_role`) even though R5's error case describes storing it as given, and ending a
 * membership also removes the overwrites that targeted that member, which R4 does not mention. Both are the
 * schema's own posture; both are reported upward rather than quietly changed here.
 */

const GUILD_ID = "160000000000000001";
const OTHER_GUILD_ID = "160000000000000999";
const EVERYONE_ROLE_ID = GUILD_ID;
const ROLE_BACKEND = "160000000000000010";
const ROLE_OPS = "160000000000000011";
const ROLE_UNKNOWN = "160000000000000012";
const USER_ONE = "160000000000000101";
const USER_TWO = "160000000000000102";
const USER_THREE = "160000000000000103";
const CHANNEL_PRIVATE = "160000000000000201";
const CHANNEL_PUBLIC = "160000000000000202";
const THREAD_UNDER_PRIVATE = "160000000000000203";
const VIEW_CHANNEL = "1024";
const READ_MESSAGE_HISTORY = "65536";

describe.skipIf(!HAS_TEST_DATABASE)("guild-state registry (real PostgreSQL)", () => {
	let database: IsolatedTestDatabase | undefined;
	let guilds: PostgresGuildRegistryRepository;
	let roles: PostgresRoleRegistryRepository;
	let members: PostgresMembershipRegistryRepository;
	let channels: PostgresChannelRegistryRepository;
	let threadMemberships: PostgresThreadMembershipRegistryRepository;

	beforeAll(async () => {
		database = await openIsolatedTestDatabase("guild_state_registry");
		const executor = database.executor;
		guilds = new PostgresGuildRegistryRepository({ executor });
		roles = new PostgresRoleRegistryRepository({ executor, writeBatchSize: 200 });
		members = new PostgresMembershipRegistryRepository({ executor, writeBatchSize: 200 });
		channels = new PostgresChannelRegistryRepository({ executor, writeBatchSize: 200 });
		threadMemberships = new PostgresThreadMembershipRegistryRepository({ executor });
	}, 120_000);

	afterAll(async () => {
		// Best effort: a failed test must not leak a database into the shared server.
		await database?.close();
		database = undefined;
	});

	const registry = (): NonNullable<typeof database> => {
		if (database === undefined) {
			throw new Error("integration harness was used before its database was opened");
		}
		return database;
	};

	const role = (roleId: string, bitfield: string, position: number): RegistryRole => ({
		guildId: GUILD_ID,
		roleId,
		roleName: `role-${roleId}`,
		permissionsBitfield: bitfield,
		position
	});

	const channel = (
		channelId: string,
		channelType: RegistryChannel["channelType"],
		parentChannelId: string | null,
		position = 0
	): RegistryChannel => ({
		guildId: GUILD_ID,
		channelId,
		channelType,
		name: `channel-${channelId}`,
		position,
		parentChannelId
	});

	const membership = (userId: string, roleIds: readonly string[]): RegistryMembership => ({
		guildId: GUILD_ID,
		userId,
		roleIds
	});

	/** The whole stored registry, in the order the projections themselves define. */
	const snapshot = async () => {
		const stored = await registry();
		const guild = await guilds.findGuild(GUILD_ID);
		const userIds = await members.findMembershipUserIds(GUILD_ID);
		const memberships = await Promise.all(userIds.map((userId) => members.findMembership(GUILD_ID, userId)));
		const allChannels = await channels.findChannels(GUILD_ID);
		const overwrites = await Promise.all(
			allChannels.map(async (entry) => ({
				channelId: entry.channelId,
				overwrites: await channels.findChannelOverwrites(GUILD_ID, entry.channelId)
			}))
		);
		const threads = await Promise.all(
			allChannels
				.filter((entry) => entry.channelType === "private-thread")
				.map(async (entry) => ({
					threadId: entry.channelId,
					userIds: await threadMemberships.findThreadMemberUserIds(GUILD_ID, entry.channelId)
				}))
		);
		return {
			guild,
			storedGuild: await stored.countRows("guild"),
			roles: await roles.findRoles(GUILD_ID),
			memberships,
			channels: allChannels,
			overwrites,
			threads
		};
	};

	const seedGuild = async (): Promise<void> => {
		await guilds.upsertGuild({ guildId: GUILD_ID, guildName: "Example Guild" });
	};

	beforeEach(async () => {
		const stored = registry();
		await stored.resetRegistry();
		await seedGuild();
	});

	// --- harness ---------------------------------------------------------------

	it("runs on the database this harness created, with the migrated registry schema", async () => {
		const stored = registry();
		await stored.assertIsolation();
		expect(stored.databaseName).toMatch(/^discord_mcp_it_/);
		// The migration ran, so every registry table is here — the seven the harness lists and no more.
		for (const table of [
			"guild",
			"guild_role",
			"guild_membership",
			"guild_membership_role",
			"channel",
			"channel_permission_overwrite",
			"thread_membership"
		] as const) {
			expect(await stored.countRows(table)).toBeGreaterThanOrEqual(0);
		}
		await expect(stored.countRows("pgmigrations")).rejects.toThrow(/not a guild-state registry table/);
	});

	// --- R1: exactly one Guild, and nothing attachable to another ---------------

	it("refuses a second Guild row as a named error, leaving the registry on one Guild (R1)", async () => {
		const stored = registry();
		await expect(guilds.upsertGuild({ guildId: OTHER_GUILD_ID, guildName: "Other" })).rejects.toThrow(
			SingleGuildViolationError
		);
		expect(await guilds.findGuild(OTHER_GUILD_ID)).toBeNull();
		expect(await stored.countRows("guild")).toBe(1);

		// The same rule straight from the schema, with the adapter out of the way: the named unique index.
		await expect(
			stored.pool.query(`INSERT INTO guild (guild_id, guild_name) VALUES ($1, $2)`, [OTHER_GUILD_ID, "Other"])
		).rejects.toMatchObject({ code: "23505", constraint: "guild_registry_single_guild_index" });
	});

	it("cannot store a role that belongs to a guild the registry does not hold (R1)", async () => {
		const stored = registry();
		await expect(
			roles.upsertRoles([
				{
					guildId: OTHER_GUILD_ID,
					roleId: ROLE_UNKNOWN,
					roleName: "foreign",
					permissionsBitfield: "0",
					position: 0
				}
			])
		).rejects.toMatchObject({ code: "23503" });
		expect(await stored.countRows("guild_role")).toBe(0);
	});

	it("binds an overwrite to its channel's own guild, not to whatever the row claims (R1)", async () => {
		const stored = registry();
		await channels.upsertChannels([channel(CHANNEL_PRIVATE, "guild-text", null)]);
		await expect(
			// A row that names an existing channel but a different guild: the composite FK is what refuses it.
			stored.pool.query(
				`
					INSERT INTO channel_permission_overwrite
						(guild_id, channel_id, overwrite_target_id, overwrite_target_type, allow_bitfield, deny_bitfield)
					VALUES ($1, $2, $3, 'role', '0', '0')
				`,
				[OTHER_GUILD_ID, CHANNEL_PRIVATE, ROLE_BACKEND]
			)
		).rejects.toMatchObject({ code: "23503" });
		expect(await stored.countRows("channel_permission_overwrite")).toBe(0);
	});

	// --- R9: natural keys make a replay change nothing --------------------------

	it("re-applying the whole registry changes nothing observable (R9 idempotent batch upserts)", async () => {
		const stored = registry();
		const batch = async (): Promise<void> => {
			await roles.upsertRoles([
				role(EVERYONE_ROLE_ID, "0", 0),
				role(ROLE_BACKEND, VIEW_CHANNEL, 1),
				role(ROLE_OPS, READ_MESSAGE_HISTORY, 2)
			]);
			await channels.upsertChannels([
				channel(CHANNEL_PRIVATE, "guild-text", null, 0),
				channel(THREAD_UNDER_PRIVATE, "private-thread", CHANNEL_PRIVATE, 1)
			]);
			await members.upsertMemberships([
				membership(USER_ONE, [ROLE_BACKEND]),
				membership(USER_TWO, [ROLE_OPS]),
				membership(USER_THREE, [])
			]);
			await channels.replaceChannelOverwrites({
				guildId: GUILD_ID,
				channelId: CHANNEL_PRIVATE,
				overwrites: [
					{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }
				]
			});
			await threadMemberships.replaceThreadMemberships({
				guildId: GUILD_ID,
				threadId: THREAD_UNDER_PRIVATE,
				userIds: [USER_ONE, USER_TWO]
			});
		};

		await batch();
		const first = await snapshot();
		await batch();
		const second = await snapshot();

		expect(second).toEqual(first);
		// Counts, not just equality of projections: the second pass added no rows anywhere.
		expect(await stored.countRows("guild_role")).toBe(3);
		expect(await stored.countRows("guild_membership")).toBe(3);
		expect(await stored.countRows("guild_membership_role")).toBe(2);
		expect(await stored.countRows("channel")).toBe(2);
		expect(await stored.countRows("channel_permission_overwrite")).toBe(1);
		expect(await stored.countRows("thread_membership")).toBe(2);

		// A single-edge replay is a no-op too, and says so rather than duplicating.
		expect(
			await threadMemberships.addThreadMembership({
				guildId: GUILD_ID,
				threadId: THREAD_UNDER_PRIVATE,
				userId: USER_ONE
			})
		).toBe(false);
		expect(await threadMemberships.findThreadMemberUserIds(GUILD_ID, THREAD_UNDER_PRIVATE)).toEqual([
			USER_ONE,
			USER_TWO
		]);
	});

	it("splits an oversized roster into bounded batches and still converges on replay (R9, persistence.md)", async () => {
		const bounded = new PostgresMembershipRegistryRepository({ executor: registry().executor, writeBatchSize: 2 });
		const roster = Array.from({ length: 5 }, (_, index) =>
			membership(`16000000000000${4000 + index}`, index % 2 === 0 ? [ROLE_BACKEND] : [])
		);
		await roles.upsertRoles([role(EVERYONE_ROLE_ID, "0", 0), role(ROLE_BACKEND, "0", 1)]);

		expect(await bounded.upsertMemberships(roster)).toEqual({ rowsWritten: 8, batches: 3 });
		expect(await bounded.findMembershipUserIds(GUILD_ID)).toHaveLength(5);
		expect((await bounded.upsertMemberships(roster)).batches).toBe(3);
		expect(await registry().countRows("guild_membership_role")).toBe(3);
	});

	it("refuses a non-Discord bitfield before any row is written, not after (R3)", async () => {
		const stored = registry();
		await expect(roles.upsertRoles([role(ROLE_BACKEND, "0", 0), role(ROLE_OPS, "0x20", 1)])).rejects.toThrow(
			InvalidPermissionBitfieldError
		);
		// The whole list is validated up front: nothing half-applied is left behind.
		expect(await stored.countRows("guild_role")).toBe(0);
	});

	// --- R3: role deletion cascade ---------------------------------------------

	it("deleting a role removes its membership rows and its overwrites in one transaction, reporting counts (R3)", async () => {
		const stored = registry();
		await roles.upsertRoles([
			role(EVERYONE_ROLE_ID, "0", 0),
			role(ROLE_BACKEND, VIEW_CHANNEL, 1),
			role(ROLE_OPS, "0", 2)
		]);
		await channels.upsertChannels([
			channel(CHANNEL_PRIVATE, "guild-text", null),
			channel(CHANNEL_PUBLIC, "guild-text", null, 1)
		]);
		await members.upsertMemberships([
			membership(USER_ONE, [ROLE_BACKEND, ROLE_OPS]),
			membership(USER_TWO, [ROLE_BACKEND])
		]);
		await channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [
				{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" },
				{ targetId: ROLE_OPS, targetType: "role", allowBitfield: "0", denyBitfield: "0" }
			]
		});
		await channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PUBLIC,
			overwrites: [
				// A member-targeted row carrying the *same id* as the deleted role, in another channel: the
				// sweep is typed, so "the overwrites naming it" can only ever mean the role.
				{ targetId: ROLE_BACKEND, targetType: "member", allowBitfield: "0", denyBitfield: VIEW_CHANNEL }
			]
		});

		const result = await roles.deleteRoleAndDependents(GUILD_ID, ROLE_BACKEND);
		expect(result).toEqual({ roleRemoved: true, membershipLinksRemoved: 2, overwritesRemoved: 1 });

		expect(await stored.countRows("guild_role")).toBe(2);
		expect(await stored.countRows("guild_membership_role")).toBe(1);
		expect(await stored.countRows("channel_permission_overwrite")).toBe(2);
		// The typed sweep left the member-targeted row alone.
		expect(await channels.findChannelOverwrites(GUILD_ID, CHANNEL_PUBLIC)).toEqual([
			{ targetId: ROLE_BACKEND, targetType: "member", allowBitfield: "0", denyBitfield: VIEW_CHANNEL }
		]);
		// The member who held only that role keeps the other; nothing else was touched.
		expect((await members.findMembership(GUILD_ID, USER_ONE))?.roleIds).toEqual([ROLE_OPS]);
		expect((await members.findMembership(GUILD_ID, USER_TWO))?.roleIds).toEqual([]);
		expect((await roles.findRoles(GUILD_ID)).map((entry) => entry.roleId)).toEqual([EVERYONE_ROLE_ID, ROLE_OPS]);

		// An unknown id is a no-op with zero counts, not an error (a replayed GUILD_ROLE_DELETE).
		expect(await roles.deleteRoleAndDependents(GUILD_ID, ROLE_UNKNOWN)).toEqual({
			roleRemoved: false,
			membershipLinksRemoved: 0,
			overwritesRemoved: 0
		});
	});

	it("rolls a cascade back as one transaction when a later statement fails (R3 atomicity)", async () => {
		const stored = registry();
		await roles.upsertRoles([role(EVERYONE_ROLE_ID, "0", 0), role(ROLE_BACKEND, VIEW_CHANNEL, 1)]);
		await members.upsertMemberships([membership(USER_ONE, [ROLE_BACKEND])]);

		await expect(
			stored.executor.transaction(async (session) => {
				await session.query(`DELETE FROM guild_membership_role WHERE guild_id = $1 AND role_id = $2`, [
					GUILD_ID,
					ROLE_BACKEND
				]);
				await session.query(`DELETE FROM guild_role WHERE guild_id = $1 AND role_id = $2`, [
					GUILD_ID,
					ROLE_BACKEND
				]);
				// The same shape as a second FK violation mid-cascade: the whole unit must disappear.
				await session.query(
					`INSERT INTO guild_membership_role (guild_id, user_id, role_id) VALUES ($1, $2, $3)`,
					[GUILD_ID, USER_ONE, ROLE_UNKNOWN]
				);
			})
		).rejects.toMatchObject({ code: "23503" });

		expect(await stored.countRows("guild_membership_role")).toBe(1);
		expect(await stored.countRows("guild_role")).toBe(2);
	});

	// --- R4/R5: membership end and role-set replacement -------------------------

	it("ending a membership removes the membership, its role set and its thread edges in one transaction (R4)", async () => {
		const stored = registry();
		await roles.upsertRoles([role(EVERYONE_ROLE_ID, "0", 0), role(ROLE_BACKEND, VIEW_CHANNEL, 1)]);
		await channels.upsertChannels([
			channel(CHANNEL_PRIVATE, "guild-text", null),
			channel(THREAD_UNDER_PRIVATE, "private-thread", CHANNEL_PRIVATE, 1)
		]);
		await members.upsertMemberships([membership(USER_ONE, [ROLE_BACKEND]), membership(USER_TWO, [ROLE_BACKEND])]);
		await threadMemberships.addThreadMembership({
			guildId: GUILD_ID,
			threadId: THREAD_UNDER_PRIVATE,
			userId: USER_ONE
		});
		await channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [{ targetId: USER_ONE, targetType: "member", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }]
		});

		const result = await members.deleteMembershipAndDependents(GUILD_ID, USER_ONE);
		expect(result).toEqual({
			membershipRemoved: true,
			roleLinksRemoved: 1,
			overwritesRemoved: 1,
			threadMembershipsRemoved: 1
		});

		expect(await members.findMembership(GUILD_ID, USER_ONE)).toBeNull();
		expect(await stored.countRows("guild_membership")).toBe(1);
		expect(await stored.countRows("guild_membership_role")).toBe(1);
		expect(await stored.countRows("thread_membership")).toBe(0);
		// The other member is untouched — a cascade is scoped to one membership.
		expect((await members.findMembership(GUILD_ID, USER_TWO))?.roleIds).toEqual([ROLE_BACKEND]);

		// R4's error case: a removal for nobody is a no-op, not an error.
		expect(await members.deleteMembershipAndDependents(GUILD_ID, USER_THREE)).toEqual({
			membershipRemoved: false,
			roleLinksRemoved: 0,
			overwritesRemoved: 0,
			threadMembershipsRemoved: 0
		});
	});

	it("replaces a role set wholesale, including the empty set, and keeps it distinct from no membership (R5)", async () => {
		const stored = registry();
		await roles.upsertRoles([
			role(EVERYONE_ROLE_ID, "0", 0),
			role(ROLE_BACKEND, VIEW_CHANNEL, 1),
			role(ROLE_OPS, READ_MESSAGE_HISTORY, 2)
		]);
		await members.upsertMemberships([membership(USER_ONE, [ROLE_BACKEND])]);

		expect(await members.replaceMembershipRoles(membership(USER_ONE, [ROLE_BACKEND, ROLE_OPS]))).toEqual({
			roleLinksRemoved: 1,
			roleLinksWritten: 2
		});
		expect((await members.findMembership(GUILD_ID, USER_ONE))?.roleIds).toEqual([ROLE_BACKEND, ROLE_OPS]);

		// A replay is a replacement that happens to change nothing.
		expect(await members.replaceMembershipRoles(membership(USER_ONE, [ROLE_BACKEND, ROLE_OPS]))).toEqual({
			roleLinksRemoved: 2,
			roleLinksWritten: 2
		});

		expect(await members.replaceMembershipRoles(membership(USER_ONE, []))).toEqual({
			roleLinksRemoved: 2,
			roleLinksWritten: 0
		});
		const roleless = await members.findMembership(GUILD_ID, USER_ONE);
		expect(roleless?.roleIds).toEqual([]);
		// The distinction R5's boundary names: an empty set is a member, `null` is not.
		expect(await members.findMembership(GUILD_ID, USER_THREE)).toBeNull();
		expect(await stored.countRows("guild_membership")).toBe(1);
	});

	it("refuses a role id the registry has never seen, instead of storing an unresolvable grant", async () => {
		// NOTE for the owner: R5's error case describes storing an unknown role id as given, while R3 forbids
		// inventing role data and this schema carries a composite FK to `guild_role`. The schema's posture is
		// the one that holds here; the tension is reported rather than resolved by editing the migration.
		await roles.upsertRoles([role(EVERYONE_ROLE_ID, "0", 0)]);
		await members.upsertMemberships([membership(USER_ONE, [])]);
		await expect(members.replaceMembershipRoles(membership(USER_ONE, [ROLE_UNKNOWN]))).rejects.toMatchObject({
			code: "23503"
		});
		expect(await registry().countRows("guild_membership_role")).toBe(0);
	});

	// --- R6/R7: channel registry, threads and overwrite replacement -------------

	it("stores a thread only with its parent, refusing it twice over (R6)", async () => {
		const stored = registry();
		await channels.upsertChannels([channel(CHANNEL_PRIVATE, "guild-text", null)]);

		// Once by the feature, before any statement is built.
		await expect(channels.upsertChannels([channel(THREAD_UNDER_PRIVATE, "private-thread", null)])).rejects.toThrow(
			/without a parent channel/
		);
		expect(await stored.countRows("channel")).toBe(1);

		// And once by the schema, with the repository bypassed entirely.
		await expect(
			stored.pool.query(
				`
					INSERT INTO channel (channel_id, guild_id, channel_type, channel_name, channel_position, is_thread, parent_channel_id)
					VALUES ($1, $2, 'private-thread', 'orphan', 0, true, NULL)
				`,
				[THREAD_UNDER_PRIVATE, GUILD_ID]
			)
		).rejects.toMatchObject({ code: "23514", constraint: "channel_thread_has_parent" });

		// A thread whose parent exists nowhere is refused by the parent foreign key.
		await expect(
			channels.upsertChannels([channel(THREAD_UNDER_PRIVATE, "private-thread", CHANNEL_PUBLIC)])
		).rejects.toMatchObject({ code: "23503" });

		// With its parent in the same batch, it lands, carrying the parent.
		expect(
			(
				await channels.upsertChannels([
					channel(CHANNEL_PUBLIC, "guild-text", null, 1),
					channel(THREAD_UNDER_PRIVATE, "announcement-thread", CHANNEL_PUBLIC, 2)
				])
			).rowsWritten
		).toBe(2);
		const thread = await channels.findChannel(GUILD_ID, THREAD_UNDER_PRIVATE);
		expect(thread?.parentChannelId).toBe(CHANNEL_PUBLIC);
		expect(thread?.channelType).toBe("announcement-thread");
	});

	it("replacing an overwrite set removes the grant that disappeared and leaves other channels alone (R7)", async () => {
		const stored = registry();
		await channels.upsertChannels([
			channel(CHANNEL_PRIVATE, "guild-text", null),
			channel(CHANNEL_PUBLIC, "guild-text", null, 1)
		]);
		await channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [
				{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" },
				{ targetId: USER_ONE, targetType: "member", allowBitfield: "0", denyBitfield: VIEW_CHANNEL }
			]
		});
		await channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PUBLIC,
			overwrites: [
				{ targetId: ROLE_OPS, targetType: "role", allowBitfield: READ_MESSAGE_HISTORY, denyBitfield: "0" }
			]
		});

		// The new set drops the role grant and the member deny; replacement is not a merge.
		const replacement = await channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [
				{ targetId: ROLE_OPS, targetType: "role", allowBitfield: "0", denyBitfield: READ_MESSAGE_HISTORY }
			]
		});
		expect(replacement).toEqual({ overwritesRemoved: 2, overwritesWritten: 1 });

		expect(await channels.findChannelOverwrites(GUILD_ID, CHANNEL_PRIVATE)).toEqual([
			{ targetId: ROLE_OPS, targetType: "role", allowBitfield: "0", denyBitfield: READ_MESSAGE_HISTORY }
		]);
		// What the evaluation will read back: the removed grant can no longer be found at all.
		expect(
			(await channels.findChannelOverwrites(GUILD_ID, CHANNEL_PRIVATE)).some(
				(entry) => entry.targetId === ROLE_BACKEND
			)
		).toBe(false);
		// The other channel's set is untouched by this replacement.
		expect(await channels.findChannelOverwrites(GUILD_ID, CHANNEL_PUBLIC)).toHaveLength(1);
		expect(await stored.countRows("channel_permission_overwrite")).toBe(2);

		// An explicitly empty set is a legal replacement that clears the channel.
		expect(
			await channels.replaceChannelOverwrites({ guildId: GUILD_ID, channelId: CHANNEL_PRIVATE, overwrites: [] })
		).toEqual({ overwritesRemoved: 1, overwritesWritten: 0 });
		expect(await channels.findChannelOverwrites(GUILD_ID, CHANNEL_PRIVATE)).toEqual([]);
	});

	it("refuses two overwrites for one target in a single set, and the stored set survives whole (R7 atomicity)", async () => {
		const stored = registry();
		await channels.upsertChannels([channel(CHANNEL_PRIVATE, "guild-text", null)]);
		const original: readonly ChannelPermissionOverwrite[] = [
			{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }
		];
		await channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: original
		});

		// A payload naming the same target twice is refused by PostgreSQL — the replacement would update one key
		// twice — and because replacement is one transaction, the sweep that already ran is rolled back with it.
		// The registry therefore never ends up half-replaced: the stale grant is still there, still accurate.
		await expect(
			channels.replaceChannelOverwrites({
				guildId: GUILD_ID,
				channelId: CHANNEL_PRIVATE,
				overwrites: [
					{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: "0", denyBitfield: VIEW_CHANNEL },
					{ targetId: ROLE_BACKEND, targetType: "member", allowBitfield: "0", denyBitfield: "0" }
				]
			})
		).rejects.toThrow(/ON CONFLICT DO UPDATE command cannot affect row a second time/);

		expect(await channels.findChannelOverwrites(GUILD_ID, CHANNEL_PRIVATE)).toEqual(original);
		expect(await stored.countRows("channel_permission_overwrite")).toBe(1);
	});

	it("refuses an overwrite whose target type is neither role nor member (R7 error case)", async () => {
		await channels.upsertChannels([channel(CHANNEL_PRIVATE, "guild-text", null)]);
		await expect(
			registry().pool.query(
				`
					INSERT INTO channel_permission_overwrite
						(guild_id, channel_id, overwrite_target_id, overwrite_target_type, allow_bitfield, deny_bitfield)
					VALUES ($1, $2, $3, 'channel', '0', '0')
				`,
				[GUILD_ID, CHANNEL_PRIVATE, ROLE_BACKEND]
			)
		).rejects.toMatchObject({ code: "23514", constraint: "channel_permission_overwrite_target_is_role_or_member" });
	});

	it("deleting a channel removes its threads, their overwrites and their thread edges in one transaction (R6)", async () => {
		const stored = registry();
		await roles.upsertRoles([role(EVERYONE_ROLE_ID, "0", 0), role(ROLE_BACKEND, VIEW_CHANNEL, 1)]);
		await channels.upsertChannels([
			channel(CHANNEL_PRIVATE, "guild-text", null),
			channel(THREAD_UNDER_PRIVATE, "private-thread", CHANNEL_PRIVATE, 1),
			channel(CHANNEL_PUBLIC, "guild-text", null, 2)
		]);
		await members.upsertMemberships([membership(USER_ONE, [ROLE_BACKEND])]);
		await channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }]
		});
		await channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: THREAD_UNDER_PRIVATE,
			overwrites: [{ targetId: USER_ONE, targetType: "member", allowBitfield: "0", denyBitfield: "0" }]
		});
		await threadMemberships.addThreadMembership({
			guildId: GUILD_ID,
			threadId: THREAD_UNDER_PRIVATE,
			userId: USER_ONE
		});

		expect(await channels.deleteChannelAndDependents(GUILD_ID, CHANNEL_PRIVATE)).toEqual({
			channelRemoved: true,
			childThreadsRemoved: 1,
			overwritesRemoved: 2,
			threadMembershipsRemoved: 1
		});
		expect(await channels.findChannel(GUILD_ID, CHANNEL_PRIVATE)).toBeNull();
		expect(await channels.findChannel(GUILD_ID, THREAD_UNDER_PRIVATE)).toBeNull();
		expect(await stored.countRows("channel")).toBe(1);
		expect(await stored.countRows("channel_permission_overwrite")).toBe(0);
		expect(await stored.countRows("thread_membership")).toBe(0);
		// The unrelated channel is still there — the cascade followed the parent link and nothing else.
		expect((await channels.findChannel(GUILD_ID, CHANNEL_PUBLIC))?.channelId).toBe(CHANNEL_PUBLIC);
	});

	// --- R8: private-thread membership -----------------------------------------

	it("stores thread membership as edges, replacing the set so a removed member cannot still read (R8)", async () => {
		const stored = registry();
		await channels.upsertChannels([
			channel(CHANNEL_PRIVATE, "guild-text", null),
			channel(THREAD_UNDER_PRIVATE, "private-thread", CHANNEL_PRIVATE, 1)
		]);

		await expect(
			threadMemberships.addThreadMembership({ guildId: GUILD_ID, threadId: CHANNEL_PUBLIC, userId: USER_ONE })
		).rejects.toMatchObject({ code: "23503" });

		expect(
			await threadMemberships.addThreadMembership({
				guildId: GUILD_ID,
				threadId: THREAD_UNDER_PRIVATE,
				userId: USER_ONE
			})
		).toBe(true);
		expect(
			await threadMemberships.addThreadMembership({
				guildId: GUILD_ID,
				threadId: THREAD_UNDER_PRIVATE,
				userId: USER_ONE
			})
		).toBe(false);
		expect(await threadMemberships.findThreadMemberUserIds(GUILD_ID, THREAD_UNDER_PRIVATE)).toEqual([USER_ONE]);

		expect(
			await threadMemberships.replaceThreadMemberships({
				guildId: GUILD_ID,
				threadId: THREAD_UNDER_PRIVATE,
				userIds: [USER_TWO, USER_THREE]
			})
		).toEqual({ membershipsRemoved: 1, membershipsWritten: 2 });
		expect(await threadMemberships.findThreadMemberUserIds(GUILD_ID, THREAD_UNDER_PRIVATE)).toEqual([
			USER_TWO,
			USER_THREE
		]);
		// The other direction the accessible-channel list needs, as one bounded read.
		expect(await threadMemberships.findThreadIdsForMember(GUILD_ID, USER_TWO)).toEqual([THREAD_UNDER_PRIVATE]);
		expect(await threadMemberships.findThreadIdsForMember(GUILD_ID, USER_ONE)).toEqual([]);

		expect(
			await threadMemberships.removeThreadMembership({
				guildId: GUILD_ID,
				threadId: THREAD_UNDER_PRIVATE,
				userId: USER_TWO
			})
		).toBe(true);
		expect(
			await threadMemberships.removeThreadMembership({
				guildId: GUILD_ID,
				threadId: THREAD_UNDER_PRIVATE,
				userId: USER_TWO
			})
		).toBe(false);
		expect(await stored.countRows("thread_membership")).toBe(1);
	});

	// --- Contracts: the read projections evaluation is built from ---------------

	it("returns the projections evaluation needs, with ids and bitfields kept exact (Contracts, R3, R9)", async () => {
		const BIG_BEYOND_SAFE_INTEGER = "9223372036854775808";
		await roles.upsertRoles([
			role(EVERYONE_ROLE_ID, "2048", 0),
			role(ROLE_BACKEND, VIEW_CHANNEL, 1),
			role(ROLE_OPS, BIG_BEYOND_SAFE_INTEGER, 2)
		]);
		await members.upsertMemberships([membership(USER_ONE, [ROLE_BACKEND, ROLE_OPS])]);
		await channels.upsertChannels([channel(CHANNEL_PRIVATE, "guild-text", null)]);

		// Role bitfields, verbatim, and the @everyone fold key is the guild id itself.
		const permissions = await roles.findRolePermissions(GUILD_ID, [
			EVERYONE_ROLE_ID,
			ROLE_BACKEND,
			ROLE_OPS,
			ROLE_UNKNOWN
		]);
		expect(permissions).toEqual([
			{ roleId: EVERYONE_ROLE_ID, permissionsBitfield: "2048" },
			{ roleId: ROLE_BACKEND, permissionsBitfield: VIEW_CHANNEL },
			{ roleId: ROLE_OPS, permissionsBitfield: BIG_BEYOND_SAFE_INTEGER }
		]);
		// An unknown role is absent, not zero: absence and "grants nothing" are different facts (R10).
		expect(permissions.some((entry) => entry.roleId === ROLE_UNKNOWN)).toBe(false);
		expect(await roles.findRolePermissions(GUILD_ID, [])).toEqual([]);

		// Nothing on the read path came back as a JavaScript number.
		const membershipRow = await members.findMembership(GUILD_ID, USER_ONE);
		expect(typeof membershipRow?.userId).toBe("string");
		expect(membershipRow?.roleIds.every((id) => typeof id === "string")).toBe(true);
		expect((await roles.findRoles(GUILD_ID)).every((entry) => typeof entry.permissionsBitfield === "string")).toBe(
			true
		);
		// Deterministic ordering, position first with the id as tie-breaker.
		expect((await roles.findRoles(GUILD_ID)).map((entry) => entry.roleId)).toEqual([
			EVERYONE_ROLE_ID,
			ROLE_BACKEND,
			ROLE_OPS
		]);
		expect((await channels.findChannels(GUILD_ID)).map((entry) => entry.channelId)).toEqual([CHANNEL_PRIVATE]);
		expect(await channels.findChannel(GUILD_ID, "999999999999999999")).toBeNull();
	});

	it("reads a guild the registry never bootstrapped as no row, and a stored name as the registry's own (R13 reads)", async () => {
		const stored = registry();
		await stored.resetRegistry();
		expect(await guilds.findGuild(GUILD_ID)).toBeNull();
		expect(await guilds.upsertGuild({ guildId: GUILD_ID, guildName: "Renamed Hub" })).toEqual({
			guildId: GUILD_ID,
			guildName: "Renamed Hub"
		});
		// A rename is an update of the same row, never a second one (R1).
		await guilds.upsertGuild({ guildId: GUILD_ID, guildName: "Renamed Again" });
		expect((await guilds.findGuild(GUILD_ID))?.guildName).toBe("Renamed Again");
		expect(await stored.countRows("guild")).toBe(1);
		// The column's own check refuses a blank name, so the registry cannot hold a nameless Guild.
		await expect(stored.pool.query(`UPDATE guild SET guild_name = $1`, [""])).rejects.toMatchObject({
			code: "23514",
			constraint: "guild_name_is_never_blank"
		});
	});
});
