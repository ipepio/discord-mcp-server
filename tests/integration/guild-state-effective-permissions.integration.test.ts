import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";
import { createGuildStateConfig } from "../../src/features/guild-state/config/guild-state-config.interface.js";
import { PostgresGuildRegistryRepository } from "../../src/features/guild-state/repositories/postgres-guild-registry.repository.js";
import { PostgresRoleRegistryRepository } from "../../src/features/guild-state/repositories/postgres-role-registry.repository.js";
import { PostgresMembershipRegistryRepository } from "../../src/features/guild-state/repositories/postgres-membership-registry.repository.js";
import { PostgresChannelRegistryRepository } from "../../src/features/guild-state/repositories/postgres-channel-registry.repository.js";
import { PostgresThreadMembershipRegistryRepository } from "../../src/features/guild-state/repositories/postgres-thread-membership-registry.repository.js";
import { PostgresPermissionSnapshotRepository } from "../../src/features/guild-state/repositories/postgres-permission-snapshot.repository.js";
import { DeleteRoleCommand } from "../../src/features/guild-state/commands/delete-role.command.js";
import { EvaluateEffectivePermissionsQuery } from "../../src/features/guild-state/queries/evaluate-effective-permissions.query.js";
import { ListIngestibleChannelsQuery } from "../../src/features/guild-state/queries/list-ingestible-channels.query.js";
import { ListUserAccessibleChannelsQuery } from "../../src/features/guild-state/queries/list-user-accessible-channels.query.js";
import type { RegistryChannel, RegistryRole } from "../../src/features/guild-state/models/domain/registry-records.js";
import { RecordingLogger } from "../features/guild-state/fakes/recording-logger.js";

/**
 * T7 evidence — the effective-permission evaluation against a real PostgreSQL (docs/architecture/testing.md:
 * repository behaviour and transaction atomicity are proven with real SQL; docs/features/guild-state.md
 * "Implementation and proof"). The mocked projections in
 * `tests/features/guild-state/effective-permission-rules.test.ts` prove the five stages; this file proves the
 * half of the contract a fake cannot prove: that the rows the SQL reads back are the rows the derivation
 * decided from, and that the read really is one instant.
 *
 * What is pinned here, rule by rule:
 * - R3  a bitfield above 2^53 survives text storage, the SQL read and the derivation, unchanged.
 * - R12 the evaluation follows a registry change immediately: removing a role removes its base union and the
 *       overwrite that named it, in the next call (the `revocation-role-removed` shape, applied at the
 *       registry level; the five ADR 0005 named cases belong to T9).
 * - R13 repeated evaluation writes nothing — row counts of every registry table are the evidence.
 * - Contracts the snapshot is one consistent instant: base role bits and the overwrite rows that name the
 *       same role are read together, so a concurrent writer can never tear a decision.
 * - R6, R7, R8 fail-closed unknown channel, allow-beats-deny inside the role stage, the member row beating it,
 *       a thread evaluated over its parent's set, and a private thread admitted only by a stored edge.
 */

const GUILD_ID = "170000000000000001";
const USER_ID = "170000000000000101";
const OTHER_USER_ID = "170000000000000102";
const BOT_USER_ID = "170000000000000109";
const ROLE_BACKEND = "170000000000000010";
const ROLE_OPS = "170000000000000011";
const CHANNEL_PUBLIC = "170000000000000201";
const CHANNEL_PRIVATE = "170000000000000202";
const THREAD_UNDER_PRIVATE = "170000000000000203";
const PRIVATE_THREAD = "170000000000000204";
const UNKNOWN_CHANNEL = "170000000000000999";
const VOICE_CHANNEL = "170000000000000205";

const VIEW = "1024";
const SEND = "2048";
const HISTORY = "65536";
const MENTION = "131072";
const ADMINISTRATOR = "8";
/** 2^50 | 2^51 — a value no JavaScript number holds exactly, stored and read back as text (R3). */
const HIGH_BITS = "3377699720527872";
const EVERYONE_BITS = (BigInt(VIEW) | BigInt(HISTORY)).toString();
const BACKEND_BITS = (BigInt(SEND) | BigInt(HIGH_BITS)).toString();

