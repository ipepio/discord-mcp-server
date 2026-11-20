import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";
import type { SqlClientSession, SqlExecutor } from "../../src/features/guild-state/repositories/sql-executor.js";
import { PostgresGuildRegistryRepository } from "../../src/features/guild-state/repositories/postgres-guild-registry.repository.js";
import { PostgresRoleRegistryRepository } from "../../src/features/guild-state/repositories/postgres-role-registry.repository.js";
import { PostgresMembershipRegistryRepository } from "../../src/features/guild-state/repositories/postgres-membership-registry.repository.js";
import { PostgresChannelRegistryRepository } from "../../src/features/guild-state/repositories/postgres-channel-registry.repository.js";
import { PostgresThreadMembershipRegistryRepository } from "../../src/features/guild-state/repositories/postgres-thread-membership-registry.repository.js";
import { UpsertRoleCommand } from "../../src/features/guild-state/commands/upsert-role.command.js";
import { DeleteRoleCommand } from "../../src/features/guild-state/commands/delete-role.command.js";
import { ApplyMemberUpdateCommand } from "../../src/features/guild-state/commands/apply-member-update.command.js";
import { EndMembershipCommand } from "../../src/features/guild-state/commands/end-membership.command.js";
import { createGuildStateConfig } from "../../src/features/guild-state/config/guild-state-config.interface.js";
import type { DiscordIdentifier } from "../../src/features/guild-state/models/domain/discord-identifier.js";
import type { RegistryChannel, RegistryRole } from "../../src/features/guild-state/models/domain/registry-records.js";
import { RecordingLogger } from "../features/guild-state/fakes/recording-logger.js";

/**
 * T3 and T4 evidence — role and membership event application against a real PostgreSQL.
 *
 * `tests/integration/guild-state-registry.integration.test.ts` proves the repositories' statements; the doubles in
 * `tests/features/guild-state/` prove the commands' decisions. This file is where the two meet, because the claims
 * that matter here exist only at that seam:
 *
 * - **R3, replacement.** A role event leaves the row carrying the payload's own text — no merged bitfield, and no
 *   precision lost on a value past the safe-integer range. The `text` column is what makes that provable, and only
 *   a real database proves the column kept it.
 * - **R3, deletion.** The cascade's dependents are gone from the tables, not merely hidden from a projection, and
 *   the sweep is typed: an overwrite targeting a member is not the overwrite targeting the role.
 * - **R5 with the schema's bound — the tension pinned in `odd/tasks/guild-state.md` L3(1).**
 *   `guild_membership_role` references `guild_role`, so a member payload naming a role the registry has never seen
 *   cannot store that id. The command stores the part of the set the foreign key accepts, reports the rest, and the
 *   set converges once the role arrives. The foreign key itself stays in place, asserted below by the raw insert
 *   still failing with `23503`.
 * - **R4, one transaction — and L3(2).** Ending a Membership is one transaction, and it also sweeps the
 *   member-targeted overwrites. The failure injected here lands on the *last* statement of the cascade, so a
 *   partially removed member would be visible as surviving rows.
 * - **R9, replay.** Applying the same event twice leaves identical rows and opens exactly one write transaction.
 *
 * Without `TEST_DATABASE_URL` this suite is skipped and the harness prints the UNAVAILABLE banner; skipped is
 * missing evidence, never a pass.
 */

const GUILD_ID = "160000000000000001";
const OTHER_GUILD_ID = "160000000000000999";
const EVERYONE_ROLE_ID = GUILD_ID;
const ROLE_BACKEND = "160000000000000010";
const ROLE_OPS = "160000000000000011";
const ROLE_UNKNOWN = "160000000000000012";
const USER_ONE = "160000000000000101";
const USER_TWO = "160000000000000102";
const USER_BOT = "160000000000000103";
const USER_STRANGER = "160000000000000104";
const CHANNEL_PRIVATE = "160000000000000201";
const CHANNEL_PUBLIC = "160000000000000202";
const THREAD_UNDER_PRIVATE = "160000000000000203";

const VIEW_CHANNEL = "1024";
const READ_MESSAGE_HISTORY = "65536";
/** Larger than `Number.MAX_SAFE_INTEGER`: anything that coerces it changes the value (R3). */
const UNSAFE_BITFIELD = "9007199254740993";

