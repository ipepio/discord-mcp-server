import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	DiscordEventKind as Kind,
	type ChannelUpdatedEvent,
	type MemberRemovedEvent,
	type NormalizedDiscordEvent,
	type RoleDeletedEvent,
	type ThreadMemberAddedEvent,
	type ThreadMemberRemovedEvent
} from "../../src/features/discord/index.js";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";
import { InMemoryBootstrapStateTracker } from "../../src/features/guild-state/bootstrap/in-memory-bootstrap-state.js";
import { InMemoryGuildResyncLedger } from "../../src/features/guild-state/bootstrap/in-memory-resync-ledger.js";
import { ApplyGuildBootstrapCommand } from "../../src/features/guild-state/commands/apply-guild-bootstrap.command.js";
import { ApplyMemberUpdateCommand } from "../../src/features/guild-state/commands/apply-member-update.command.js";
import { ApplyThreadMembershipChangeCommand } from "../../src/features/guild-state/commands/apply-thread-membership-change.command.js";
import { DeleteChannelCommand } from "../../src/features/guild-state/commands/delete-channel.command.js";
import { DeleteRoleCommand } from "../../src/features/guild-state/commands/delete-role.command.js";
import { EndMembershipCommand } from "../../src/features/guild-state/commands/end-membership.command.js";
import { ResyncGuildStateCommand } from "../../src/features/guild-state/commands/resync-guild-state.command.js";
import { SweepVanishedStateCommand } from "../../src/features/guild-state/commands/sweep-vanished-state.command.js";
import { UpsertChannelCommand } from "../../src/features/guild-state/commands/upsert-channel.command.js";
import { UpsertRoleCommand } from "../../src/features/guild-state/commands/upsert-role.command.js";
import { createGuildStateConfig } from "../../src/features/guild-state/config/guild-state-config.interface.js";
import type { GuildStateConfig } from "../../src/features/guild-state/config/guild-state-config.interface.js";
import { GuildStateEventSubscription } from "../../src/features/guild-state/gateways/guild-state-event-subscription.gateway.js";
import { EvaluateEffectivePermissionsQuery } from "../../src/features/guild-state/queries/evaluate-effective-permissions.query.js";
import { GetGuildStateStatusQuery } from "../../src/features/guild-state/queries/get-guild-state-status.query.js";
import { ListUserAccessibleChannelsQuery } from "../../src/features/guild-state/queries/list-user-accessible-channels.query.js";
import { PostgresChannelRegistryRepository } from "../../src/features/guild-state/repositories/postgres-channel-registry.repository.js";
import { PostgresGuildRegistryRepository } from "../../src/features/guild-state/repositories/postgres-guild-registry.repository.js";
import { PostgresMembershipRegistryRepository } from "../../src/features/guild-state/repositories/postgres-membership-registry.repository.js";
import { PostgresPermissionSnapshotRepository } from "../../src/features/guild-state/repositories/postgres-permission-snapshot.repository.js";
import { PostgresRoleRegistryRepository } from "../../src/features/guild-state/repositories/postgres-role-registry.repository.js";
import { PostgresThreadMembershipRegistryRepository } from "../../src/features/guild-state/repositories/postgres-thread-membership-registry.repository.js";
import type { ChannelPermissionOverwrite } from "../../src/features/discord/index.js";
import { FakeDiscordEventConsumer } from "../features/guild-state/fakes/fake-discord-event-consumer.js";
import {
	FakeGuildStateGateway,
	channel,
	completeRoster,
	member,
	role,
	thread,
	threadPage
} from "../features/guild-state/fakes/fake-guild-state-gateway.js";
import type { FakeGatewayProgram } from "../features/guild-state/fakes/fake-guild-state-gateway.js";
import { RecordingLogger } from "../features/guild-state/fakes/recording-logger.js";

/**
 * T9d — the ADR 0005 revocation suite, end to end on a real PostgreSQL
 * (`docs/features/guild-state.md` R4, R5, R7, R8, R11, R12; `docs/adr/0005-…`; the five cases
 * `odd/tasks/guild-state.md` names).
 *
 * Every earlier file in this feature proves one layer: the commands decide correctly over doubles (T3–T6), the
 * derivation decides correctly over a projected snapshot (T7), the binding maps fields (T9a). This file proves
 * the line the ADR is actually about — *a Discord event arrives, and the next decision is different* — with the
 * real registry tables in between, because that middle is where a revocation can silently fail to land: a
 * cascade that misses a dependent row leaves a grant behind even though the event was "applied".
 *
 * The route is the production route: normalized event → subscription binding → command → PostgreSQL repository
 * → snapshot → derivation. The only substituted parts are the socket (the consumer fake) and the REST reads
 * (the gateway fake), neither of which owns registry state.
 *
 * No case is a pinned gap any more. T8's resync converged what a read could correct, and reported as a gap the
 * one thing it could not reach — a member who left during the outage, whose absence no upsert removes. T10 closed
 * that leg: the resync now sweeps the memberships, roles and channels a complete read no longer names, through
 * the same cascades the event path uses, and refuses to sweep anything at all from a roster that stopped at its
 * page bound. The suite below proves both halves against the real tables, including the refusal.
 */

