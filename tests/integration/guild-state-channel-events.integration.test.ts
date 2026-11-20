import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";
import type { SqlClientSession, SqlExecutor } from "../../src/features/guild-state/repositories/sql-executor.js";
import { PostgresGuildRegistryRepository } from "../../src/features/guild-state/repositories/postgres-guild-registry.repository.js";
import { PostgresRoleRegistryRepository } from "../../src/features/guild-state/repositories/postgres-role-registry.repository.js";
import { PostgresMembershipRegistryRepository } from "../../src/features/guild-state/repositories/postgres-membership-registry.repository.js";
import { PostgresChannelRegistryRepository } from "../../src/features/guild-state/repositories/postgres-channel-registry.repository.js";
import { PostgresThreadMembershipRegistryRepository } from "../../src/features/guild-state/repositories/postgres-thread-membership-registry.repository.js";
import { UpsertChannelCommand } from "../../src/features/guild-state/commands/upsert-channel.command.js";
import type { UpsertChannelEvent } from "../../src/features/guild-state/commands/upsert-channel.command.js";
import { DeleteChannelCommand } from "../../src/features/guild-state/commands/delete-channel.command.js";
import { ApplyThreadMembershipChangeCommand } from "../../src/features/guild-state/commands/apply-thread-membership-change.command.js";
import { createGuildStateConfig } from "../../src/features/guild-state/config/guild-state-config.interface.js";
import type { DiscordIdentifier } from "../../src/features/guild-state/models/domain/discord-identifier.js";
import type { ChannelPermissionOverwrite } from "../../src/features/discord/index.js";
import type { RegistryChannel, RegistryRole } from "../../src/features/guild-state/models/domain/registry-records.js";
import { RecordingLogger } from "../features/guild-state/fakes/recording-logger.js";

/**
 * T5 and T6 evidence — channel/thread registry events and private-thread membership events against a real
 * PostgreSQL.
 *
 * The doubles in `tests/features/guild-state/` prove what the commands *decide*; this file proves what the
 * schema *refuses*, because the two claims only mean something together:
 *
 * - **R6, a thread's parent is resolvable.** The command returns a refusal before a write, and the tables back
 *   the same rule up independently — a raw insert of a parentless thread trips `channel_thread_has_parent` and a
 *   thread naming a parent that does not exist trips the parent foreign key (`23503`). A refusal that only the
 *   command enforced would be one refactor away from orphan rows.
 * - **R7, replacement, and R10, absent is not empty.** Both are claims about surviving rows, so both are read
 *   back from the database: a grant that left the payload is gone, and a payload that said nothing about
 *   overwrites leaves the stored set exactly as it was.
 * - **R6's deletion cascade.** Removing a channel removes its overwrite rows, the thread rows under them and the
 *   private-thread membership edges of those threads, in one transaction — proven by injecting the failure into
 *   the *last* statement, where a partially removed channel would show as rows that outlived their parent.
 * - **R8, the edge and nothing else.** An add for a thread the registry does not hold is refused at the command,
 *   and the same insert attempted directly fails on the `(guild_id, thread_id)` foreign key: the registry cannot
 *   hold a private-thread grant with no thread, which is why "unknown thread" must never create one.
 * - **R9, replay.** The same event delivered twice leaves identical rows and costs the same bounded writes
 *   again — the channel row's batch and the overwrite set's sweep-and-insert — so a redelivery can never widen
 *   the registry or the transaction count.
 *
 * Without `TEST_DATABASE_URL` this suite is skipped and the harness prints the UNAVAILABLE banner; skipped is
 * missing evidence, never a pass.
 */

const GUILD_ID = "160000000000000001";
const OTHER_GUILD_ID = "160000000000000999";
const ROLE_BACKEND = "160000000000000010";
const USER_ONE = "160000000000000101";
const USER_TWO = "160000000000000102";
const CATEGORY = "160000000000000204";
const CHANNEL_PRIVATE = "160000000000000201";
const CHANNEL_PUBLIC = "160000000000000202";
const THREAD_UNDER_PRIVATE = "160000000000000203";
/** Named by a membership event and by nothing in the registry: R8's deferral. */
const THREAD_UNKNOWN = "160000000000000205";