/** The statement that removes the Membership row: the last one of R4's cascade. */
const FINAL_MEMBERSHIP_DELETE = /DELETE FROM guild_membership\b/;

function roleRow(roleId: DiscordIdentifier, permissionsBitfield: string, position: number): RegistryRole {
	return { guildId: GUILD_ID, roleId, roleName: `role-${roleId}`, permissionsBitfield, position };
}

function channelRow(
	channelId: DiscordIdentifier,
	channelType: RegistryChannel["channelType"],
	parentChannelId: DiscordIdentifier | null,
	position: number
): RegistryChannel {
	return {
		guildId: GUILD_ID,
		channelId,
		channelType,
		name: `channel-${channelId}`,
		position,
		parentChannelId
	};
}

/**
 * An executor that counts the transactions and statements it is asked for, and can fail one statement from the
 * inside. It is the only way to show a cascade is atomic rather than merely sequential, and that one event is one
 * transaction rather than a sequence of them.
 */
class ObservingExecutor implements SqlExecutor {
	public transactions = 0;

	public statements = 0;

	private readonly failOn: RegExp | undefined;

	public constructor(
		private readonly inner: SqlExecutor,
		failOn?: RegExp
	) {
		this.failOn = failOn;
	}

	public readonly query = async <Row = Record<string, unknown>>(
		statement: string,
		parameters?: readonly unknown[]
	): Promise<{ readonly rows: readonly Row[] }> => {
		this.statements += 1;
		return this.inner.query<Row>(statement, parameters);
	};

	public readonly transaction = async <Result>(
		work: (session: SqlClientSession) => Promise<Result>
	): Promise<Result> => {
		this.transactions += 1;
		return this.inner.transaction((session) =>
			work({
				query: async <Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) => {
					this.statements += 1;
					// The failure replaces a statement the cascade really runs, at the moment that would leave a
					// half-removed resource: after the dependents went, before the row named by the event.
					if (this.failOn !== undefined && this.failOn.test(statement)) {
						throw new Error(`injected mid-cascade failure on statement ${this.statements}`);
					}
					return session.query<Row>(statement, parameters);
				},
				release: () => session.release()
			})
		);
	};
}

/** The registry one case runs against: the five repositories and the four event-application commands on them. */
interface Subject {
	readonly database: IsolatedTestDatabase;
	readonly logger: RecordingLogger;
	readonly roles: PostgresRoleRegistryRepository;
	readonly members: PostgresMembershipRegistryRepository;
	readonly channels: PostgresChannelRegistryRepository;
	readonly threadMemberships: PostgresThreadMembershipRegistryRepository;
	readonly upsertRole: UpsertRoleCommand;
	readonly deleteRole: DeleteRoleCommand;
	readonly applyMemberUpdate: ApplyMemberUpdateCommand;
	readonly endMembership: EndMembershipCommand;
}

