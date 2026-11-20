import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DiscordGuildSnapshot, DiscordRoleRecord } from "../../../src/features/discord/index.js";
import { InMemoryBootstrapStateTracker } from "../../../src/features/guild-state/bootstrap/in-memory-bootstrap-state.js";
import { InMemoryGuildResyncLedger } from "../../../src/features/guild-state/bootstrap/in-memory-resync-ledger.js";
import { ApplyGuildBootstrapCommand } from "../../../src/features/guild-state/commands/apply-guild-bootstrap.command.js";
import { ApplyMemberUpdateCommand } from "../../../src/features/guild-state/commands/apply-member-update.command.js";
import { ApplyThreadMembershipChangeCommand } from "../../../src/features/guild-state/commands/apply-thread-membership-change.command.js";
import { DeleteChannelCommand } from "../../../src/features/guild-state/commands/delete-channel.command.js";
import { DeleteRoleCommand } from "../../../src/features/guild-state/commands/delete-role.command.js";
import { EndMembershipCommand } from "../../../src/features/guild-state/commands/end-membership.command.js";
import { ResyncGuildStateCommand } from "../../../src/features/guild-state/commands/resync-guild-state.command.js";
import { SweepVanishedStateCommand } from "../../../src/features/guild-state/commands/sweep-vanished-state.command.js";
import { UpsertChannelCommand } from "../../../src/features/guild-state/commands/upsert-channel.command.js";
import { UpsertRoleCommand } from "../../../src/features/guild-state/commands/upsert-role.command.js";
import { createGuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import type { GuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import { EvaluateEffectivePermissionsQuery } from "../../../src/features/guild-state/queries/evaluate-effective-permissions.query.js";
import { GetGuildIdentityQuery } from "../../../src/features/guild-state/queries/get-guild-identity.query.js";
import { GetGuildStateStatusQuery } from "../../../src/features/guild-state/queries/get-guild-state-status.query.js";
import { GetMembershipStatusQuery } from "../../../src/features/guild-state/queries/get-membership-status.query.js";
import { ListIngestibleChannelsQuery } from "../../../src/features/guild-state/queries/list-ingestible-channels.query.js";
import { ListUserAccessibleChannelsQuery } from "../../../src/features/guild-state/queries/list-user-accessible-channels.query.js";
import type { DiscordIdentifier } from "../../../src/features/guild-state/models/domain/discord-identifier.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import { RecordingRegistries } from "./fakes/recording-registry-repositories.js";
import {
	FakePermissionSnapshotRepository,
	channelRow,
	membershipRow,
	snapshotFixture
} from "./fakes/permission-snapshot-fixture.js";
import {
	FakeGuildStateGateway,
	channel,
	completeRoster,
	member,
	role,
	thread
} from "./fakes/fake-guild-state-gateway.js";
import type { FakeGatewayProgram } from "./fakes/fake-guild-state-gateway.js";

/**
 * T9c — guild isolation and log safety, consolidated over the whole feature
 * (`docs/features/guild-state.md` R1 and R14; `odd/tasks/guild-state.md` T9c).
 *
 * Each rule file proves its own use case. Two properties belong to the feature rather than to any single use
 * case, so they are proven here, where a new surface cannot slip past them:
 *
 * 1. **No write surface accepts another Guild's data, and no read surface returns it.** Every command appears
 *    in one table below, which is how "the tenth command has no negative case" becomes a failure instead of a
 *    silent omission. The read half needs its own cases: a registry that holds a row naming another Guild —
 *    through a bug, a restore, or a hand-edited table — must still answer for the configured Guild only,
 *    because R1's error case is about a grant, and a grant is produced on the read side.
 * 2. **The whole log transcript is clean, not only the lines someone remembered to check.** One run touches
 *    every surface with adversarial display data in every field that can carry it, and the assertion is on the
 *    assembled transcript. R14 is a property of aggregate output, so it is scanned against aggregate output.
 *
 * The sentinels are planted rather than assumed: a scan that never fed the feature a name proves nothing about
 * names. `Sentinel-` strings appear nowhere in the feature's vocabulary, so a single hit names the leak.
 */

const GUILD_ID: DiscordIdentifier = "180000000000000001";
const OTHER_GUILD_ID: DiscordIdentifier = "180000000000000999";
const ROLE_BACKEND: DiscordIdentifier = "180000000000000010";
const ROLE_OPS: DiscordIdentifier = "180000000000000011";
const ROLE_UNKNOWN: DiscordIdentifier = "180000000000000077";
const USER_ONE: DiscordIdentifier = "180000000000000101";
const USER_TWO: DiscordIdentifier = "180000000000000102";
const CHANNEL_PUBLIC: DiscordIdentifier = "180000000000000201";
const CHANNEL_PARENT: DiscordIdentifier = "180000000000000202";
const THREAD_PRIVATE: DiscordIdentifier = "180000000000000203";
const THREAD_UNKNOWN: DiscordIdentifier = "180000000000000204";
const FOREIGN_CHANNEL: DiscordIdentifier = "180000000000000299";

const VIEW = "1024";
const SEND = "2048";
const VIEW_AND_SEND = String(BigInt(VIEW) | BigInt(SEND));

/* ---------------------------------------------------------------- adversarial display data (R14) */

const SENTINEL = Object.freeze({
	guildName: "Sentinel-Guild-Name",
	roleName: "Sentinel-Role-Name",
	channelName: "Sentinel-Channel-Name",
	threadName: "Sentinel-Thread-Name",
	nickname: "Sentinel-Nickname",
	username: "Sentinel-Username",
	content: "Sentinel-Message-Content",
	attachment: "Sentinel-Attachment-Url",
	token: "Sentinel-Bot-Token",
	avatar: "Sentinel-Avatar-Url"
});

const ALL_SENTINELS: readonly string[] = Object.values(SENTINEL);

/**
 * Member display data, message content and a credential are the values R14 forbids *anywhere*; role, channel
 * and Guild names are values R3/R6 require in a column and R14 forbids in a log. Both halves are in the
 * fixture, so the two scans can tell them apart.
 */
function adversarialProgram(): FakeGatewayProgram {
	const roles: readonly DiscordRoleRecord[] = [
		role(GUILD_ID, GUILD_ID, "0", 0),
		{ ...role(GUILD_ID, ROLE_BACKEND, VIEW, 1), name: SENTINEL.roleName },
		role(GUILD_ID, ROLE_OPS, SEND, 2)
	];
	return {
		snapshot: { guildId: GUILD_ID, name: SENTINEL.guildName } satisfies DiscordGuildSnapshot,
		roles,
		channels: [
			channel(GUILD_ID, CHANNEL_PARENT, { name: SENTINEL.channelName, position: 1 }),
			channel(GUILD_ID, CHANNEL_PUBLIC, { name: SENTINEL.channelName, position: 2 }),
			thread(GUILD_ID, THREAD_PRIVATE, CHANNEL_PARENT, "private-thread", { name: SENTINEL.threadName })
		],
		roster: completeRoster(GUILD_ID, [
			member(GUILD_ID, USER_ONE, [ROLE_BACKEND], { nickname: SENTINEL.nickname, username: SENTINEL.username }),
			member(GUILD_ID, USER_TWO, [], { username: SENTINEL.username, nickname: SENTINEL.nickname })
		])
	};
}

/* ---------------------------------------------------------------------------- composition */

/**
 * What every write surface reports about the event it was handed: the outcome status, the configured Guild the
 * outcome names, and — for the resync run alone — whether the pass was skipped. These three facts are what the
 * isolation assertion below reads, so the table names them: `Record<string, unknown>` could not carry them,
 * because an interface-typed outcome has no implicit index signature.
 */
interface SurfaceOutcome {
	readonly status: string;
	readonly guildId: string;
	readonly skipped?: boolean;
}

interface FeatureScope {
	readonly config: GuildStateConfig;
	readonly logger: RecordingLogger;
	readonly registries: RecordingRegistries;
	readonly ledger: InMemoryGuildResyncLedger;
	readonly gateway: FakeGuildStateGateway;
	readonly snapshots: FakePermissionSnapshotRepository;
	readonly bootstrap: ApplyGuildBootstrapCommand;
	readonly resync: ResyncGuildStateCommand;
	readonly upsertRole: UpsertRoleCommand;
	readonly deleteRole: DeleteRoleCommand;
	readonly applyMemberUpdate: ApplyMemberUpdateCommand;
	readonly endMembership: EndMembershipCommand;
	readonly upsertChannel: UpsertChannelCommand;
	readonly deleteChannel: DeleteChannelCommand;
	readonly threadMembership: ApplyThreadMembershipChangeCommand;
	readonly evaluate: EvaluateEffectivePermissionsQuery;
	readonly identity: GetGuildIdentityQuery;
	readonly membershipStatus: GetMembershipStatusQuery;
	readonly accessibleChannels: ListUserAccessibleChannelsQuery;
	readonly ingestibleChannels: ListIngestibleChannelsQuery;
	readonly status: GetGuildStateStatusQuery;
}

function featureScope(program: FakeGatewayProgram = {}): FeatureScope {
	const config = createGuildStateConfig({ guildId: GUILD_ID });
	const logger = new RecordingLogger();
	const registries = new RecordingRegistries();
	const ledger = new InMemoryGuildResyncLedger({ guildId: GUILD_ID });
	const tracker = new InMemoryBootstrapStateTracker({ guildId: GUILD_ID });
	const gateway = new FakeGuildStateGateway(program, GUILD_ID);
	const snapshots = new FakePermissionSnapshotRepository({
		snapshot: snapshotFixture({ guildId: GUILD_ID, userId: USER_ONE, everyone: VIEW })
	});

	const bootstrap = new ApplyGuildBootstrapCommand({
		config,
		gateway,
		tracker,
		guildRegistry: registries.guildsContract,
		roleRegistry: registries.rolesContract,
		channelRegistry: registries.channelsContract,
		membershipRegistry: registries.membershipsContract,
		threadMembershipRegistry: registries.threadMembershipsContract,
		logger
	});
	const upsertRole = new UpsertRoleCommand({ config, roleRegistry: registries.rolesContract, logger });
	const deleteRole = new DeleteRoleCommand({ config, roleRegistry: registries.rolesContract, logger });
	const deleteChannel = new DeleteChannelCommand({ config, channelRegistry: registries.channelsContract, logger });
	// The production sweep, on the same doubles: its R1 branch and its log lines are part of what this file scans.
	const sweep = new SweepVanishedStateCommand({
		config,
		membershipRegistry: registries.membershipsContract,
		roleRegistry: registries.rolesContract,
		channelRegistry: registries.channelsContract,
		deleteRoleCommand: deleteRole,
		deleteChannelCommand: deleteChannel,
		logger
	});

	return {
		config,
		logger,
		registries,
		ledger,
		gateway,
		snapshots,
		bootstrap,
		resync: new ResyncGuildStateCommand({
			config,
			gateway,
			tracker,
			ledger,
			bootstrapCommand: bootstrap,
			upsertRoleCommand: upsertRole,
			sweepCommand: sweep,
			roleRegistry: registries.rolesContract,
			channelRegistry: registries.channelsContract,
			logger
		}),
		upsertRole,
		deleteRole,
		applyMemberUpdate: new ApplyMemberUpdateCommand({
			config,
			roleRegistry: registries.rolesContract,
			membershipRegistry: registries.membershipsContract,
			logger
		}),
		endMembership: new EndMembershipCommand({ config, membershipRegistry: registries.membershipsContract, logger }),
		upsertChannel: new UpsertChannelCommand({ config, channelRegistry: registries.channelsContract, logger }),
		deleteChannel,
		threadMembership: new ApplyThreadMembershipChangeCommand({
			config,
			channelRegistry: registries.channelsContract,
			threadMembershipRegistry: registries.threadMembershipsContract,
			logger
		}),
		evaluate: new EvaluateEffectivePermissionsQuery({ config, snapshot: snapshots, logger }),
		identity: new GetGuildIdentityQuery({ config, guildRegistry: registries.guildsContract, logger }),
		membershipStatus: new GetMembershipStatusQuery({
			config,
			membershipRegistry: registries.membershipsContract,
			logger
		}),
		accessibleChannels: new ListUserAccessibleChannelsQuery({ config, snapshot: snapshots, logger }),
		ingestibleChannels: new ListIngestibleChannelsQuery({ config, snapshot: snapshots, logger }),
		status: new GetGuildStateStatusQuery({
			config,
			tracker,
			ledger,
			guildRegistry: registries.guildsContract,
			logger
		})
	};
}

const EMPTY_REGISTRY = Object.freeze({
	guild: null,
	roles: [],
	memberships: [],
	channels: [],
	overwrites: [],
	threadMemberships: []
});

describe("guild-state guild isolation (T9c, R1)", () => {
	/**
	 * Every surface that can change registry state. `resync` is in the table because its input carries a Guild
	 * id of its own — a signal about another Guild is a signal this hub must not act on, even though the
	 * configured Guild would be re-read anyway.
	 */
	const writeSurfaces: readonly (readonly [string, (scope: FeatureScope) => Promise<SurfaceOutcome>])[] = [
		[
			"upsert-role",
			(scope) =>
				scope.upsertRole.execute({
					guildId: OTHER_GUILD_ID,
					roleId: ROLE_BACKEND,
					roleName: SENTINEL.roleName,
					permissionsBitfield: VIEW
				})
		],
		["delete-role", (scope) => scope.deleteRole.execute({ guildId: OTHER_GUILD_ID, roleId: ROLE_BACKEND })],
		[
			"apply-member-update",
			(scope) =>
				scope.applyMemberUpdate.execute({ guildId: OTHER_GUILD_ID, userId: USER_ONE, roleIds: [ROLE_BACKEND] })
		],
		["end-membership", (scope) => scope.endMembership.execute({ guildId: OTHER_GUILD_ID, userId: USER_ONE })],
		[
			"upsert-channel",
			(scope) =>
				scope.upsertChannel.execute({
					guildId: OTHER_GUILD_ID,
					channelId: CHANNEL_PUBLIC,
					channelType: "guild-text",
					name: SENTINEL.channelName
				})
		],
		[
			"upsert-channel carrying an overwrite set",
			(scope) =>
				scope.upsertChannel.execute({
					guildId: OTHER_GUILD_ID,
					channelId: CHANNEL_PARENT,
					channelType: "guild-text",
					permissionOverwrites: [
						{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: SEND, denyBitfield: "0" }
					]
				})
		],
		[
			"delete-channel",
			(scope) => scope.deleteChannel.execute({ guildId: OTHER_GUILD_ID, channelId: CHANNEL_PUBLIC })
		],
		[
			"apply-thread-membership-change",
			(scope) =>
				scope.threadMembership.execute({
					guildId: OTHER_GUILD_ID,
					threadId: THREAD_PRIVATE,
					userId: USER_ONE,
					change: "added"
				})
		],
		[
			"resync-guild-state",
			(scope) => scope.resync.execute({ epoch: 1, guildId: OTHER_GUILD_ID, reason: "reconnect" })
		]
	];

	it("keeps the write-surface table in step with the commands the feature exposes (R1 coverage)", () => {
		// The table is a list on purpose: a tenth command has to be added here with its own case to pass, and
		// the list below is what a reviewer compares against `commands/`.
		expect(writeSurfaces.map(([name]) => name)).toEqual([
			"upsert-role",
			"delete-role",
			"apply-member-update",
			"end-membership",
			"upsert-channel",
			"upsert-channel carrying an overwrite set",
			"delete-channel",
			"apply-thread-membership-change",
			"resync-guild-state"
		]);
	});

	it("has a foreign-Guild branch in every command source file, with no file unaccounted for (R1)", () => {
		const commandDirectory = join(process.cwd(), "src", "features", "guild-state", "commands");
		const sources = readdirSync(commandDirectory)
			.filter((entry) => entry.endsWith(".command.ts"))
			.map((entry) => ({ name: entry, text: readFileSync(join(commandDirectory, entry), "utf8") }));

		expect(sources.length).toBeGreaterThanOrEqual(9);
		for (const source of sources) {
			// Two shapes of the same rule. A command takes a Guild id in its input, so it carries the closed
			// `foreign-guild` reason; the bootstrap takes none, so its guard sits on what the read came back
			// naming, and refusing the whole pass is the drop.
			const guardsR1 = source.text.includes('"foreign-guild"') || source.text.includes("requireConfiguredGuild");
			expect(guardsR1, source.name).toBe(true);
		}
		// Every command file's class is reachable from the table above or from the subscription binding.
		expect(sources.map((source) => source.name).sort()).toEqual([
			"apply-guild-bootstrap.command.ts",
			"apply-member-update.command.ts",
			"apply-thread-membership-change.command.ts",
			"delete-channel.command.ts",
			"delete-role.command.ts",
			"end-membership.command.ts",
			"resync-guild-state.command.ts",
			// The convergence sweep has no event input to carry a foreign id, so its guard sits on the id the
			// resync hands it — the same refusal, reached from the other side.
			"sweep-vanished-state.command.ts",
			"upsert-channel.command.ts",
			"upsert-role.command.ts"
		]);
	});

	for (const [name, drive] of writeSurfaces) {
		it(`"${name}" given another Guild's id writes no row and says so (R1)`, async () => {
			const scope = featureScope();

			const outcome = await drive(scope);

			// Nothing reached the repository, not even a partially-applied write: the doubles record every
			// statement they are asked to run.
			expect(scope.registries.writes, name).toEqual([]);
			expect(scope.registries.state(), name).toEqual(EMPTY_REGISTRY);

			// The surface reported the drop instead of quietly succeeding.
			const dropped = outcome["status"] === "dropped" || outcome["skipped"] === true;
			expect(dropped, name).toBe(true);
			expect(outcome["guildId"], name).toBe(GUILD_ID);
			expect(JSON.stringify(outcome), name).toContain("foreign-guild");
		});
	}

	/**
	 * The event commands report a foreign drop on their own outcome and the subscription binding counts it on
	 * the ledger (proven in `guild-state-event-subscription.test.ts`). The resync signal is the surface that
	 * counts it itself, because it owns the ledger — and a counted anomaly is what keeps the status honest.
	 */
	it("counts a foreign resync signal as an anomaly and leaves the ledger's state otherwise intact (R1, R11)", async () => {
		const scope = featureScope(adversarialProgram());
		await scope.bootstrap.execute();
		const readsBefore = scope.gateway.readNames();
		const gapsBefore = JSON.stringify(scope.ledger.snapshot().openGaps);

		const outcome = await scope.resync.execute({ epoch: 1, guildId: OTHER_GUILD_ID, reason: "reconnect" });

		expect(outcome.skipped).toBe(true);
		expect(scope.ledger.snapshot().anomalyCounts["foreign-guild"]).toBe(1);
		// Nothing was read and nothing moved: the anomaly is the only effect.
		expect(scope.gateway.readNames()).toEqual(readsBefore);
		expect(JSON.stringify(scope.ledger.snapshot().openGaps)).toBe(gapsBefore);
	});

	it("names both ids and the operation in a foreign drop, and nothing else (R1, R14)", async () => {
		const scope = featureScope();

		await scope.upsertRole.execute({
			guildId: OTHER_GUILD_ID,
			roleId: ROLE_BACKEND,
			roleName: SENTINEL.roleName,
			permissionsBitfield: VIEW
		});

		const drops = scope.logger.lines.filter((line) => line.message.includes("another guild"));
		expect(drops).toHaveLength(1);
		expect(drops[0]?.fields).toEqual({
			guildId: GUILD_ID,
			eventGuildId: OTHER_GUILD_ID,
			roleId: ROLE_BACKEND,
			operation: "upsert-role"
		});
		expect(scope.logger.transcript()).not.toContain(SENTINEL.roleName);
	});

	it("refuses a bootstrap whose Guild read names another Guild, before any part runs (R1, R2)", async () => {
		const scope = featureScope({ snapshot: { guildId: OTHER_GUILD_ID, name: SENTINEL.guildName } });

		await expect(scope.bootstrap.execute()).rejects.toThrow(/guild/i);

		// The pass stops at the first read: no role, channel or roster is asked for, and no row is written.
		expect(scope.gateway.readNames()).toEqual(["guild"]);
		expect(scope.registries.writes).toEqual([]);
		expect(scope.registries.state()).toEqual(EMPTY_REGISTRY);
		expect(JSON.stringify(scope.logger.lines)).toContain(OTHER_GUILD_ID);
	});

	it("writes the configured Guild's id on every row a full pass stores (R1)", async () => {
		const scope = featureScope(adversarialProgram());

		await scope.bootstrap.execute();

		const state = scope.registries.state();
		expect(state.guild?.guildId).toBe(GUILD_ID);
		expect(state.roles.length).toBeGreaterThan(1);
		expect(state.memberships.length).toBe(2);
		expect(state.channels.length).toBe(3);
		for (const record of [...state.roles, ...state.memberships, ...state.channels]) {
			expect(record.guildId).toBe(GUILD_ID);
		}
		expect(JSON.stringify(state)).not.toContain(OTHER_GUILD_ID);
	});

	/* --------------------------------------------------------------------------- read side */

	it("asks every read surface for the configured Guild, never for a caller's (R1, R13)", async () => {
		const scope = featureScope(adversarialProgram());
		await scope.bootstrap.execute();

		await scope.evaluate.execute({ userId: USER_ONE, channelId: CHANNEL_PUBLIC });
		await scope.accessibleChannels.execute({ userId: USER_ONE });
		await scope.ingestibleChannels.execute({ botUserId: USER_ONE });

		expect(scope.snapshots.requests.length).toBe(3);
		for (const request of scope.snapshots.requests) {
			expect(request.guildId).toBe(GUILD_ID);
		}
		await expect(scope.identity.execute()).resolves.toMatchObject({
			status: "registered",
			guild: { guildId: GUILD_ID }
		});
		await expect(scope.membershipStatus.execute({ userId: USER_ONE })).resolves.toMatchObject({
			guildId: GUILD_ID
		});
		await expect(scope.status.execute()).resolves.toMatchObject({ guildId: GUILD_ID });
	});

	it("evaluates a channel row naming another Guild as absent, never as a grant (R1 error case)", async () => {
		const scope = featureScope();
		scope.snapshots.setSnapshot(
			snapshotFixture({
				guildId: GUILD_ID,
				userId: USER_ONE,
				everyone: VIEW,
				channels: [channelRow(GUILD_ID, CHANNEL_PUBLIC), channelRow(OTHER_GUILD_ID, FOREIGN_CHANNEL)]
			})
		);

		const own = await scope.evaluate.execute({ userId: USER_ONE, channelId: CHANNEL_PUBLIC });
		expect(own.status).toBe("evaluated");
		expect(own.permissions.has("view-channel")).toBe(true);

		const foreign = await scope.evaluate.execute({ userId: USER_ONE, channelId: FOREIGN_CHANNEL });
		expect(foreign.status).toBe("empty");
		expect(foreign.reason).toBe("channel-not-registered");
		expect(foreign.permissions.bitfield).toBe("0");
	});

	it("lists nothing of another Guild's rows, on either list surface (R1)", async () => {
		const scope = featureScope();
		scope.snapshots.setSnapshot(
			snapshotFixture({
				guildId: GUILD_ID,
				userId: USER_ONE,
				everyone: VIEW_AND_SEND,
				channels: [channelRow(GUILD_ID, CHANNEL_PUBLIC), channelRow(OTHER_GUILD_ID, FOREIGN_CHANNEL)],
				overwrites: []
			})
		);

		const accessible = await scope.accessibleChannels.execute({ userId: USER_ONE });
		expect(accessible.channels.map((entry) => entry.channelId)).toEqual([CHANNEL_PUBLIC]);
		// The denominator stays honest about what the scan judged; the list is where a grant would appear, and
		// the foreign row never reaches it.
		expect(accessible.evaluatedChannelCount).toBe(2);
		expect(JSON.stringify(accessible)).not.toContain(FOREIGN_CHANNEL);

		const ingestible = await scope.ingestibleChannels.execute({ botUserId: USER_ONE });
		expect(ingestible.channels.map((entry) => entry.channelId)).toEqual([CHANNEL_PUBLIC]);
		// The only place a foreign id can surface is the diagnostic `botCannotViewChannelIds`, which names rows
		// the bot may not ingest — an id, never a grant. In production that list cannot hold a foreign row at
		// all, because the snapshot query filters every row by the configured Guild, which the Postgres
		// integration suite proves against a real table.
		expect(ingestible.botCannotViewChannelIds).not.toContain(CHANNEL_PUBLIC);
		expect(JSON.stringify(ingestible.channels)).not.toContain(FOREIGN_CHANNEL);
	});

	it("reports a Membership row naming another Guild as absent (R1, R4)", async () => {
		const scope = featureScope();
		// Planted two ways, because there are two read paths: a registry row that would answer a status query,
		// and a snapshot row that would answer an evaluation. No command would write either of them, so they go
		// in through the doubles — the state a restore or a hand-edited table produces.
		scope.registries.memberships.set(USER_ONE, {
			guildId: OTHER_GUILD_ID,
			userId: USER_ONE,
			roleIds: [ROLE_BACKEND]
		});
		scope.snapshots.setSnapshot(
			snapshotFixture({
				guildId: GUILD_ID,
				userId: USER_ONE,
				everyone: VIEW,
				channels: [channelRow(GUILD_ID, CHANNEL_PUBLIC)],
				membership: membershipRow(OTHER_GUILD_ID, USER_ONE, [ROLE_BACKEND])
			})
		);

		const result = await scope.membershipStatus.execute({ userId: USER_ONE });
		expect(result.status).toBe("absent");
		expect(result.roleCount).toBe(0);

		const evaluation = await scope.evaluate.execute({ userId: USER_ONE, channelId: CHANNEL_PUBLIC });
		expect(evaluation.status).toBe("empty");
		expect(evaluation.reason).toBe("membership-not-registered");
	});

	it("stores neither of two rows when one event names a parent from another Guild (R1, R6)", async () => {
		const scope = featureScope();

		const outcome = await scope.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL_PUBLIC,
			channelType: "private-thread",
			parentChannelId: FOREIGN_CHANNEL
		});

		expect(outcome.status).toBe("refused");
		expect(scope.registries.channels.has(CHANNEL_PUBLIC)).toBe(false);
		expect(scope.registries.channels.has(FOREIGN_CHANNEL)).toBe(false);
	});
});