const GUILD_ID = "190000000000000001";
const USER_ONE = "190000000000000101";
const USER_TWO = "190000000000000102";
const ROLE_BACKEND = "190000000000000010";
const ROLE_OPS = "190000000000000011";
const CHANNEL_PUBLIC = "190000000000000201";
const CHANNEL_PRIVATE = "190000000000000202";
const PRIVATE_THREAD = "190000000000000203";

const VIEW = "1024";
const SEND = "2048";
const MENTION = "131072";
const HISTORY = "65536";
const EVERYONE_BITS = String(BigInt(VIEW) | BigInt(HISTORY));

describe.skipIf(!HAS_TEST_DATABASE)("guild-state ADR 0005 revocation suite (real PostgreSQL)", () => {
	let database: IsolatedTestDatabase;
	let logger: RecordingLogger;
	let gateway: FakeGuildStateGateway;
	let consumer: FakeDiscordEventConsumer;
	let binding: GuildStateEventSubscription;
	let ledger: InMemoryGuildResyncLedger;
	let tracker: InMemoryBootstrapStateTracker;
	let guilds: PostgresGuildRegistryRepository;
	let roles: PostgresRoleRegistryRepository;
	let members: PostgresMembershipRegistryRepository;
	let channels: PostgresChannelRegistryRepository;
	let threadMemberships: PostgresThreadMembershipRegistryRepository;
	let upsertRoleCommand: UpsertRoleCommand;
	let bootstrap: ApplyGuildBootstrapCommand;
	let resync: ResyncGuildStateCommand;
	let evaluate: EvaluateEffectivePermissionsQuery;
	let listForUser: ListUserAccessibleChannelsQuery;
	let status: GetGuildStateStatusQuery;

	beforeAll(async () => {
		database = await openIsolatedTestDatabase("guild_state_adr0005");
	}, 300_000);

	afterAll(async () => {
		await database?.close();
		database = undefined as unknown as IsolatedTestDatabase;
	});

	beforeEach(async () => {
		await database.resetRegistry();
		logger = new RecordingLogger();
		const config = createGuildStateConfig({ guildId: GUILD_ID });

		guilds = new PostgresGuildRegistryRepository({ executor: database.executor });
		roles = new PostgresRoleRegistryRepository({ executor: database.executor, writeBatchSize: 200 });
		members = new PostgresMembershipRegistryRepository({ executor: database.executor, writeBatchSize: 200 });
		channels = new PostgresChannelRegistryRepository({ executor: database.executor, writeBatchSize: 200 });
		threadMemberships = new PostgresThreadMembershipRegistryRepository({ executor: database.executor });
		const snapshots = new PostgresPermissionSnapshotRepository({ executor: database.executor });

		gateway = new FakeGuildStateGateway(restProgram(), GUILD_ID);
		upsertRoleCommand = new UpsertRoleCommand({ config, roleRegistry: roles, logger });
		const upsertChannel = new UpsertChannelCommand({ config, channelRegistry: channels, logger });

		tracker = new InMemoryBootstrapStateTracker({ guildId: GUILD_ID });
		ledger = new InMemoryGuildResyncLedger({ guildId: GUILD_ID });
		bootstrap = new ApplyGuildBootstrapCommand({
			config,
			gateway,
			tracker,
			guildRegistry: guilds,
			roleRegistry: roles,
			channelRegistry: channels,
			membershipRegistry: members,
			threadMembershipRegistry: threadMemberships,
			logger
		});
		resync = new ResyncGuildStateCommand({
			config,
			gateway,
			tracker,
			ledger,
			bootstrapCommand: bootstrap,
			upsertRoleCommand,
			sweepCommand: buildConvergenceSweep(config),
			roleRegistry: roles,
			channelRegistry: channels,
			logger
		});

		evaluate = new EvaluateEffectivePermissionsQuery({ config, snapshot: snapshots, logger });
		listForUser = new ListUserAccessibleChannelsQuery({ config, snapshot: snapshots, logger });
		status = new GetGuildStateStatusQuery({ config, tracker, ledger, guildRegistry: guilds, logger });

		consumer = new FakeDiscordEventConsumer();
		binding = new GuildStateEventSubscription({
			config,
			logger,
			consumer,
			ledger,
			guildRegistry: guilds,
			upsertRole: upsertRoleCommand,
			deleteRole: new DeleteRoleCommand({ config, roleRegistry: roles, logger }),
			applyMemberUpdate: new ApplyMemberUpdateCommand({
				config,
				roleRegistry: roles,
				membershipRegistry: members,
				logger
			}),
			endMembership: new EndMembershipCommand({ config, membershipRegistry: members, logger }),
			upsertChannel,
			deleteChannel: new DeleteChannelCommand({ config, channelRegistry: channels, logger }),
			applyThreadMembershipChange: new ApplyThreadMembershipChangeCommand({
				config,
				channelRegistry: channels,
				threadMembershipRegistry: threadMemberships,
				logger
			}),
			resync
		});
		binding.subscribe();

		await seedRegistry();
	}, 120_000);

	/* --------------------------------------------------------------------------- fixtures */

	const overwrite = (
		targetId: string,
		targetType: ChannelPermissionOverwrite["targetType"],
		allowBitfield: string,
		denyBitfield: string
	): ChannelPermissionOverwrite => ({ targetId, targetType, allowBitfield, denyBitfield });

	/**
	 * The REST program the hub would read: `@everyone` views and reads history, ROLE_BACKEND sends, ROLE_OPS
	 * mentions, a public channel whose overwrite lets ROLE_OPS mention, a private channel whose overwrite lets
	 * the member view, and a private thread the member holds an edge on. Every channel carries an explicit
	 * overwrite list, because an absent list is a gap by R10 and a gap would make this fixture's own bootstrap
	 * incomplete.
	 */
	function restProgram(overrides: Partial<FakeGatewayProgram> = {}): FakeGatewayProgram {
		return {
			snapshot: { guildId: GUILD_ID, name: "adr-0005" },
			roles: [
				role(GUILD_ID, GUILD_ID, EVERYONE_BITS, 0),
				role(GUILD_ID, ROLE_BACKEND, SEND, 1),
				role(GUILD_ID, ROLE_OPS, MENTION, 2)
			],
			channels: [
				channel(GUILD_ID, CHANNEL_PUBLIC, {
					position: 1,
					permissionOverwrites: [
						overwrite(ROLE_BACKEND, "role", MENTION, "0"),
						overwrite(GUILD_ID, "role", "0", "0")
					]
				}),
				channel(GUILD_ID, CHANNEL_PRIVATE, {
					position: 2,
					permissionOverwrites: [
						overwrite(USER_ONE, "member", VIEW, "0"),
						overwrite(GUILD_ID, "role", "0", VIEW)
					]
				}),
				thread(GUILD_ID, PRIVATE_THREAD, CHANNEL_PRIVATE, "private-thread", {
					position: 3,
					permissionOverwrites: []
				})
			],
			roster: completeRoster(GUILD_ID, [
				member(GUILD_ID, USER_ONE, [ROLE_BACKEND, ROLE_OPS]),
				member(GUILD_ID, USER_TWO, [])
			]),
			threadMembers: { [PRIVATE_THREAD]: [threadPage(PRIVATE_THREAD, [USER_ONE])] },
			...overrides
		};
	}

	/**
	 * The resync reads REST, and a fake gateway is programmed at construction: a changed Discord is therefore a
	 * new gateway, composed onto the same tracker, ledger and real tables. Everything event-driven keeps its
	 * original composition, so a resync run cannot quietly replace the hub's own command instances.
	 */
	function withRestProgram(program: FakeGatewayProgram): ResyncGuildStateCommand {
		const config = createGuildStateConfig({ guildId: GUILD_ID });
		gateway = new FakeGuildStateGateway(program, GUILD_ID);
		bootstrap = new ApplyGuildBootstrapCommand({
			config,
			gateway,
			tracker,
			guildRegistry: guilds,
			roleRegistry: roles,
			channelRegistry: channels,
			membershipRegistry: members,
			threadMembershipRegistry: threadMemberships,
			logger
		});
		resync = new ResyncGuildStateCommand({
			config,
			gateway,
			tracker,
			ledger,
			bootstrapCommand: bootstrap,
			upsertRoleCommand: upsertRoleCommand,
			sweepCommand: buildConvergenceSweep(config),
			roleRegistry: roles,
			channelRegistry: channels,
			logger
		});
		return resync;
	}

	/**
	 * The convergence sweep over the real tables. Every case in this file that changes state on Discord's side
	 * without an event reaching the hub is decided by this command: it is the remove-half of R11, and the rows it
	 * removes are removed through the same cascades the event path drives above (R3, R4, R6).
	 */
	function buildConvergenceSweep(config: GuildStateConfig): SweepVanishedStateCommand {
		return new SweepVanishedStateCommand({
			config,
			membershipRegistry: members,
			roleRegistry: roles,
			channelRegistry: channels,
			deleteRoleCommand: new DeleteRoleCommand({ config, roleRegistry: roles, logger }),
			deleteChannelCommand: new DeleteChannelCommand({ config, channelRegistry: channels, logger }),
			logger
		});
	}

	/** The same state reached through the write path, so the suite starts from rows the commands could produce. */
	async function seedRegistry(): Promise<void> {
		const report = await bootstrap.execute();
		expect(report.gaps).toEqual([]);
		expect(report.complete).toBe(true);
		expect(await guilds.findGuild(GUILD_ID)).not.toBeNull();
	}

	const roleDeleted = (roleId: string): RoleDeletedEvent => ({
		kind: Kind.roleDeleted,
		guildId: GUILD_ID,
		roleId
	});

	const memberRemoved = (userId: string): MemberRemovedEvent => ({
		kind: Kind.memberRemoved,
		guildId: GUILD_ID,
		userId
	});

	const channelUpdated = (
		channelId: string,
		overwrites: readonly { id: string; type: "role" | "member"; allow: string; deny: string }[]
	): ChannelUpdatedEvent => ({
		kind: Kind.channelUpdated,
		guildId: GUILD_ID,
		channelId,
		channelType: "guild-text",
		permissionOverwrites: overwrites.map((entry) => ({
			targetId: entry.id,
			targetType: entry.type,
			allowBitfield: entry.allow,
			denyBitfield: entry.deny
		}))
	});

	const threadMemberRemoved = (userId: string): ThreadMemberRemovedEvent => ({
		kind: Kind.threadMemberRemoved,
		guildId: GUILD_ID,
		threadId: PRIVATE_THREAD,
		userId
	});

	const threadMemberAdded = (userId: string): ThreadMemberAddedEvent => ({
		kind: Kind.threadMemberAdded,
		guildId: GUILD_ID,
		threadId: PRIVATE_THREAD,
		userId
	});

	/** One delivery: the event enters at the socket seam and the command runs on the real tables. */
	async function arrive(event: NormalizedDiscordEvent): Promise<void> {
		const handlers = await consumer.deliver(event);
		expect(handlers).toBe(1);
	}

	const decide = (userId: string, channelId: string = CHANNEL_PUBLIC) => evaluate.execute({ userId, channelId });

	/** Row counts of every registry table, so a cascade is proven by the table and not only by a decision. */
	async function tableCounts(): Promise<Record<string, number>> {
		const names = ["guild", "guild_role", "guild_membership", "guild_membership_role", "channel"];
		const entries = await Promise.all(names.map(async (name) => [name, await database.countRows(name)] as const));
		return Object.fromEntries(entries);
	}

	/* ---------------------------------------------------------------------------- the five named cases */

	it("revocation-role-removed: a deleted role stops granting through its bits and its overwrites (R3, R7, R12)", async () => {
		const before = await decide(USER_ONE);
		expect(before.status).toBe("evaluated");
		expect(before.permissions.has("view-channel")).toBe(true);
		expect(before.permissions.has("send-messages")).toBe(true);
		expect(before.permissions.has("mention-everyone")).toBe(true);
		const roleCountBefore = await database.countRows("guild_role");
		const overwriteCountBefore = await database.countRows("channel_permission_overwrite");
		const linkCountBefore = await database.countRows("guild_membership_role");

		await arrive(roleDeleted(ROLE_BACKEND));

		const after = await decide(USER_ONE);
		expect(after.permissions.has("send-messages")).toBe(false);
		expect(after.permissions.has("mention-everyone")).toBe(true);
		expect(after.permissions.has("view-channel")).toBe(true);

		// The cascade reached the dependent rows, not just the role: the membership link is gone, and the
		// overwrite that named the deleted role is gone rather than surviving as an inert-but-present grant.
		expect(await database.countRows("guild_role")).toBe(roleCountBefore - 1);
		expect(await database.countRows("guild_membership_role")).toBe(linkCountBefore - 1);
		expect(await database.countRows("channel_permission_overwrite")).toBe(overwriteCountBefore - 1);
		expect(await roles.findRolePermissions(GUILD_ID, [ROLE_BACKEND])).toEqual([]);

		// The deleted role's own bit is gone; what survives is the other role's base mention, which is exactly
		// the shape R3 promises: the role cannot grant through a stale row or a stale overwrite.
		expect(after.permissions.bitfield).toBe(String(BigInt(VIEW) | BigInt(HISTORY) | BigInt(MENTION)));

		// R14 on the way out: the deletion is reported by ids and counts.
		expect(logger.transcript()).toContain(ROLE_BACKEND);
		expect(logger.transcript()).not.toMatch(/"(roleName|nickname|username|content|token)":/);
	});

	it("revocation-member-kicked: the membership ends and nothing of theirs survives (R4, R8, R12)", async () => {
		const before = await decide(USER_ONE, PRIVATE_THREAD);
		expect(before.status).toBe("evaluated");
		const threadEdgesBefore = await database.countRows("thread_membership");

		await arrive(memberRemoved(USER_ONE));

		const after = await decide(USER_ONE);
		expect(after.status).toBe("empty");
		expect(after.reason).toBe("membership-not-registered");
		expect(after.permissions.bitfield).toBe("0");
		expect(await decide(USER_ONE, PRIVATE_THREAD)).toMatchObject({ reason: "membership-not-registered" });

		// Every dependent row goes with it: role links and thread edges, so a re-read cannot resurrect access.
		expect(await members.findMembership(GUILD_ID, USER_ONE)).toBeNull();
		expect(await database.countRows("guild_membership")).toBe(1);
		expect(await database.countRows("guild_membership_role")).toBe(0);
		expect(await database.countRows("thread_membership")).toBe(threadEdgesBefore - 1);
		expect(await listForUser.execute({ userId: USER_ONE })).toMatchObject({
			channels: [],
			userId: USER_ONE
		});

		// The other member is untouched: a kick is scoped to one natural key.
		expect(await members.findMembership(GUILD_ID, USER_TWO)).not.toBeNull();
		expect(await decide(USER_TWO)).toMatchObject({ status: "evaluated" });
	});

	it("revocation-channel-overwrite-changed: a replaced set is the whole set, and an empty one is explicit (R7)", async () => {
		expect((await decide(USER_ONE)).permissions.has("mention-everyone")).toBe(true);

		// Discord reports the new set: ROLE_OPS may no longer mention, and the member is denied sending.
		await arrive(
			channelUpdated(CHANNEL_PUBLIC, [
				{ id: ROLE_OPS, type: "role", allow: "0", deny: MENTION },
				{ id: USER_ONE, type: "member", allow: "0", deny: SEND }
			])
		);

		const after = await decide(USER_ONE);
		expect(after.permissions.has("mention-everyone")).toBe(false);
		expect(after.permissions.has("send-messages")).toBe(false);
		expect(after.permissions.has("view-channel")).toBe(true);

		// The rows were replaced, not merged: three targets became two, and the old allow is not in the table.
		const stored = await channels.findChannelOverwrites(GUILD_ID, CHANNEL_PUBLIC);
		expect(stored.map((entry) => entry.targetId).sort()).toEqual([ROLE_OPS, USER_ONE].sort());
		expect(stored.find((entry) => entry.targetId === ROLE_OPS)?.denyBitfield).toBe(MENTION);

		// R7's other half: a payload that reports an empty set means no overwrites, not "said nothing".
		await arrive(channelUpdated(CHANNEL_PUBLIC, []));
		const bare = await decide(USER_ONE);
		expect(await channels.findChannelOverwrites(GUILD_ID, CHANNEL_PUBLIC)).toEqual([]);
		expect(bare.permissions.has("mention-everyone")).toBe(true);
		expect(bare.permissions.has("send-messages")).toBe(true);
	});

	it("revocation-private-thread-membership-lost: the edge is the door, both ways (R8, R12)", async () => {
		expect((await decide(USER_ONE, PRIVATE_THREAD)).permissions.has("view-channel")).toBe(true);

		await arrive(threadMemberRemoved(USER_ONE));

		const after = await decide(USER_ONE, PRIVATE_THREAD);
		expect(after.status).toBe("empty");
		expect(after.reason).toBe("private-thread-not-admitted");
		expect(after.permissions.bitfield).toBe("0");
		expect(await threadMemberships.findThreadMemberUserIds(GUILD_ID, PRIVATE_THREAD)).toEqual([]);

		// The channel itself is untouched by a thread-edge removal — the denial is scoped to the thread.
		expect((await decide(USER_ONE, CHANNEL_PRIVATE)).permissions.has("view-channel")).toBe(true);

		// And the direction is real: the added event restores the edge, because the registry stores exactly what
		// Discord said rather than inferring membership from the parent channel.
		await arrive(threadMemberAdded(USER_ONE));
		expect((await decide(USER_ONE, PRIVATE_THREAD)).permissions.has("view-channel")).toBe(true);
	});

	/**
	 * The ADR's reconnect case, and the two halves of its sentence are both asserted.
	 *
	 * Four changes are made while the hub is not listening, and one `ResyncGuildStateCommand` run has to
	 * reflect all four: a role's description, a channel's overwrite set, a private thread's member list, and
	 * one member's role set. The other half — the status may call itself `current` only when the run has
	 * completed — needs a registry that is provably *not* current before the run, so the pass starts from a
	 * gap the resync owns: a channel event that said nothing about overwrites leaves the stored set untouched
	 * (R10) and records `channel-pending-rest-fields`, which is exactly the kind a completed resync closes from
	 * the fresh channel read. A gap the resync must not invent an answer for (O1's thread lists) is the next
	 * case, and it stays open.
	 */
	it("resync-after-reconnect: changes made while not listening are reflected, and status reaches current only on completion (R11, R9)", async () => {
		const before = await decide(USER_ONE);
		expect(before.permissions.has("send-messages")).toBe(true);
		expect(before.permissions.has("mention-everyone")).toBe(true);
		expect((await decide(USER_ONE, PRIVATE_THREAD)).permissions.has("view-channel")).toBe(true);
		expect(await status.execute()).toMatchObject({ status: "current" });

		// The registry is deliberately left short of current: a channel event with no overwrite list is not
		// silence about the set, so the stored set stays and the gap is recorded.
		await arrive({
			kind: Kind.channelUpdated,
			guildId: GUILD_ID,
			channelId: CHANNEL_PUBLIC,
			channelType: "guild-text"
		});
		expect(ledger.gapsOf("channel-pending-rest-fields").map((gap) => gap.resourceId)).toContain(CHANNEL_PUBLIC);
		expect((await status.execute()).status).not.toBe("current");

		// Not listening: the subscription is gone, so nothing can arrive to be missed.
		binding.unsubscribe();
		expect(consumer.boundKinds).toEqual([]);

		// The four changes, made on Discord's side only — the registry still holds the pre-change rows.
		const changesMadeWhileNotListening = withRestProgram(
			restProgram({
				roles: [
					role(GUILD_ID, GUILD_ID, EVERYONE_BITS, 0),
					role(GUILD_ID, ROLE_BACKEND, "0", 1),
					role(GUILD_ID, ROLE_OPS, MENTION, 2)
				],
				channels: [
					channel(GUILD_ID, CHANNEL_PUBLIC, {
						position: 1,
						permissionOverwrites: [overwrite(ROLE_OPS, "role", "0", MENTION)]
					}),
					channel(GUILD_ID, CHANNEL_PRIVATE, {
						position: 2,
						permissionOverwrites: [
							overwrite(USER_ONE, "member", VIEW, "0"),
							overwrite(GUILD_ID, "role", "0", VIEW)
						]
					}),
					thread(GUILD_ID, PRIVATE_THREAD, CHANNEL_PRIVATE, "private-thread", {
						position: 3,
						permissionOverwrites: []
					})
				],
				roster: completeRoster(GUILD_ID, [
					member(GUILD_ID, USER_ONE, [ROLE_OPS]),
					member(GUILD_ID, USER_TWO, [])
				]),
				threadMembers: { [PRIVATE_THREAD]: [threadPage(PRIVATE_THREAD, [USER_TWO])] }
			})
		);

		// The gap the event path left behind is declared on the signal, which is the shape T10's orchestration
		// passes: a resync completes the gaps its caller names, from the one read that can answer each.
		const outcome = await changesMadeWhileNotListening.execute({
			epoch: 1,
			reason: "reconnect",
			gaps: [
				{
					kind: "channel-pending-rest-fields",
					resourceId: CHANNEL_PUBLIC,
					reason: "payload-carried-no-overwrite-set",
					pendingFields: ["permissionOverwrites"]
				}
			]
		});
		expect(outcome.bootstrap?.complete).toBe(true);

		// Change 1 and 4: the role's new description and the member's new role set both landed.
		const after = await decide(USER_ONE);
		expect(after.permissions.has("send-messages")).toBe(false);
		expect(after.permissions.has("view-channel")).toBe(true);
		expect(await members.findMembership(GUILD_ID, USER_ONE)).toMatchObject({ roleIds: [ROLE_OPS] });

		// Change 2: the overwrite set the fresh read reported is the whole set — one row, and it denies.
		const stored = await channels.findChannelOverwrites(GUILD_ID, CHANNEL_PUBLIC);
		expect(stored).toHaveLength(1);
		expect(stored[0]?.targetId).toBe(ROLE_OPS);
		expect(stored[0]?.denyBitfield).toBe(MENTION);
		expect(after.permissions.has("mention-everyone")).toBe(false);

		// Change 3: the thread's member list is Discord's list now, not the one the registry remembered.
		expect(await threadMemberships.findThreadMemberUserIds(GUILD_ID, PRIVATE_THREAD)).toEqual([USER_TWO]);
		expect(await threadMemberships.findThreadIdsForMember(GUILD_ID, USER_TWO)).toContain(PRIVATE_THREAD);
		expect(await decide(USER_ONE, PRIVATE_THREAD)).toMatchObject({
			status: "empty",
			reason: "private-thread-not-admitted"
		});

		// The gap the run started from is closed by the read that could answer it, and only now is the
		// registry allowed to say `current`.
		expect(outcome.resolvedGaps.map((gap) => gap.kind)).toContain("channel-pending-rest-fields");
		expect(ledger.gapsOf("channel-pending-rest-fields")).toEqual([]);
		expect(await status.execute()).toMatchObject({ status: "current", gaps: { openGapCount: 0 } });

		// An equal or older epoch answers without touching the registry (R9's replay shape at the run level).
		const rowsBefore = await tableCounts();
		const replayed = await changesMadeWhileNotListening.execute({ epoch: 1, reason: "reconnect" });
		expect(replayed.skipped).toBe(true);
		expect(await tableCounts()).toEqual(rowsBefore);

		// R14: the whole resync transcript is ids, counts and closed-vocabulary reasons.
		expect(logger.transcript()).not.toMatch(/"(roleName|nickname|username|content|token)":/);
	});

	/**
	 * The same run when a private thread's member list cannot be read at all: four parts converge, the fifth
	 * is a fact about what Discord delivers to this Installation, and the status says so instead of rounding
	 * up. O1 is undecided, and this is the shape that keeps it visible (R11's error case).
	 */
	it("resync-after-reconnect keeps the status short of current when a thread member list cannot be read (R11, O1)", async () => {
		binding.unsubscribe();

		const unreadable = withRestProgram(
			restProgram({
				roles: [
					role(GUILD_ID, GUILD_ID, EVERYONE_BITS, 0),
					role(GUILD_ID, ROLE_BACKEND, "0", 1),
					role(GUILD_ID, ROLE_OPS, MENTION, 2)
				],
				roster: completeRoster(GUILD_ID, [
					member(GUILD_ID, USER_ONE, [ROLE_OPS]),
					member(GUILD_ID, USER_TWO, [])
				]),
				threadMembers: {}
			})
		);

		const outcome = await unreadable.execute({ epoch: 1, reason: "reconnect" });

		// The changes that a read can answer still converged, in the same run that could not answer this one.
		expect(await decide(USER_ONE)).toMatchObject({ status: "evaluated" });
		expect((await decide(USER_ONE)).permissions.has("send-messages")).toBe(false);

		// …and the unobservable list is reported as an open gap, never closed by an assumed membership.
		expect(outcome.openGaps.map((gap) => gap.kind)).toContain("thread-members-unreadable");
		expect((await status.execute()).status).not.toBe("current");
		expect(logger.transcript()).toContain("thread-members");
	});

	/**
	 * T10 closed the leg this file used to pin as a gap. A member who left during the outage is *absent* from the
	 * fresh roster, and absence is exactly what the convergence sweep diffs: the bootstrap pass upserts what the
	 * read returned, and {@link SweepVanishedStateCommand} then ends the memberships the complete read no longer
	 * names, through R4's own cascade — role links, member-targeted overwrites and thread edges included.
	 *
	 * The assertion is the ADR's sentence, not the mechanism: the row is gone, every grant that named it is gone,
	 * and the next decision refuses. The member the roster still reports is untouched, because a sweep that also
	 * removed present members would be a revocation the provider never asked for.
	 */
	it("resync-after-reconnect ends a membership that vanished from the roster during the outage (R11, R4)", async () => {
		expect((await decide(USER_ONE)).permissions.has("view-channel")).toBe(true);
		expect(await members.findMembership(GUILD_ID, USER_ONE)).not.toBeNull();
		const linksBefore = await database.countRows("guild_membership_role");
		const edgesBefore = await database.countRows("thread_membership");
		const memberOverwriteBefore = await database.countRows("channel_permission_overwrite");

		binding.unsubscribe();
		const vanishedMember = withRestProgram(
			restProgram({
				roster: completeRoster(GUILD_ID, [member(GUILD_ID, USER_TWO, [])]),
				// The thread list still names the departed member — a lagging API answer, and the reason the
				// revocation must come from R4's cascade rather than from hoping the list was already corrected.
				threadMembers: { [PRIVATE_THREAD]: [threadPage(PRIVATE_THREAD, [USER_ONE])] }
			})
		);

		const outcome = await vanishedMember.execute({ epoch: 1, reason: "reconnect" });
		expect(outcome.bootstrap?.complete).toBe(true);
		// The sweep reported its own work in counts, which is what R14 lets a log carry (R11).
		expect(outcome.sweep).toMatchObject({ removedMemberships: 1 });

		expect(await members.findMembership(GUILD_ID, USER_ONE)).toBeNull();
		expect(await decide(USER_ONE)).toMatchObject({ status: "empty", reason: "membership-not-registered" });
		expect(await decide(USER_ONE, PRIVATE_THREAD)).toMatchObject({ reason: "membership-not-registered" });

		// The cascade reached the dependent rows, in the resync path exactly as an event would have.
		expect(await database.countRows("guild_membership")).toBe(1);
		expect(await database.countRows("guild_membership_role")).toBeLessThan(linksBefore);
		expect(await database.countRows("channel_permission_overwrite")).toBeLessThan(memberOverwriteBefore);
		// The thread edge the read had just written went with the membership, not with the list: an edge naming
		// a member the Guild no longer has is not a door (R4, R8).
		expect(await database.countRows("thread_membership")).toBe(edgesBefore - 1);
		expect(await threadMemberships.findThreadMemberUserIds(GUILD_ID, PRIVATE_THREAD)).toEqual([]);

		// The overwrite that named the departed member is gone rather than surviving as an inert grant.
		const storedOverwrites = await channels.findChannelOverwrites(GUILD_ID, CHANNEL_PRIVATE);
		expect(storedOverwrites.map((entry) => entry.targetId)).not.toContain(USER_ONE);

		// The member the roster still reports is untouched, and the resync converged to `current` on the way.
		expect(await members.findMembership(GUILD_ID, USER_TWO)).not.toBeNull();
		expect(await decide(USER_TWO)).toMatchObject({ status: "evaluated" });
		expect(await status.execute()).toMatchObject({ status: "current" });

		// A replay of the same signal against the same state removes nothing a second time (R9): the diff is
		// recomputed from the rows, and the rows are already gone.
		const rowsBefore = await tableCounts();
		const replayed = await vanishedMember.execute({ epoch: 2, reason: "reconnect" });
		expect(replayed.skipped).toBe(false);
		expect(replayed.sweep).toMatchObject({ removedMemberships: 0, removedRoles: 0, removedChannels: 0 });
		expect(await tableCounts()).toEqual(rowsBefore);

		// R14: the sweep's transcript is ids and counts.
		expect(logger.transcript()).toContain(USER_ONE);
		expect(logger.transcript()).not.toMatch(/"(roleName|nickname|username|content|token)":/);
	});

	/**
	 * The absolute half of the same rule: a roster that stopped at its page bound is a partial read, and a
	 * partial read is not a departure list. Sweeping it would end every member past the bound — a mass revocation
	 * invented out of a pagination limit — so the sweep refuses, reports the refusal, and the `roster-truncated`
	 * gap is what keeps the registry from ever claiming `current` (R2, R11).
	 */
	it("a truncated roster sweeps no membership, records the gap and holds the status short of current (R2, R11)", async () => {
		expect((await decide(USER_ONE)).permissions.has("view-channel")).toBe(true);

		binding.unsubscribe();
		const truncated = withRestProgram(
			restProgram({
				roster: {
					guildId: GUILD_ID,
					// Only one of the two members arrived before the bound stopped the read.
					members: [member(GUILD_ID, USER_TWO, [])],
					pages: 20,
					complete: false,
					truncatedBy: "page-limit"
				}
			})
		);

		const outcome = await truncated.execute({ epoch: 1, reason: "reconnect" });

		expect(outcome.bootstrap?.complete).toBe(false);
		expect(outcome.sweep).toMatchObject({ removedMemberships: 0 });
		expect(outcome.sweep?.skipped).toEqual([{ target: "memberships", reason: "roster-truncated" }]);
		expect(outcome.openGaps.map((gap) => gap.kind)).toContain("roster-truncated");
		expect(outcome.anomalyCounts["roster-truncated"]).toBe(1);

		// The member past the bound keeps their row: the refusal is the whole point of the case.
		expect(await members.findMembership(GUILD_ID, USER_ONE)).not.toBeNull();
		expect((await decide(USER_ONE)).status).toBe("evaluated");

		// Never `current`, by either route: the pending roster part answers first, and the gap holds it there.
		expect(outcome.status).not.toBe("current");
		expect(outcome.status).toBe("incomplete");
		expect((await status.execute()).status).not.toBe("current");
	});

	/**
	 * A role deleted while the hub was not listening. R3's cascade is the same command the event path drives, so
	 * the swept row loses its bit, its member links and the overwrites that named it — the stale-overwrite
	 * argument R3 makes, applied to the convergence path.
	 */
	it("resync-after-reconnect sweeps a role that was deleted during the outage, through R3's cascade (R11, R3)", async () => {
		expect((await decide(USER_ONE)).permissions.has("send-messages")).toBe(true);
		const overwriteTargetingRole = await channels.findChannelOverwrites(GUILD_ID, CHANNEL_PUBLIC);
		expect(overwriteTargetingRole.map((entry) => entry.targetId)).toContain(ROLE_BACKEND);

		binding.unsubscribe();
		const roleGone = withRestProgram(
			restProgram({
				roles: [role(GUILD_ID, GUILD_ID, EVERYONE_BITS, 0), role(GUILD_ID, ROLE_OPS, MENTION, 2)],
				roster: completeRoster(GUILD_ID, [
					member(GUILD_ID, USER_ONE, [ROLE_OPS]),
					member(GUILD_ID, USER_TWO, [])
				])
			})
		);

		const outcome = await roleGone.execute({ epoch: 1, reason: "reconnect" });

		expect(outcome.sweep).toMatchObject({ removedRoles: 1, removedMemberships: 0 });
		expect(outcome.sweep?.dependentRowsRemoved).toBeGreaterThan(0);
		expect(await roles.findRolePermissions(GUILD_ID, [ROLE_BACKEND])).toEqual([]);
		const after = await decide(USER_ONE);
		expect(after.permissions.has("send-messages")).toBe(false);
		expect(after.permissions.has("mention-everyone")).toBe(true);
		// The overwrite that granted the deleted role is gone, not left behind as an inert argument (R3).
		expect(
			(await channels.findChannelOverwrites(GUILD_ID, CHANNEL_PUBLIC)).map((entry) => entry.targetId)
		).not.toContain(ROLE_BACKEND);
		expect(await database.countRows("guild_role")).toBe(2);
		expect(await status.execute()).toMatchObject({ status: "current" });
	});

	/**
	 * A channel deleted during the outage, with its thread: R6's cascade takes the overwrite rows, the child
	 * threads and the thread edges with the row, so a re-read cannot hand access to a channel that is gone.
	 */
	it("resync-after-reconnect sweeps a channel that was deleted during the outage, through R6's cascade (R11, R6)", async () => {
		expect((await decide(USER_ONE, CHANNEL_PRIVATE)).permissions.has("view-channel")).toBe(true);
		expect(await channels.findChannel(GUILD_ID, CHANNEL_PRIVATE)).not.toBeNull();

		binding.unsubscribe();
		const channelGone = withRestProgram(
			restProgram({
				channels: [
					channel(GUILD_ID, CHANNEL_PUBLIC, {
						position: 1,
						permissionOverwrites: [
							overwrite(ROLE_BACKEND, "role", MENTION, "0"),
							overwrite(GUILD_ID, "role", "0", "0")
						]
					})
				]
			})
		);

		const outcome = await channelGone.execute({ epoch: 1, reason: "reconnect" });

		// The thread went with its parent's cascade, so two rows are gone and the count is what the registry lost.
		expect(outcome.sweep).toMatchObject({ removedChannels: 1, removedRoles: 0, removedMemberships: 0 });
		expect(await channels.findChannel(GUILD_ID, CHANNEL_PRIVATE)).toBeNull();
		expect(await channels.findChannel(GUILD_ID, PRIVATE_THREAD)).toBeNull();
		expect(await database.countRows("channel")).toBe(1);
		expect(await channels.findChannelOverwrites(GUILD_ID, CHANNEL_PRIVATE)).toEqual([]);
		expect(await threadMemberships.findThreadMemberUserIds(GUILD_ID, PRIVATE_THREAD)).toEqual([]);
		expect((await decide(USER_ONE, CHANNEL_PRIVATE)).permissions.has("view-channel")).toBe(false);
		expect((await listForUser.execute({ userId: USER_ONE })).channels.map((entry) => entry.channelId)).toEqual([
			CHANNEL_PUBLIC
		]);
	});

	/**
	 * The no-op half, which is why a first bootstrap needs no branch and no guard: nothing is stored, so nothing
	 * can be vanished. The diff is empty by construction rather than skipped by a special case (R9, R11).
	 */
	it("a resync over an empty registry sweeps nothing, because there is nothing to sweep (R9, R11)", async () => {
		await database.resetRegistry();

		const fresh = withRestProgram(restProgram());
		const outcome = await fresh.execute({ epoch: 1, reason: "reconnect" });

		expect(outcome.bootstrap?.complete).toBe(true);
		expect(outcome.sweep).toMatchObject({ removedMemberships: 0, removedRoles: 0, removedChannels: 0 });
		expect(outcome.sweep?.skipped).toEqual([]);
		// Every row in the tables is a row the read reported, and none was removed on the way.
		expect(await tableCounts()).toMatchObject({ guild: 1, guild_role: 3, guild_membership: 2, channel: 3 });
		expect(await database.countRows("thread_membership")).toBe(1);
		expect(await status.execute()).toMatchObject({ status: "current" });
	});
});