describe.skipIf(!HAS_TEST_DATABASE)("guild-state event application (real PostgreSQL)", () => {
	let database: IsolatedTestDatabase;
	let subject: Subject;

	beforeAll(async () => {
		database = await openIsolatedTestDatabase("guild_state_events");
	}, 180_000);

	afterAll(async () => {
		// Best effort: a failed case must not leak a database into the shared server.
		await database?.close();
	});

	beforeEach(async () => {
		await database.resetRegistry();
		const logger = new RecordingLogger();
		const executor = database.executor;
		const roles = new PostgresRoleRegistryRepository({ executor, writeBatchSize: 200 });
		const members = new PostgresMembershipRegistryRepository({ executor, writeBatchSize: 200 });
		const channels = new PostgresChannelRegistryRepository({ executor, writeBatchSize: 200 });
		const threadMemberships = new PostgresThreadMembershipRegistryRepository({ executor });
		const config = createGuildStateConfig({ guildId: GUILD_ID });

		// The parts every case needs, stored through the T1 repositories: one Guild, three roles (`@everyone`
		// included) and three channels (two top-level, one thread). Nothing else exists before a case runs.
		await new PostgresGuildRegistryRepository({ executor }).upsertGuild({
			guildId: GUILD_ID,
			guildName: "Example Guild HQ"
		});
		await roles.upsertRoles([
			roleRow(EVERYONE_ROLE_ID, "0", 0),
			roleRow(ROLE_BACKEND, VIEW_CHANNEL, 1),
			roleRow(ROLE_OPS, READ_MESSAGE_HISTORY, 2)
		]);
		await channels.upsertChannels([
			channelRow(CHANNEL_PRIVATE, "guild-text", null, 0),
			channelRow(CHANNEL_PUBLIC, "guild-text", null, 1),
			channelRow(THREAD_UNDER_PRIVATE, "private-thread", CHANNEL_PRIVATE, 2)
		]);

		subject = {
			database,
			logger,
			roles,
			members,
			channels,
			threadMemberships,
			upsertRole: new UpsertRoleCommand({ config, roleRegistry: roles, logger }),
			deleteRole: new DeleteRoleCommand({ config, roleRegistry: roles, logger }),
			applyMemberUpdate: new ApplyMemberUpdateCommand({
				config,
				roleRegistry: roles,
				membershipRegistry: members,
				logger
			}),
			endMembership: new EndMembershipCommand({ config, membershipRegistry: members, logger })
		};
	});

	/* ------------------------------------------- T3: the role registry ------------------------------------ */

	it("replaces a stored role wholesale, keeping the payload's text and losing nothing to coercion (R3)", async () => {
		const outcome = await subject.upsertRole.execute({
			guildId: GUILD_ID,
			roleId: ROLE_BACKEND,
			roleName: "renamed",
			permissionsBitfield: UNSAFE_BITFIELD,
			position: 9
		});

		expect(outcome).toMatchObject({ status: "applied", created: false, rowsWritten: 1 });
		// `findRoles` orders by the stored position, which is why the renamed role now reads back last: the
		// position moved with the rest of the row instead of being merged into the old one.
		expect(await subject.roles.findRoles(GUILD_ID)).toEqual([
			roleRow(EVERYONE_ROLE_ID, "0", 0),
			roleRow(ROLE_OPS, READ_MESSAGE_HISTORY, 2),
			// The previous `1024` is gone rather than OR-ed with the new value; name and position moved with it.
			{
				guildId: GUILD_ID,
				roleId: ROLE_BACKEND,
				roleName: "renamed",
				permissionsBitfield: UNSAFE_BITFIELD,
				position: 9
			}
		]);
	});

	it("stores a role event for an unknown id as a new row, and leaves it identical on replay (R10, R9)", async () => {
		const event = {
			guildId: GUILD_ID,
			roleId: ROLE_UNKNOWN,
			roleName: "late-role",
			permissionsBitfield: VIEW_CHANNEL,
			position: 3
		};

		expect(await subject.upsertRole.execute(event)).toMatchObject({ status: "applied", created: true });
		const afterFirst = await subject.roles.findRoles(GUILD_ID);
		expect(afterFirst.map((entry) => entry.roleId)).toContain(ROLE_UNKNOWN);

		expect(await subject.upsertRole.execute(event)).toMatchObject({ status: "applied", created: false });

		expect(await subject.roles.findRoles(GUILD_ID)).toEqual(afterFirst);
		expect(await database.countRows("guild_role")).toBe(4);
	});

	it("completes a field the payload omitted from the stored row and stores the rest as sent (R10)", async () => {
		await subject.upsertRole.execute({
			guildId: GUILD_ID,
			roleId: ROLE_BACKEND,
			permissionsBitfield: READ_MESSAGE_HISTORY
		});

		expect(await subject.roles.findRoles(GUILD_ID)).toContainEqual({
			guildId: GUILD_ID,
			roleId: ROLE_BACKEND,
			// Neither blanked nor invented: this is the row Discord already described.
			roleName: `role-${ROLE_BACKEND}`,
			permissionsBitfield: READ_MESSAGE_HISTORY,
			position: 1
		});
	});

	it("stores nothing for an incomplete description of a role the registry has never seen (R3, R11 path)", async () => {
		const outcome = await subject.upsertRole.execute({ guildId: GUILD_ID, roleId: ROLE_UNKNOWN });

		expect(outcome).toMatchObject({
			status: "refused",
			reason: "incomplete-role-description",
			missingFields: ["roleName", "permissionsBitfield"]
		});
		expect(await database.countRows("guild_role")).toBe(3);
		expect(subject.logger.linesAt("warn").at(-1)?.fields).toMatchObject({ roleId: ROLE_UNKNOWN });
	});

	it("deleting a role removes its assignments and its overwrites from the tables and leaves the rest (R3)", async () => {
		await subject.members.upsertMemberships([
			{ guildId: GUILD_ID, userId: USER_ONE, roleIds: [ROLE_BACKEND, ROLE_OPS] },
			{ guildId: GUILD_ID, userId: USER_TWO, roleIds: [ROLE_BACKEND] }
		]);
		await subject.channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [
				{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" },
				{ targetId: ROLE_OPS, targetType: "role", allowBitfield: "0", denyBitfield: "0" }
			]
		});
		await subject.channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PUBLIC,
			// A member-targeted overwrite carrying the deleted role's own id: the typed sweep must leave it (R3).
			overwrites: [
				{ targetId: ROLE_BACKEND, targetType: "member", allowBitfield: "0", denyBitfield: VIEW_CHANNEL }
			]
		});

		const outcome = await subject.deleteRole.execute({ guildId: GUILD_ID, roleId: ROLE_BACKEND });

		expect(outcome).toMatchObject({
			status: "applied",
			roleId: ROLE_BACKEND,
			roleRemoved: true,
			membershipLinksRemoved: 2,
			overwritesRemoved: 1
		});
		expect(await database.countRows("guild_role")).toBe(2);
		expect(await database.countRows("guild_membership_role")).toBe(1);
		expect(await database.countRows("channel_permission_overwrite")).toBe(2);
		expect((await subject.members.findMembership(GUILD_ID, USER_ONE))?.roleIds).toEqual([ROLE_OPS]);
		expect((await subject.members.findMembership(GUILD_ID, USER_TWO))?.roleIds).toEqual([]);
		expect(await subject.channels.findChannelOverwrites(GUILD_ID, CHANNEL_PUBLIC)).toEqual([
			{ targetId: ROLE_BACKEND, targetType: "member", allowBitfield: "0", denyBitfield: VIEW_CHANNEL }
		]);

		// R9: the same deletion again is a counted no-op, not an error.
		expect(await subject.deleteRole.execute({ guildId: GUILD_ID, roleId: ROLE_BACKEND })).toMatchObject({
			status: "applied",
			roleRemoved: false,
			membershipLinksRemoved: 0,
			overwritesRemoved: 0
		});
	});

	it("deletes the role with its dependents in one transaction and rolls the cascade back on failure (R3)", async () => {
		await subject.members.upsertMemberships([{ guildId: GUILD_ID, userId: USER_ONE, roleIds: [ROLE_BACKEND] }]);
		await subject.channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }]
		});

		const observer = new ObservingExecutor(database.executor, /DELETE FROM guild_role\b/);
		const composed = new DeleteRoleCommand({
			config: createGuildStateConfig({ guildId: GUILD_ID }),
			roleRegistry: new PostgresRoleRegistryRepository({ executor: observer, writeBatchSize: 200 }),
			logger: subject.logger
		});

		await expect(composed.execute({ guildId: GUILD_ID, roleId: ROLE_BACKEND })).rejects.toThrow(/injected/);

		// One transaction, and nothing at all was removed by the statements that ran inside it.
		expect(observer.transactions).toBe(1);
		expect(await database.countRows("guild_role")).toBe(3);
		expect(await database.countRows("guild_membership_role")).toBe(1);
		expect(await database.countRows("channel_permission_overwrite")).toBe(1);
	});

	/* --------------------------------- T4: membership and its role set ------------------------------------ */

	it("creates a membership on a join and replaces the complete set on the next member event (R4, R5)", async () => {
		expect(
			await subject.applyMemberUpdate.execute({
				guildId: GUILD_ID,
				userId: USER_ONE,
				roleIds: [ROLE_BACKEND, ROLE_OPS]
			})
		).toMatchObject({ status: "applied", roleIdsStored: [ROLE_BACKEND, ROLE_OPS], deferredRoleIds: [] });
		expect((await subject.members.findMembership(GUILD_ID, USER_ONE))?.roleIds).toEqual([ROLE_BACKEND, ROLE_OPS]);

		// The dropped role must disappear: a merge would leave two rows, and R5 says the set is the payload's.
		expect(
			await subject.applyMemberUpdate.execute({ guildId: GUILD_ID, userId: USER_ONE, roleIds: [ROLE_OPS] })
		).toMatchObject({ roleIdsStored: [ROLE_OPS] });
		expect((await subject.members.findMembership(GUILD_ID, USER_ONE))?.roleIds).toEqual([ROLE_OPS]);
		expect(await database.countRows("guild_membership_role")).toBe(1);
	});

	it("stores an empty role set as a member holding nothing, distinct from no membership at all (R5)", async () => {
		await subject.applyMemberUpdate.execute({ guildId: GUILD_ID, userId: USER_ONE, roleIds: [ROLE_BACKEND] });
		await subject.applyMemberUpdate.execute({ guildId: GUILD_ID, userId: USER_TWO, roleIds: [] });

		expect(
			await subject.applyMemberUpdate.execute({ guildId: GUILD_ID, userId: USER_ONE, roleIds: [] })
		).toMatchObject({ roleIdsStored: [] });

		expect((await subject.members.findMembership(GUILD_ID, USER_ONE))?.roleIds).toEqual([]);
		// R5's boundary: this member exists and holds nothing; the stranger has no row to hold nothing in.
		expect(await subject.members.findMembership(GUILD_ID, USER_STRANGER)).toBeNull();
		expect(await database.countRows("guild_membership")).toBe(2);
	});

	it("leaves other members, role definitions and overwrites untouched when one set changes (R5)", async () => {
		await subject.members.upsertMemberships([
			{ guildId: GUILD_ID, userId: USER_ONE, roleIds: [ROLE_BACKEND] },
			{ guildId: GUILD_ID, userId: USER_TWO, roleIds: [ROLE_BACKEND, ROLE_OPS] }
		]);
		await subject.channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }]
		});
		const rolesBefore = await subject.roles.findRoles(GUILD_ID);

		await subject.applyMemberUpdate.execute({ guildId: GUILD_ID, userId: USER_ONE, roleIds: [ROLE_OPS] });

		expect((await subject.members.findMembership(GUILD_ID, USER_TWO))?.roleIds).toEqual([ROLE_BACKEND, ROLE_OPS]);
		expect(await subject.roles.findRoles(GUILD_ID)).toEqual(rolesBefore);
		expect(await subject.channels.findChannelOverwrites(GUILD_ID, CHANNEL_PRIVATE)).toHaveLength(1);
	});

	it("stores what the foreign key allows for an unknown role id and converges when the role arrives (R5, R10, L3)", async () => {
		const set = { guildId: GUILD_ID, userId: USER_ONE, roleIds: [ROLE_BACKEND, ROLE_UNKNOWN] };

		const first = await subject.applyMemberUpdate.execute(set);
		expect(first).toMatchObject({
			status: "applied",
			roleIdsStored: [ROLE_BACKEND],
			deferredRoleIds: [ROLE_UNKNOWN]
		});
		expect((await subject.members.findMembership(GUILD_ID, USER_ONE))?.roleIds).toEqual([ROLE_BACKEND]);
		expect(await database.countRows("guild_membership")).toBe(1);
		expect(subject.logger.linesAt("warn").at(-1)?.fields).toMatchObject({ deferredRoleIds: [ROLE_UNKNOWN] });

		// The foreign key is still the foreign key: an unresolvable grant stays impossible to store (R3).
		await expect(
			database.executor.query(
				`INSERT INTO guild_membership_role (guild_id, user_id, role_id) VALUES ($1, $2, $3)`,
				[GUILD_ID, USER_ONE, ROLE_UNKNOWN]
			)
		).rejects.toMatchObject({ code: "23503" });

		// The role definition arrives; the next complete payload of the same set now stores the whole of it.
		await subject.upsertRole.execute({
			guildId: GUILD_ID,
			roleId: ROLE_UNKNOWN,
			roleName: "late-role",
			permissionsBitfield: VIEW_CHANNEL,
			position: 3
		});
		const converged = await subject.applyMemberUpdate.execute(set);

		expect(converged).toMatchObject({ roleIdsStored: [ROLE_BACKEND, ROLE_UNKNOWN], deferredRoleIds: [] });
		expect((await subject.members.findMembership(GUILD_ID, USER_ONE))?.roleIds).toEqual([
			ROLE_BACKEND,
			ROLE_UNKNOWN
		]);
	});

	it("stores a bot or webhook member exactly like any other member (R4's boundary)", async () => {
		await subject.applyMemberUpdate.execute({ guildId: GUILD_ID, userId: USER_BOT, roleIds: [ROLE_BACKEND] });

		expect(await subject.members.findMembership(GUILD_ID, USER_BOT)).toEqual({
			guildId: GUILD_ID,
			userId: USER_BOT,
			roleIds: [ROLE_BACKEND]
		});
		// Only the natural key and the role set reach a row: the registry is id-only (R14, O2).
		expect(subject.logger.transcript()).not.toContain("bot");
	});

	it("replays a member event to identical rows and one write transaction per delivery (R9)", async () => {
		const observer = new ObservingExecutor(database.executor);
		const composed = new ApplyMemberUpdateCommand({
			config: createGuildStateConfig({ guildId: GUILD_ID }),
			roleRegistry: subject.roles,
			membershipRegistry: new PostgresMembershipRegistryRepository({ executor: observer, writeBatchSize: 200 }),
			logger: subject.logger
		});
		const event = { guildId: GUILD_ID, userId: USER_ONE, roleIds: [ROLE_BACKEND, ROLE_OPS] };

		await composed.execute(event);
		const afterFirst = await subject.members.findMembership(GUILD_ID, USER_ONE);
		const transactionsAfterFirst = observer.transactions;
		await composed.execute(event);

		expect(await subject.members.findMembership(GUILD_ID, USER_ONE)).toEqual(afterFirst);
		expect(await database.countRows("guild_membership")).toBe(1);
		expect(await database.countRows("guild_membership_role")).toBe(2);
		// One transaction per event: the identity row, the sweep and the inserts of one member never spread wider.
		expect(observer.transactions).toBe(transactionsAfterFirst + 1);
	});

	it("ends a membership with its set, thread edges and member overwrites in one transaction (R4, L3)", async () => {
		await subject.members.upsertMemberships([
			{ guildId: GUILD_ID, userId: USER_ONE, roleIds: [ROLE_BACKEND] },
			{ guildId: GUILD_ID, userId: USER_TWO, roleIds: [ROLE_BACKEND] }
		]);
		await subject.threadMemberships.addThreadMembership({
			guildId: GUILD_ID,
			threadId: THREAD_UNDER_PRIVATE,
			userId: USER_ONE
		});
		await subject.channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [
				{ targetId: USER_ONE, targetType: "member", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" },
				{ targetId: USER_TWO, targetType: "member", allowBitfield: "0", denyBitfield: "0" },
				{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }
			]
		});

		const outcome = await subject.endMembership.execute({ guildId: GUILD_ID, userId: USER_ONE });

		expect(outcome).toMatchObject({
			status: "applied",
			userId: USER_ONE,
			membershipRemoved: true,
			roleLinksRemoved: 1,
			// L3(2): R4's text does not name them, and the cascade sweeps them anyway — a member who left keeps no
			// grant of their own anywhere in the registry.
			overwritesRemoved: 1,
			threadMembershipsRemoved: 1
		});
		expect(await subject.members.findMembership(GUILD_ID, USER_ONE)).toBeNull();
		expect(await database.countRows("guild_membership")).toBe(1);
		expect(await database.countRows("guild_membership_role")).toBe(1);
		expect(await database.countRows("thread_membership")).toBe(0);
		expect(await subject.channels.findChannelOverwrites(GUILD_ID, CHANNEL_PRIVATE)).toHaveLength(2);
		expect((await subject.members.findMembership(GUILD_ID, USER_TWO))?.roleIds).toEqual([ROLE_BACKEND]);

		// R4's error case: a removal for an id the registry never held is a counted no-op.
		expect(await subject.endMembership.execute({ guildId: GUILD_ID, userId: USER_STRANGER })).toMatchObject({
			status: "applied",
			membershipRemoved: false,
			roleLinksRemoved: 0,
			overwritesRemoved: 0,
			threadMembershipsRemoved: 0
		});
		expect(await database.countRows("guild_membership")).toBe(1);
	});

	it("rolls a membership end back as one unit when the cascade's last statement fails (R4 atomicity)", async () => {
		await subject.members.upsertMemberships([{ guildId: GUILD_ID, userId: USER_ONE, roleIds: [ROLE_BACKEND] }]);
		await subject.threadMemberships.addThreadMembership({
			guildId: GUILD_ID,
			threadId: THREAD_UNDER_PRIVATE,
			userId: USER_ONE
		});
		await subject.channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [{ targetId: USER_ONE, targetType: "member", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }]
		});

		const observer = new ObservingExecutor(database.executor, FINAL_MEMBERSHIP_DELETE);
		const composed = new EndMembershipCommand({
			config: createGuildStateConfig({ guildId: GUILD_ID }),
			membershipRegistry: new PostgresMembershipRegistryRepository({ executor: observer, writeBatchSize: 200 }),
			logger: subject.logger
		});

		await expect(composed.execute({ guildId: GUILD_ID, userId: USER_ONE })).rejects.toThrow(/injected/);

		expect(observer.transactions).toBe(1);
		// Every dependent row is still there: the failure did not leave a half-removed member behind.
		expect((await subject.members.findMembership(GUILD_ID, USER_ONE))?.roleIds).toEqual([ROLE_BACKEND]);
		expect(await database.countRows("thread_membership")).toBe(1);
		expect(await database.countRows("channel_permission_overwrite")).toBe(1);
	});

	/* ------------------------------------- R1 and R14 at the edge ------------------------------------------ */

	it("drops events for another Guild without writing a row (R1)", async () => {
		await subject.members.upsertMemberships([{ guildId: GUILD_ID, userId: USER_ONE, roleIds: [ROLE_BACKEND] }]);

		expect(
			await subject.upsertRole.execute({
				guildId: OTHER_GUILD_ID,
				roleId: ROLE_UNKNOWN,
				roleName: "foreign-role",
				permissionsBitfield: VIEW_CHANNEL,
				position: 1
			})
		).toMatchObject({ status: "dropped", reason: "foreign-guild" });
		expect(
			await subject.applyMemberUpdate.execute({
				guildId: OTHER_GUILD_ID,
				userId: USER_STRANGER,
				roleIds: [ROLE_BACKEND]
			})
		).toMatchObject({ status: "dropped", reason: "foreign-guild" });
		expect(await subject.deleteRole.execute({ guildId: OTHER_GUILD_ID, roleId: ROLE_BACKEND })).toMatchObject({
			status: "dropped",
			reason: "foreign-guild"
		});
		expect(await subject.endMembership.execute({ guildId: OTHER_GUILD_ID, userId: USER_ONE })).toMatchObject({
			status: "dropped",
			reason: "foreign-guild"
		});

		// The configured Guild still holds exactly what it held, including the member a foreign removal named.
		expect(await database.countRows("guild_role")).toBe(3);
		expect(await database.countRows("guild_membership")).toBe(1);
		expect((await subject.members.findMembership(GUILD_ID, USER_ONE))?.roleIds).toEqual([ROLE_BACKEND]);
		// One anomaly line per event, and each names only the Guilds and the resource id (R14's boundary).
		expect(subject.logger.linesAt("warn")).toHaveLength(4);
	});

	it("logs ids and counts only across a whole event sequence (R14)", async () => {
		await subject.upsertRole.execute({
			guildId: GUILD_ID,
			roleId: ROLE_BACKEND,
			roleName: "peekaboo-role",
			permissionsBitfield: UNSAFE_BITFIELD,
			position: 4
		});
		await subject.applyMemberUpdate.execute({ guildId: GUILD_ID, userId: USER_ONE, roleIds: [ROLE_BACKEND] });
		await subject.endMembership.execute({ guildId: GUILD_ID, userId: USER_ONE });

		const transcript = subject.logger.transcript();
		expect(transcript).toContain(GUILD_ID);
		expect(transcript).toContain(ROLE_BACKEND);
		expect(transcript).toContain(USER_ONE);
		expect(transcript).not.toContain("peekaboo-role");
		expect(transcript).not.toContain(UNSAFE_BITFIELD);
		// A role name the registry holds is still not a fact a log line may carry (R14).
		expect(transcript).not.toContain(`role-${ROLE_OPS}`);
	});
});