describe("guild-state log safety (T9c, R14)", () => {
	/**
	 * One run over every surface: the bootstrap, a resync, each event command's applied, refused and dropped
	 * branch, every query, and the id-and-count fields each of them emits. The display data is in the payloads
	 * that carry display data, so a leak has a value to leak.
	 */
	async function driveEverything(scope: FeatureScope): Promise<void> {
		await scope.bootstrap.execute();
		await scope.resync.execute({ epoch: 1, reason: "reconnect" });

		await scope.upsertRole.execute({
			guildId: GUILD_ID,
			roleId: ROLE_OPS,
			roleName: SENTINEL.roleName,
			permissionsBitfield: SEND
		});
		// R3's error case: an unknown role described incompletely.
		await scope.upsertRole.execute({ guildId: GUILD_ID, roleId: ROLE_UNKNOWN });
		await scope.applyMemberUpdate.execute({
			guildId: GUILD_ID,
			userId: USER_TWO,
			roleIds: [ROLE_BACKEND, ROLE_UNKNOWN]
		});
		await scope.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL_PUBLIC,
			channelType: "guild-text",
			name: SENTINEL.channelName,
			position: 4,
			permissionOverwrites: [
				{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW, denyBitfield: "0" },
				{ targetId: USER_TWO, targetType: "member", allowBitfield: "0", denyBitfield: SEND }
			]
		});
		// R10's boundary: the payload says nothing about overwrites, so the field is named, never valued.
		await scope.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL_PARENT,
			channelType: "guild-text",
			name: SENTINEL.channelName
		});
		// R8's error case: a thread this hub has never heard of.
		await scope.threadMembership.execute({
			guildId: GUILD_ID,
			threadId: THREAD_UNKNOWN,
			userId: USER_ONE,
			change: "added"
		});
		await scope.deleteChannel.execute({ guildId: GUILD_ID, channelId: CHANNEL_PUBLIC });
		await scope.endMembership.execute({ guildId: GUILD_ID, userId: USER_ONE });
		await scope.deleteRole.execute({ guildId: GUILD_ID, roleId: ROLE_BACKEND });

		// The drop branches, so their lines are in the same transcript.
		await scope.upsertRole.execute({ guildId: OTHER_GUILD_ID, roleId: ROLE_OPS, roleName: SENTINEL.roleName });
		await scope.endMembership.execute({ guildId: OTHER_GUILD_ID, userId: USER_ONE });
		await scope.resync.execute({ epoch: 2, guildId: OTHER_GUILD_ID });

		await scope.evaluate.execute({ userId: USER_ONE, channelId: CHANNEL_PARENT });
		await scope.accessibleChannels.execute({ userId: USER_ONE });
		await scope.ingestibleChannels.execute({ botUserId: USER_TWO });
		await scope.membershipStatus.execute({ userId: USER_TWO });
		await scope.identity.execute();
		await scope.status.execute();
	}

	it("emits no display name, nickname, content, attachment or credential anywhere in the transcript", async () => {
		const scope = featureScope(adversarialProgram());
		await driveEverything(scope);

		// Proof the fixture really carried the values, so the scan below has teeth. The ids that survive the run
		// are the ones asserted: the driven deletions take their own rows out of the registry.
		expect(scope.registries.channels.get(CHANNEL_PARENT)?.name).toBe(SENTINEL.channelName);
		expect(scope.registries.roles.get(ROLE_OPS)?.roleName).toBe(SENTINEL.roleName);
		expect(scope.registries.guilds.get("guild")?.guildName).toBe(SENTINEL.guildName);

		const transcript = scope.logger.transcript();
		for (const sentinel of ALL_SENTINELS) {
			expect(transcript, sentinel).not.toContain(sentinel);
		}
		// No field is even *named* after data this feature must not carry, whatever its value was.
		for (const forbiddenKey of [
			"nickname",
			"username",
			"displayName",
			"roleName",
			"guildName",
			"channelName",
			"content",
			"attachment",
			"avatar",
			"token",
			"payload",
			"permissions"
		]) {
			expect(transcript, forbiddenKey).not.toMatch(new RegExp(`"${forbiddenKey}"\\s*:`));
		}
	});

	it("logs ids, counts and field names — the positive half, so a quiet transcript is not the proof (R14)", async () => {
		const scope = featureScope(adversarialProgram());
		await driveEverything(scope);

		const transcript = scope.logger.transcript();
		expect(scope.logger.lines.length).toBeGreaterThan(8);
		expect(transcript).toContain(GUILD_ID);
		expect(transcript).toContain(ROLE_OPS);
		expect(transcript).toContain(THREAD_PRIVATE);
		expect(transcript).toContain("rowsWritten");
		expect(transcript).toContain("permissionOverwrites");
		expect(transcript).toContain("another guild");
		expect(transcript).toContain("incomplete-role-description");
	});

	it("reports a gap by field name and bound, never by the value that is missing (R14, R10)", async () => {
		const scope = featureScope({
			roles: [role(GUILD_ID, ROLE_BACKEND, VIEW, 1)],
			channels: [channel(GUILD_ID, CHANNEL_PUBLIC, { name: SENTINEL.channelName })],
			roster: completeRoster(GUILD_ID, [member(GUILD_ID, USER_ONE, [], { nickname: SENTINEL.nickname })])
		});
		await scope.bootstrap.execute();
		const pending = await scope.upsertChannel.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL_PARENT,
			channelType: "guild-text",
			name: SENTINEL.channelName
		});

		// R10's boundary, named: the payload said nothing about overwrites, so the field is the fact. The
		// binding is what turns this outcome into a ledger gap, and that hop is proven in the subscription test;
		// what belongs to this command is that it carries the field name and no value.
		expect(JSON.stringify(pending)).toContain("permissionOverwrites");
		expect(JSON.stringify(pending)).not.toContain(SENTINEL.channelName);

		const transcript = scope.logger.transcript();
		expect(transcript).toContain("permissionOverwrites");
		expect(transcript).not.toContain(SENTINEL.channelName);
		expect(transcript).not.toContain(SENTINEL.nickname);
	});

	it("stores no member display data, content or credential, so no log line could leak one (R14, O2)", async () => {
		const scope = featureScope(adversarialProgram());
		await scope.bootstrap.execute();

		const stored = JSON.stringify(scope.registries.state());
		for (const neverStored of [
			SENTINEL.nickname,
			SENTINEL.username,
			SENTINEL.content,
			SENTINEL.attachment,
			SENTINEL.token,
			SENTINEL.avatar
		]) {
			expect(stored, neverStored).not.toContain(neverStored);
		}
		// The Membership row is its natural key and the role set, and nothing else.
		expect(scope.registries.memberships.get(USER_ONE)).toEqual({
			guildId: GUILD_ID,
			userId: USER_ONE,
			roleIds: [ROLE_BACKEND]
		});
	});
});