const VIEW_CHANNEL = "1024";
const READ_MESSAGE_HISTORY = "65536";
/** Larger than `Number.MAX_SAFE_INTEGER`: anything that coerces it changes the grant (R7). */
const UNSAFE_BITFIELD = "9007199254740993";

/** The statement that removes the row the deletion named: the last one of R6's cascade. */
const FINAL_CHANNEL_DELETE = /DELETE FROM channel\s+WHERE guild_id = \$1 AND channel_id = \$2/;

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
 * An executor that counts transactions and statements and can fail one statement from the inside — the only
 * way to show R6's cascade is atomic rather than merely sequential.
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

/** The registry one case runs against: the channel and thread-membership repositories plus the three commands. */
interface Subject {
	readonly database: IsolatedTestDatabase;
	readonly logger: RecordingLogger;
	readonly channels: PostgresChannelRegistryRepository;
	readonly threadMemberships: PostgresThreadMembershipRegistryRepository;
	readonly upsertChannel: UpsertChannelCommand;
	readonly deleteChannel: DeleteChannelCommand;
	readonly threadMember: ApplyThreadMembershipChangeCommand;
}

describe.skipIf(!HAS_TEST_DATABASE)("guild-state channel and thread-membership events (real PostgreSQL)", () => {
	let database: IsolatedTestDatabase;
	let subject: Subject;

	beforeAll(async () => {
		database = await openIsolatedTestDatabase("guild_state_channels");
	}, 180_000);

	afterAll(async () => {
		// Best effort: a failed case must not leak a database into the shared server.
		await database?.close();
	});

	beforeEach(async () => {
		await database.resetRegistry();
		const logger = new RecordingLogger();
		const executor = database.executor;
		const channels = new PostgresChannelRegistryRepository({ executor, writeBatchSize: 200 });
		const threadMemberships = new PostgresThreadMembershipRegistryRepository({ executor });
		const config = createGuildStateConfig({ guildId: GUILD_ID });

		// What every case needs, stored through the T1 repositories: one Guild, two top-level channels and one
		// thread under the private one. Nothing else exists before a case runs.
		await new PostgresGuildRegistryRepository({ executor }).upsertGuild({
			guildId: GUILD_ID,
			guildName: "Example Guild HQ"
		});
		await new PostgresRoleRegistryRepository({ executor, writeBatchSize: 200 }).upsertRoles([
			roleRow(GUILD_ID, "0", 0),
			roleRow(ROLE_BACKEND, VIEW_CHANNEL, 1)
		]);
		await new PostgresMembershipRegistryRepository({ executor, writeBatchSize: 200 }).upsertMemberships([
			{ guildId: GUILD_ID, userId: USER_ONE, roleIds: [ROLE_BACKEND] },
			{ guildId: GUILD_ID, userId: USER_TWO, roleIds: [] }
		]);
		await channels.upsertChannels([
			channelRow(CHANNEL_PRIVATE, "guild-text", null, 0),
			channelRow(CHANNEL_PUBLIC, "guild-text", null, 1),
			channelRow(THREAD_UNDER_PRIVATE, "private-thread", CHANNEL_PRIVATE, 2)
		]);

		subject = {
			database,
			logger,
			channels,
			threadMemberships,
			upsertChannel: new UpsertChannelCommand({ config, channelRegistry: channels, logger }),
			deleteChannel: new DeleteChannelCommand({ config, channelRegistry: channels, logger }),
			threadMember: new ApplyThreadMembershipChangeCommand({
				config,
				channelRegistry: channels,
				threadMembershipRegistry: threadMemberships,
				logger
			})
		};
	});

	/* --------------------------------------- T5: the channel registry --------------------------------------- */

	it("stores a thread event whose parent the registry holds, with the parent the payload named (R6)", async () => {
		const outcome = await subject.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: "160000000000000206",
			channelType: "public-thread",
			name: "a-thread",
			parentChannelId: CHANNEL_PUBLIC
		});

		expect(outcome).toMatchObject({ status: "applied", isThread: true, created: true, rowsWritten: 1 });
		expect(await subject.channels.findChannel(GUILD_ID, "160000000000000206")).toEqual({
			guildId: GUILD_ID,
			channelId: "160000000000000206",
			channelType: "public-thread",
			name: "a-thread",
			// A thread update carries no position; `null` is the honest absence, not a guessed zero.
			position: null,
			parentChannelId: CHANNEL_PUBLIC
		});
	});

	it("refuses a parentless thread event and an unknown-parent one, writing nothing at all (R6's error case)", async () => {
		const parentless = await subject.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: THREAD_UNKNOWN,
			channelType: "private-thread"
		});
		const unknownParent = await subject.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: THREAD_UNKNOWN,
			channelType: "private-thread",
			parentChannelId: CATEGORY
		});

		expect(parentless).toMatchObject({ status: "refused", reason: "thread-parent-missing", parentChannelId: null });
		expect(unknownParent).toMatchObject({
			status: "refused",
			reason: "parent-not-registered",
			parentChannelId: CATEGORY
		});
		expect(await subject.channels.findChannel(GUILD_ID, THREAD_UNKNOWN)).toBeNull();
		expect(await database.countRows("channel")).toBe(3);

		// The schema refuses the same two rows on its own, so the rule is not the command's alone to keep.
		await expect(
			database.executor.query(
				`INSERT INTO channel (channel_id, guild_id, channel_type, is_thread, parent_channel_id)
				 VALUES ($1, $2, 'private-thread', true, NULL)`,
				[THREAD_UNKNOWN, GUILD_ID]
			)
		).rejects.toMatchObject({ code: "23514" });
		await expect(
			database.executor.query(
				`INSERT INTO channel (channel_id, guild_id, channel_type, is_thread, parent_channel_id)
				 VALUES ($1, $2, 'private-thread', true, $3)`,
				[THREAD_UNKNOWN, GUILD_ID, CATEGORY]
			)
		).rejects.toMatchObject({ code: "23503" });
	});

	it("converges a refused thread event once the parent arrives, through the replayed event (R6, R10, R11 path)", async () => {
		await subject.deleteChannel.execute({ guildId: GUILD_ID, channelId: CHANNEL_PUBLIC });
		const event: UpsertChannelEvent = {
			guildId: GUILD_ID,
			channelId: "160000000000000207",
			channelType: "announcement-thread",
			parentChannelId: CHANNEL_PUBLIC
		};

		expect(await subject.upsertChannel.execute(event)).toMatchObject({
			status: "refused",
			reason: "parent-not-registered"
		});

		// The parent's own event lands; the replayed thread event is now applicable and writes the row.
		await subject.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL_PUBLIC,
			channelType: "guild-text",
			name: "public",
			position: 1
		});
		expect(await subject.upsertChannel.execute(event)).toMatchObject({ status: "applied", created: true });
		expect((await subject.channels.findChannel(GUILD_ID, "160000000000000207"))?.parentChannelId).toBe(
			CHANNEL_PUBLIC
		);
	});

	it("replaces a reported overwrite set wholesale, removing the grant that left the payload (R7)", async () => {
		await subject.channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [
				{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" },
				{ targetId: USER_ONE, targetType: "member", allowBitfield: "0", denyBitfield: READ_MESSAGE_HISTORY }
			]
		});

		const outcome = await subject.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			channelType: "guild-text",
			name: "private-renamed",
			position: 0,
			permissionOverwrites: [
				// One target of the two, and the bitfields moved: the member's old deny cannot survive.
				{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: UNSAFE_BITFIELD, denyBitfield: "0" }
			]
		});

		expect(outcome).toMatchObject({ status: "applied", overwriteSetReplaced: true, overwritesWritten: 1 });
		expect(await subject.channels.findChannelOverwrites(GUILD_ID, CHANNEL_PRIVATE)).toEqual([
			{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: UNSAFE_BITFIELD, denyBitfield: "0" }
		]);
		expect(await database.countRows("channel_permission_overwrite")).toBe(1);
	});

	it("treats an explicitly empty overwrite set as a statement that the channel has none (R7, R10)", async () => {
		await subject.channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }]
		});

		await subject.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			channelType: "guild-text",
			name: "private-renamed",
			position: 0,
			permissionOverwrites: []
		});

		expect(await subject.channels.findChannelOverwrites(GUILD_ID, CHANNEL_PRIVATE)).toEqual([]);
		expect(await database.countRows("channel_permission_overwrite")).toBe(0);
	});

	it("leaves the stored overwrite set untouched when the payload carried none, and records the gap (R10, T8)", async () => {
		await subject.channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }]
		});

		// The same update without the field: silence about overwrites is not a claim that they are gone.
		const outcome = await subject.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			channelType: "guild-text",
			name: "private-renamed",
			position: 0
		});

		expect(outcome).toMatchObject({
			status: "applied",
			overwriteSetReplaced: false,
			pendingRestFields: ["permissionOverwrites"]
		});
		expect(await subject.channels.findChannelOverwrites(GUILD_ID, CHANNEL_PRIVATE)).toEqual([
			{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }
		]);
		// The row itself still moved: the gap is one field, not the whole event.
		expect((await subject.channels.findChannel(GUILD_ID, CHANNEL_PRIVATE))?.name).toBe("private-renamed");
		expect(subject.logger.linesAt("warn").at(-1)?.fields).toMatchObject({
			channelId: CHANNEL_PRIVATE,
			pendingRestFields: ["permissionOverwrites"]
		});
	});

	it("completes a field the payload omitted from the stored row and stores the rest as sent (R10)", async () => {
		await subject.channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }]
		});

		// An update naming only a new position: the name and the parent come from the row Discord described before.
		await subject.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			channelType: "guild-text",
			position: 7
		});

		expect(await subject.channels.findChannel(GUILD_ID, CHANNEL_PRIVATE)).toEqual({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			channelType: "guild-text",
			name: `channel-${CHANNEL_PRIVATE}`,
			position: 7,
			parentChannelId: null
		});
		// Threads keep their own parent: the sweep of one channel's row cannot orphan the thread under it.
		expect((await subject.channels.findChannel(GUILD_ID, THREAD_UNDER_PRIVATE))?.parentChannelId).toBe(
			CHANNEL_PRIVATE
		);
	});

	it("drops an overwrite target of a kind that is neither role nor member and counts it (R7's error case)", async () => {
		const outcome = await subject.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL_PUBLIC,
			channelType: "guild-text",
			name: "public",
			position: 1,
			permissionOverwrites: [
				{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" },
				// A kind the schema's own CHECK would reject: guessing it from the id would move a grant between
				// the role stage and the member stage of the derivation order.
				{
					targetId: USER_ONE,
					targetType: "channel",
					allowBitfield: "0",
					denyBitfield: "0"
				} as unknown as ChannelPermissionOverwrite,
				{ targetId: USER_TWO, targetType: "member", allowBitfield: "0", denyBitfield: VIEW_CHANNEL }
			]
		});

		expect(outcome).toMatchObject({
			status: "applied",
			droppedOverwriteTargetIds: [USER_ONE],
			overwritesWritten: 2
		});
		expect(await subject.channels.findChannelOverwrites(GUILD_ID, CHANNEL_PUBLIC)).toEqual([
			{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" },
			{ targetId: USER_TWO, targetType: "member", allowBitfield: "0", denyBitfield: VIEW_CHANNEL }
		]);
		expect(subject.logger.transcript()).toContain(`"droppedOverwriteTargetIds":["${USER_ONE}"]`);
	});

	it("replays a channel event to identical rows and the same bounded write footprint (R9)", async () => {
		const observer = new ObservingExecutor(database.executor);
		const composed = new UpsertChannelCommand({
			config: createGuildStateConfig({ guildId: GUILD_ID }),
			channelRegistry: new PostgresChannelRegistryRepository({ executor: observer, writeBatchSize: 200 }),
			logger: subject.logger
		});
		const event: UpsertChannelEvent = {
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			channelType: "guild-text",
			name: "private",
			position: 0,
			permissionOverwrites: [
				{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }
			]
		};

		await composed.execute(event);
		const afterFirst = await subject.channels.findChannel(GUILD_ID, CHANNEL_PRIVATE);
		const overwritesAfterFirst = await subject.channels.findChannelOverwrites(GUILD_ID, CHANNEL_PRIVATE);
		// Two transactions per delivery, and this asserts the count rather than trusting it: the channel row's
		// bounded batch, then the overwrite set's sweep-and-insert. The reads in between are plain queries.
		const footprintPerDelivery = observer.transactions;
		expect(footprintPerDelivery).toBe(2);
		await composed.execute(event);

		expect(await subject.channels.findChannel(GUILD_ID, CHANNEL_PRIVATE)).toEqual(afterFirst);
		expect(await subject.channels.findChannelOverwrites(GUILD_ID, CHANNEL_PRIVATE)).toEqual(overwritesAfterFirst);
		expect(await database.countRows("channel")).toBe(3);
		expect(await database.countRows("channel_permission_overwrite")).toBe(1);
		// Replay grows the registry by nothing and the transaction count by exactly the same two writes: a
		// redelivery costs what the first one did, never more.
		expect(observer.transactions).toBe(footprintPerDelivery * 2);
	});

	/* --------------------------------- T5: channel deletion and its cascade ---------------------------------- */

	it("deleting a channel removes its overwrites, its threads and their membership edges in one transaction (R6, R8)", async () => {
		await subject.channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }]
		});
		await subject.channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: THREAD_UNDER_PRIVATE,
			overwrites: [{ targetId: USER_ONE, targetType: "member", allowBitfield: "0", denyBitfield: VIEW_CHANNEL }]
		});
		await subject.threadMemberships.addThreadMembership({
			guildId: GUILD_ID,
			threadId: THREAD_UNDER_PRIVATE,
			userId: USER_ONE
		});
		await subject.threadMemberships.addThreadMembership({
			guildId: GUILD_ID,
			threadId: THREAD_UNDER_PRIVATE,
			userId: USER_TWO
		});

		const outcome = await subject.deleteChannel.execute({ guildId: GUILD_ID, channelId: CHANNEL_PRIVATE });

		expect(outcome).toMatchObject({
			status: "applied",
			channelId: CHANNEL_PRIVATE,
			channelRemoved: true,
			childThreadsRemoved: 1,
			overwritesRemoved: 2,
			threadMembershipsRemoved: 2
		});
		expect(await subject.channels.findChannel(GUILD_ID, CHANNEL_PRIVATE)).toBeNull();
		expect(await subject.channels.findChannel(GUILD_ID, THREAD_UNDER_PRIVATE)).toBeNull();
		expect(await database.countRows("channel")).toBe(1);
		expect(await database.countRows("channel_permission_overwrite")).toBe(0);
		expect(await database.countRows("thread_membership")).toBe(0);
		// The channel nobody named is untouched, with its rows intact.
		expect(await subject.channels.findChannel(GUILD_ID, CHANNEL_PUBLIC)).not.toBeNull();

		// R9: the same deletion again is a counted no-op, not an error.
		expect(await subject.deleteChannel.execute({ guildId: GUILD_ID, channelId: CHANNEL_PRIVATE })).toMatchObject({
			status: "applied",
			channelRemoved: false,
			childThreadsRemoved: 0,
			overwritesRemoved: 0,
			threadMembershipsRemoved: 0
		});
	});

	it("deleting a thread removes its own rows and leaves the parent channel in place (R6)", async () => {
		await subject.channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: THREAD_UNDER_PRIVATE,
			overwrites: [{ targetId: USER_ONE, targetType: "member", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }]
		});
		await subject.threadMemberships.addThreadMembership({
			guildId: GUILD_ID,
			threadId: THREAD_UNDER_PRIVATE,
			userId: USER_ONE
		});

		const outcome = await subject.deleteChannel.execute({ guildId: GUILD_ID, channelId: THREAD_UNDER_PRIVATE });

		expect(outcome).toMatchObject({
			status: "applied",
			childThreadsRemoved: 0,
			overwritesRemoved: 1,
			threadMembershipsRemoved: 1
		});
		expect(await subject.channels.findChannel(GUILD_ID, CHANNEL_PRIVATE)).not.toBeNull();
		expect(await database.countRows("channel")).toBe(2);
	});

	it("rolls a channel deletion back as one unit when the cascade's last statement fails (R6 atomicity)", async () => {
		await subject.channels.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }]
		});
		await subject.threadMemberships.addThreadMembership({
			guildId: GUILD_ID,
			threadId: THREAD_UNDER_PRIVATE,
			userId: USER_ONE
		});

		const observer = new ObservingExecutor(database.executor, FINAL_CHANNEL_DELETE);
		const composed = new DeleteChannelCommand({
			config: createGuildStateConfig({ guildId: GUILD_ID }),
			channelRegistry: new PostgresChannelRegistryRepository({ executor: observer, writeBatchSize: 200 }),
			logger: subject.logger
		});

		await expect(composed.execute({ guildId: GUILD_ID, channelId: CHANNEL_PRIVATE })).rejects.toThrow(/injected/);

		expect(observer.transactions).toBe(1);
		// Nothing was half-removed: the parent, its thread, the thread's edge and the overwrite all survived.
		expect(await subject.channels.findChannel(GUILD_ID, CHANNEL_PRIVATE)).not.toBeNull();
		expect(await subject.channels.findChannel(GUILD_ID, THREAD_UNDER_PRIVATE)).not.toBeNull();
		expect(await database.countRows("channel_permission_overwrite")).toBe(1);
		expect(await database.countRows("thread_membership")).toBe(1);
	});

	it("treats a deletion for a channel the registry never held as a counted no-op (R9)", async () => {
		const outcome = await subject.deleteChannel.execute({ guildId: GUILD_ID, channelId: CATEGORY });

		expect(outcome).toMatchObject({
			status: "applied",
			channelRemoved: false,
			childThreadsRemoved: 0,
			overwritesRemoved: 0,
			threadMembershipsRemoved: 0
		});
		expect(await database.countRows("channel")).toBe(3);
	});

	/* ------------------------------- T6: private-thread membership edges ------------------------------------ */

	it("stores a thread-member edge on an add and removes it on the counterpart event (R8, R9)", async () => {
		expect(
			await subject.threadMember.execute({
				guildId: GUILD_ID,
				threadId: THREAD_UNDER_PRIVATE,
				userId: USER_ONE,
				change: "added"
			})
		).toMatchObject({ status: "applied", change: "added", rowWritten: true });
		expect(await subject.threadMemberships.findThreadMemberUserIds(GUILD_ID, THREAD_UNDER_PRIVATE)).toEqual([
			USER_ONE
		]);
		expect(await subject.threadMemberships.findThreadIdsForMember(GUILD_ID, USER_ONE)).toEqual([
			THREAD_UNDER_PRIVATE
		]);

		// R9: the same add again is a no-op that says so, and the set is what it was.
		expect(
			await subject.threadMember.execute({
				guildId: GUILD_ID,
				threadId: THREAD_UNDER_PRIVATE,
				userId: USER_ONE,
				change: "added"
			})
		).toMatchObject({ status: "applied", change: "added", rowWritten: false });
		expect(await database.countRows("thread_membership")).toBe(1);

		expect(
			await subject.threadMember.execute({
				guildId: GUILD_ID,
				threadId: THREAD_UNDER_PRIVATE,
				userId: USER_ONE,
				change: "removed"
			})
		).toMatchObject({ status: "applied", change: "removed", rowRemoved: true });
		expect(await subject.threadMemberships.findThreadMemberUserIds(GUILD_ID, THREAD_UNDER_PRIVATE)).toEqual([]);
		expect(
			await subject.threadMember.execute({
				guildId: GUILD_ID,
				threadId: THREAD_UNDER_PRIVATE,
				userId: USER_ONE,
				change: "removed"
			})
		).toMatchObject({ status: "applied", change: "removed", rowRemoved: false });
		expect(await database.countRows("thread_membership")).toBe(0);
	});

	it("defers a membership change whose thread the registry does not hold, and the key defers it too (R8's error case)", async () => {
		const outcome = await subject.threadMember.execute({
			guildId: GUILD_ID,
			threadId: THREAD_UNKNOWN,
			userId: USER_ONE,
			change: "added"
		});

		expect(outcome).toMatchObject({ status: "refused", reason: "unknown-thread", threadId: THREAD_UNKNOWN });
		expect(await database.countRows("thread_membership")).toBe(0);
		expect(await subject.channels.findChannel(GUILD_ID, THREAD_UNKNOWN)).toBeNull();
		expect(subject.logger.linesAt("warn").at(-1)?.fields).toMatchObject({
			threadId: THREAD_UNKNOWN,
			reason: "unknown-thread"
		});

		// The table cannot hold the edge either: `(guild_id, thread_id)` references the channel registry, so an
		// orphan grant is impossible even for a caller that skipped the command's check.
		await expect(
			database.executor.query(
				`INSERT INTO thread_membership (guild_id, thread_id, user_id) VALUES ($1, $2, $3)`,
				[GUILD_ID, THREAD_UNKNOWN, USER_ONE]
			)
		).rejects.toMatchObject({ code: "23503" });

		// The thread's own event arrives; the replayed change lands on it (R10, R11).
		await subject.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: THREAD_UNKNOWN,
			channelType: "private-thread",
			parentChannelId: CHANNEL_PRIVATE
		});
		expect(
			await subject.threadMember.execute({
				guildId: GUILD_ID,
				threadId: THREAD_UNKNOWN,
				userId: USER_ONE,
				change: "added"
			})
		).toMatchObject({ status: "applied", rowWritten: true });
		expect(await database.countRows("thread_membership")).toBe(1);
	});

	it("refuses a membership change naming a channel that is not a thread (R8's boundary)", async () => {
		expect(
			await subject.threadMember.execute({
				guildId: GUILD_ID,
				threadId: CHANNEL_PRIVATE,
				userId: USER_ONE,
				change: "added"
			})
		).toMatchObject({ status: "refused", reason: "not-a-thread" });
		expect(await database.countRows("thread_membership")).toBe(0);
	});

	it("stores an edge for a user the roster does not hold, and removes it with the thread (R8's boundary, R4, R6)", async () => {
		const USER_STRANGER = "160000000000000104";

		expect(
			await subject.threadMember.execute({
				guildId: GUILD_ID,
				threadId: THREAD_UNDER_PRIVATE,
				userId: USER_STRANGER,
				change: "added"
			})
		).toMatchObject({ status: "applied", rowWritten: true });
		// `thread_membership` has no foreign key to `guild_membership`: the fact stands on its own, so an event
		// that arrives before the roster page lands is stored rather than failed on ordering.
		expect(await subject.threadMemberships.findThreadMemberUserIds(GUILD_ID, THREAD_UNDER_PRIVATE)).toEqual([
			USER_STRANGER
		]);

		// R6's cascade is what takes the edge away when the thread goes.
		expect(
			await subject.deleteChannel.execute({ guildId: GUILD_ID, channelId: THREAD_UNDER_PRIVATE })
		).toMatchObject({
			threadMembershipsRemoved: 1
		});
		expect(await database.countRows("thread_membership")).toBe(0);
	});

	it("keeps one thread's edges distinct from another thread's and from the public channel's set (R8)", async () => {
		await subject.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: "160000000000000208",
			channelType: "private-thread",
			parentChannelId: CHANNEL_PRIVATE
		});
		await subject.threadMember.execute({
			guildId: GUILD_ID,
			threadId: THREAD_UNDER_PRIVATE,
			userId: USER_ONE,
			change: "added"
		});
		await subject.threadMember.execute({
			guildId: GUILD_ID,
			threadId: "160000000000000208",
			userId: USER_TWO,
			change: "added"
		});

		expect(await subject.threadMemberships.findThreadMemberUserIds(GUILD_ID, THREAD_UNDER_PRIVATE)).toEqual([
			USER_ONE
		]);
		expect(await subject.threadMemberships.findThreadMemberUserIds(GUILD_ID, "160000000000000208")).toEqual([
			USER_TWO
		]);
		// A public channel is not a thread and has no edge set of its own: nothing was ever stored for it.
		expect(await subject.threadMemberships.findThreadMemberUserIds(GUILD_ID, CHANNEL_PRIVATE)).toEqual([]);
		expect(await database.countRows("thread_membership")).toBe(2);
	});

	/* ------------------------------------- R1 and R14 at the edge ------------------------------------------ */

	it("drops channel, deletion and thread-member events for another Guild without writing a row (R1)", async () => {
		await subject.threadMember.execute({
			guildId: GUILD_ID,
			threadId: THREAD_UNDER_PRIVATE,
			userId: USER_ONE,
			change: "added"
		});

		expect(
			await subject.upsertChannel.execute({
				guildId: OTHER_GUILD_ID,
				channelId: "160000000000000209",
				channelType: "guild-text",
				name: "foreign-channel",
				position: 0,
				permissionOverwrites: [
					{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }
				]
			})
		).toMatchObject({ status: "dropped", reason: "foreign-guild" });
		expect(
			await subject.deleteChannel.execute({ guildId: OTHER_GUILD_ID, channelId: CHANNEL_PRIVATE })
		).toMatchObject({ status: "dropped", reason: "foreign-guild" });
		expect(
			await subject.threadMember.execute({
				guildId: OTHER_GUILD_ID,
				threadId: THREAD_UNDER_PRIVATE,
				userId: USER_TWO,
				change: "added"
			})
		).toMatchObject({ status: "dropped", reason: "foreign-guild" });

		// The configured Guild still holds exactly what it held, including the row a foreign deletion named.
		expect(await database.countRows("channel")).toBe(3);
		expect(await database.countRows("channel_permission_overwrite")).toBe(0);
		expect(await database.countRows("thread_membership")).toBe(1);
		expect((await subject.channels.findChannel(GUILD_ID, CHANNEL_PRIVATE))?.name).toBe(
			`channel-${CHANNEL_PRIVATE}`
		);
		// One anomaly line per event, each naming only the Guilds and the resource id (R14's boundary).
		expect(subject.logger.linesAt("warn")).toHaveLength(3);
	});

	it("logs ids and counts only across a whole channel and thread-member sequence (R14)", async () => {
		await subject.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			channelType: "guild-text",
			name: "peekaboo-channel",
			position: 0,
			permissionOverwrites: [
				{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: UNSAFE_BITFIELD, denyBitfield: "0" }
			]
		});
		await subject.threadMember.execute({
			guildId: GUILD_ID,
			threadId: THREAD_UNDER_PRIVATE,
			userId: USER_ONE,
			change: "added"
		});
		await subject.deleteChannel.execute({ guildId: GUILD_ID, channelId: CHANNEL_PRIVATE });

		const transcript = subject.logger.transcript();
		expect(transcript).toContain(GUILD_ID);
		expect(transcript).toContain(CHANNEL_PRIVATE);
		expect(transcript).toContain(USER_ONE);
		// A channel name and a bitfield the registry holds are still not facts a log line may carry.
		expect(transcript).not.toContain("peekaboo-channel");
		expect(transcript).not.toContain(UNSAFE_BITFIELD);
		expect(transcript).not.toContain(`channel-${CATEGORY}`);
	});
});