describe.skipIf(!HAS_TEST_DATABASE)("guild-state effective permissions (real PostgreSQL)", () => {
	let database: IsolatedTestDatabase;
	let logger: RecordingLogger;
	let guilds: PostgresGuildRegistryRepository;
	let roles: PostgresRoleRegistryRepository;
	let members: PostgresMembershipRegistryRepository;
	let channels: PostgresChannelRegistryRepository;
	let threadMemberships: PostgresThreadMembershipRegistryRepository;
	let snapshots: PostgresPermissionSnapshotRepository;
	let evaluate: EvaluateEffectivePermissionsQuery;
	let listForUser: ListUserAccessibleChannelsQuery;
	let listIngestible: ListIngestibleChannelsQuery;
	let deleteRole: DeleteRoleCommand;

	beforeAll(async () => {
		database = await openIsolatedTestDatabase("guild_state_permissions");
		logger = new RecordingLogger();
		const config = createGuildStateConfig({ guildId: GUILD_ID });
		guilds = new PostgresGuildRegistryRepository({ executor: database.executor });
		roles = new PostgresRoleRegistryRepository({ executor: database.executor, writeBatchSize: 200 });
		members = new PostgresMembershipRegistryRepository({ executor: database.executor, writeBatchSize: 200 });
		channels = new PostgresChannelRegistryRepository({ executor: database.executor, writeBatchSize: 200 });
		threadMemberships = new PostgresThreadMembershipRegistryRepository({ executor: database.executor });
		snapshots = new PostgresPermissionSnapshotRepository({ executor: database.executor });
		evaluate = new EvaluateEffectivePermissionsQuery({ config, snapshot: snapshots, logger });
		listForUser = new ListUserAccessibleChannelsQuery({ config, snapshot: snapshots, logger });
		listIngestible = new ListIngestibleChannelsQuery({ config, snapshot: snapshots, logger });
		deleteRole = new DeleteRoleCommand({
			config,
			roleRegistry: roles,
			logger
		});
	}, 180_000);

	afterAll(async () => {
		await database?.close();
		database = undefined as unknown as IsolatedTestDatabase;
	});

	const role = (roleId: string, bitfield: string, position = 1): RegistryRole => ({
		guildId: GUILD_ID,
		roleId,
		roleName: `role-${roleId.slice(-3)}`,
		permissionsBitfield: bitfield,
		position
	});

	const channel = (
		channelId: string,
		channelType: RegistryChannel["channelType"] = "guild-text",
		parentChannelId: string | null = null
	): RegistryChannel => ({
		guildId: GUILD_ID,
		channelId,
		channelType,
		name: `channel-${channelId}`,
		position: Number(channelId.slice(-2)),
		parentChannelId
	});

	/**
	 * The fixture registry: @everyone views and reads history, `backend` adds send (and the high bits), `ops`
	 * denies send on #public while allowing mentions (so the role stage's allow-beats-deny is exercised on real
	 * rows), a member row on #private denies history, a thread under #private carries its own set, and one
	 * private thread is admitted only by a membership edge.
	 */
	beforeEach(async () => {
		await database.resetRegistry();
		await guilds.upsertGuild({ guildId: GUILD_ID, guildName: "Test guild" });
		await roles.upsertRoles([role(GUILD_ID, EVERYONE_BITS), role(ROLE_BACKEND, BACKEND_BITS), role(ROLE_OPS, "0")]);
		await members.upsertMemberships([
			{ guildId: GUILD_ID, userId: USER_ID, roleIds: [ROLE_BACKEND, ROLE_OPS] },
			{ guildId: GUILD_ID, userId: BOT_USER_ID, roleIds: [] }
		]);
		await channels.upsertChannels([
			channel(CHANNEL_PUBLIC),
			channel(CHANNEL_PRIVATE),
			channel(THREAD_UNDER_PRIVATE, "public-thread", CHANNEL_PRIVATE),
			channel(PRIVATE_THREAD, "private-thread", CHANNEL_PRIVATE),
			channel(VOICE_CHANNEL, "guild-voice")
		]);
		await channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PUBLIC,
			overwrites: [
				{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: MENTION, denyBitfield: SEND },
				{ targetId: ROLE_OPS, targetType: "role", allowBitfield: SEND, denyBitfield: "0" }
			]
		});
		await channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [{ targetId: USER_ID, targetType: "member", allowBitfield: "0", denyBitfield: HISTORY }]
		});
		await channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: THREAD_UNDER_PRIVATE,
			overwrites: [{ targetId: GUILD_ID, targetType: "role", allowBitfield: HISTORY, denyBitfield: "0" }]
		});
		await channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: VOICE_CHANNEL,
			overwrites: [{ targetId: GUILD_ID, targetType: "role", allowBitfield: "0", denyBitfield: VIEW }]
		});
		await threadMemberships.addThreadMembership({ guildId: GUILD_ID, threadId: PRIVATE_THREAD, userId: USER_ID });
	});

	const decide = (userId: string, channelId: string) => evaluate.execute({ userId, channelId });

	it("reads the stored state back through the snapshot projection, exactly as written", async () => {
		const snapshot = await snapshots.loadSnapshot({
			guildId: GUILD_ID,
			userId: USER_ID,
			channelId: THREAD_UNDER_PRIVATE
		});

		expect(snapshot.guild).toEqual({ guildId: GUILD_ID, guildName: "Test guild" });
		expect(snapshot.membership?.roleIds).toEqual([ROLE_BACKEND, ROLE_OPS]);
		expect(BigInt(snapshot.everyonePermissions ?? "0")).toBe(BigInt(VIEW) | BigInt(HISTORY));
		// The narrow read carries the target and its parent, and nothing else (spec Contracts' thread rule).
		expect(snapshot.channels.map((entry) => entry.channelId).sort()).toEqual(
			[THREAD_UNDER_PRIVATE, CHANNEL_PRIVATE].sort()
		);
		expect(snapshot.privateThreadIds).toEqual([PRIVATE_THREAD]);
	});

	it("reflects registry names and positions, including a rename on the next accessible-list read", async () => {
		const original = channel(CHANNEL_PUBLIC);
		const before = await listForUser.execute({ userId: USER_ID });
		expect(before.channels.find((entry) => entry.channelId === CHANNEL_PUBLIC)).toMatchObject({
			name: original.name,
			position: original.position
		});

		await channels.upsertChannels([{ ...original, name: "renamed-in-registry" }]);

		const after = await listForUser.execute({ userId: USER_ID });
		expect(after.channels.find((entry) => entry.channelId === CHANNEL_PUBLIC)).toMatchObject({
			name: "renamed-in-registry",
			position: original.position
		});
		expect(after.channels.map((entry) => entry.channelId)).toEqual(before.channels.map((entry) => entry.channelId));
	});

	it("keeps a bitfield above 2^53 exact from the column through the decision (R3)", async () => {
		const decided = await decide(USER_ID, CHANNEL_PUBLIC);

		expect(decided.permissions.bitfield).not.toContain("e");
		expect(BigInt(decided.permissions.bitfield) & BigInt(HIGH_BITS)).toBe(BigInt(HIGH_BITS));
		expect(decided.permissions.has("use-external-apps")).toBe(true);
		expect(decided.permissions.has("pin-messages")).toBe(true);
		// The proof the column itself is honest text: the stored role reads back as the same decimal value.
		const stored = await roles.findRolePermissions(GUILD_ID, [ROLE_BACKEND]);
		expect(stored[0]?.permissionsBitfield).toBe(BACKEND_BITS);
	});

	it("applies the role stage on real rows, where an allow beats another role's deny (R7)", async () => {
		const publicChannel = await decide(USER_ID, CHANNEL_PUBLIC);

		// backend allows mentions and denies send; ops allows send. Inside the stage: deny cleared, then allow.
		expect(publicChannel.permissions.has("mention-everyone")).toBe(true);
		expect(publicChannel.permissions.has("send-messages")).toBe(true);
		// The base survives because no stage denied it.
		expect(publicChannel.permissions.has("view-channel")).toBe(true);
	});

	it("applies the member overwrite after the role stage on real rows (R7's example)", async () => {
		const decided = await decide(USER_ID, CHANNEL_PRIVATE);

		expect(decided.permissions.has("view-channel")).toBe(true);
		expect(decided.permissions.has("read-message-history")).toBe(false);
	});

	it("evaluates a thread over its parent's set, in the fixed order, from real rows (Contracts)", async () => {
		// The bot holds no roles, so its base is @everyone's bits: view and history. The parent's @everyone row
		// denies history and the thread's own stored set puts it back — one deny at the parent level, one allow
		// at the thread level, which only the order Contracts fixes produces.
		await channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [
				{ targetId: USER_ID, targetType: "member", allowBitfield: "0", denyBitfield: HISTORY },
				{ targetId: GUILD_ID, targetType: "role", allowBitfield: "0", denyBitfield: HISTORY }
			]
		});

		const decided = await decide(BOT_USER_ID, THREAD_UNDER_PRIVATE);

		expect(decided.status).toBe("evaluated");
		expect(decided.overwriteLevels).toEqual([CHANNEL_PRIVATE, THREAD_UNDER_PRIVATE]);
		expect(decided.permissions.has("view-channel")).toBe(true);
		expect(decided.permissions.has("read-message-history")).toBe(true);

		// With the thread's own rows gone, the parent's deny is all that is left to apply, and it survives.
		await channels.replaceChannelOverwrites({ guildId: GUILD_ID, channelId: THREAD_UNDER_PRIVATE, overwrites: [] });
		const bare = await decide(BOT_USER_ID, THREAD_UNDER_PRIVATE);
		expect(bare.permissions.has("read-message-history")).toBe(false);
	});

	it("admits a private thread only through the stored membership edge (R8)", async () => {
		const admitted = await decide(USER_ID, PRIVATE_THREAD);
		expect(admitted.permissions.has("view-channel")).toBe(true);

		await threadMemberships.removeThreadMembership({
			guildId: GUILD_ID,
			threadId: PRIVATE_THREAD,
			userId: USER_ID
		});
		const revoked = await decide(USER_ID, PRIVATE_THREAD);

		expect(revoked.status).toBe("empty");
		expect(revoked.reason).toBe("private-thread-not-admitted");
		expect(revoked.permissions.bitfield).toBe("0");
	});

	it("fails closed on a channel the registry does not hold, without an error (R6)", async () => {
		const decided = await decide(USER_ID, UNKNOWN_CHANNEL);

		expect(decided.status).toBe("empty");
		expect(decided.reason).toBe("channel-not-registered");
		expect(logger.linesAt("error")).toEqual([]);
	});

	it("answers the empty set for a user with no Membership, and for every channel after one ends (R4)", async () => {
		expect((await decide(OTHER_USER_ID, CHANNEL_PUBLIC)).status).toBe("empty");

		await members.deleteMembershipAndDependents(GUILD_ID, USER_ID);
		const afterEnd = await decide(USER_ID, CHANNEL_PUBLIC);

		expect(afterEnd.reason).toBe("membership-not-registered");
		expect(afterEnd.permissions.bitfield).toBe("0");
	});

	it("grants everything to an administrator and skips the overwrite stages (Contracts stage 2)", async () => {
		await roles.upsertRoles([role(ROLE_OPS, ADMINISTRATOR)]);

		const decided = await decide(USER_ID, VOICE_CHANNEL);

		expect(decided.administratorBypass).toBe(true);
		expect(decided.overwriteLevels).toEqual([]);
		// #public's role rows deny send and #voice denies view; neither is consulted.
		expect(decided.permissions.has("send-messages")).toBe(true);
		expect(decided.permissions.has("view-channel")).toBe(true);
	});

	it("reflects a role removal on the next decision, cascade and all (R12; the revocation-role-removed shape)", async () => {
		const before = await decide(USER_ID, CHANNEL_PUBLIC);
		expect(before.permissions.has("send-messages")).toBe(true);

		await deleteRole.execute({ guildId: GUILD_ID, roleId: ROLE_BACKEND });
		const after = await decide(USER_ID, CHANNEL_PUBLIC);

		// backend's base bits are gone, and so is the overwrite row that named it: no stale grant survives (R3).
		expect(after.permissions.has("use-external-apps")).toBe(false);
		expect(after.permissions.has("mention-everyone")).toBe(false);
		expect(after.permissions.has("send-messages")).toBe(true); // ops still allows it
		const stored = await channels.findChannelOverwrites(GUILD_ID, CHANNEL_PUBLIC);
		expect(stored.map((entry) => entry.targetId)).toEqual([ROLE_OPS]);
	});

	it("lists the accessible channels in one bounded pass, carrying the second fact (query R2)", async () => {
		const listed = await listForUser.execute({ userId: USER_ID });

		expect(listed.evaluatedChannelCount).toBe(5);
		expect(listed.channels.map((entry) => entry.channelId).sort()).toEqual(
			[CHANNEL_PUBLIC, CHANNEL_PRIVATE, THREAD_UNDER_PRIVATE, PRIVATE_THREAD].sort()
		);
		// The voice channel's @everyone row denies view; the private thread is admitted by its edge.
		expect(listed.channels.find((entry) => entry.channelId === VOICE_CHANNEL)).toBeUndefined();
		expect(listed.channels.find((entry) => entry.channelId === CHANNEL_PRIVATE)?.canReadMessageHistory).toBe(false);
		expect(listed.channels.find((entry) => entry.channelId === THREAD_UNDER_PRIVATE)?.canReadMessageHistory).toBe(
			true
		);
	});

	it("reports the ingestible set with registry presence and bot visibility as distinct facts (ingestion R2)", async () => {
		const listed = await listIngestible.execute({ botUserId: BOT_USER_ID });

		// The bot holds no roles: @everyone's bits plus the channel rows decide, and voice is not text-capable.
		expect(listed.registeredTextCapableCount).toBe(4);
		expect(listed.channels.map((entry) => entry.channelId).sort()).toEqual(
			[CHANNEL_PUBLIC, CHANNEL_PRIVATE, THREAD_UNDER_PRIVATE].sort()
		);
		// The private thread is registered and text-capable but the bot has no edge: a distinct fact, not silence.
		expect(listed.botCannotViewChannelIds).toEqual([PRIVATE_THREAD]);
		expect(listed.botMembershipRegistered).toBe(true);

		await members.deleteMembershipAndDependents(GUILD_ID, BOT_USER_ID);
		const withoutBot = await listIngestible.execute({ botUserId: BOT_USER_ID });

		expect(withoutBot.channels).toEqual([]);
		expect(withoutBot.botMembershipRegistered).toBe(false);
		expect(withoutBot.refusalReasons).toEqual(["membership-not-registered"]);
	});

	it("writes nothing while it decides, in any form the contract allows (R13, R12)", async () => {
		const before = {
			guild: await database.countRows("guild"),
			role: await database.countRows("guild_role"),
			membership: await database.countRows("guild_membership"),
			assignment: await database.countRows("guild_membership_role"),
			channel: await database.countRows("channel"),
			overwrite: await database.countRows("channel_permission_overwrite"),
			thread: await database.countRows("thread_membership")
		};

		for (const channelId of [
			CHANNEL_PUBLIC,
			CHANNEL_PRIVATE,
			THREAD_UNDER_PRIVATE,
			PRIVATE_THREAD,
			VOICE_CHANNEL
		]) {
			await decide(USER_ID, channelId);
			await decide(BOT_USER_ID, channelId);
		}
		await listForUser.execute({ userId: USER_ID });
		await listForUser.execute({ userId: USER_ID });
		await listIngestible.execute({ botUserId: BOT_USER_ID });

		expect(before).toEqual({
			guild: await database.countRows("guild"),
			role: await database.countRows("guild_role"),
			membership: await database.countRows("guild_membership"),
			assignment: await database.countRows("guild_membership_role"),
			channel: await database.countRows("channel"),
			overwrite: await database.countRows("channel_permission_overwrite"),
			thread: await database.countRows("thread_membership")
		});
	});

	it("never tears a decision when a concurrent writer replaces the state (Contracts: one consistent snapshot)", async () => {
		/**
		 * The invariant a torn read would break: `backend`'s base bits and the #public overwrite that names the
		 * same role are written by one transaction, so every snapshot must show one side of a pair — either the
		 * old bitfield with the old overwrite or the new one with the new one. Reading the two sets on separate
		 * snapshots is what lets a decision mix them, and this loop drives that window hard: a writer flipping
		 * both columns in one transaction while the reader decides in the middle of it.
		 */
		const OLD_BASE = BigInt(SEND);
		const OLD_ALLOW = BigInt(MENTION);
		const NEW_BASE = BigInt(SEND) | BigInt(MENTION);
		const NEW_ALLOW = 0n;

		let stop = false;
		let generations = 0;
		const writer = (async () => {
			while (!stop) {
				const toNew = generations % 2 === 0;
				await database.pool.query("BEGIN");
				try {
					await database.pool.query(
						"UPDATE guild_role SET permissions_bitfield = $3 WHERE guild_id = $1 AND role_id = $2",
						[GUILD_ID, ROLE_BACKEND, (toNew ? NEW_BASE : OLD_BASE).toString()]
					);
					await database.pool.query(
						"UPDATE channel_permission_overwrite SET allow_bitfield = $3 WHERE guild_id = $1 AND channel_id = $2 AND overwrite_target_id = $4",
						[GUILD_ID, CHANNEL_PUBLIC, (toNew ? NEW_ALLOW : OLD_ALLOW).toString(), ROLE_BACKEND]
					);
					await database.pool.query("COMMIT");
					generations += 1;
				} catch (failure) {
					await database.pool.query("ROLLBACK");
					throw failure;
				}
			}
		})();

		const observations: string[] = [];
		for (let round = 0; round < 40; round += 1) {
			const snapshot = await snapshots.loadSnapshot({
				guildId: GUILD_ID,
				userId: USER_ID,
				channelId: CHANNEL_PUBLIC
			});
			const base = BigInt(
				snapshot.rolePermissions.find((entry) => entry.roleId === ROLE_BACKEND)?.permissionsBitfield ?? "0"
			);
			const allow = BigInt(
				snapshot.overwriteSets
					.find((entry) => entry.channelId === CHANNEL_PUBLIC)
					?.overwrites.find((entry) => entry.targetId === ROLE_BACKEND)?.allowBitfield ?? "0"
			);
			const consistent = (base === OLD_BASE && allow === OLD_ALLOW) || (base === NEW_BASE && allow === NEW_ALLOW);
			observations.push(`${base}/${allow}`);
			expect(consistent, `torn snapshot in ${observations[round]}`).toBe(true);
		}
		stop = true;
		await writer;

		// The loop must actually have observed both states, or it proved nothing about concurrency.
		expect(new Set(observations).size).toBeGreaterThan(1);
		expect(generations).toBeGreaterThan(1);
	});

	it("runs its reads at the isolation level it pins, on the real driver", async () => {
		// The pool's own default first, so the adapter's pin is a change and not the server's setting already.
		const { rows } = await database.pool.query<{ readonly transaction_isolation: string }>(
			"SELECT current_setting('transaction_isolation') AS transaction_isolation"
		);
		expect(rows[0]?.transaction_isolation).toBe("read committed");

		// One transaction, pinned before the reads, verified from inside that same transaction.
		const client = await database.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
			const checked = await client.query<{ readonly transaction_isolation: string }>(
				"SELECT current_setting('transaction_isolation') AS transaction_isolation"
			);
			expect(checked.rows[0]?.transaction_isolation).toBe("repeatable read");
			await client.query("COMMIT");
		} finally {
			client.release();
		}
	});
});
