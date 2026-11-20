import { describe, expect, it } from "vitest";
import { InMemoryBootstrapStateTracker } from "../../../src/features/guild-state/bootstrap/in-memory-bootstrap-state.js";
import { InMemoryGuildResyncLedger } from "../../../src/features/guild-state/bootstrap/in-memory-resync-ledger.js";
import { ApplyGuildBootstrapCommand } from "../../../src/features/guild-state/commands/apply-guild-bootstrap.command.js";
import { DeleteChannelCommand } from "../../../src/features/guild-state/commands/delete-channel.command.js";
import { DeleteRoleCommand } from "../../../src/features/guild-state/commands/delete-role.command.js";
import { ResyncGuildStateCommand } from "../../../src/features/guild-state/commands/resync-guild-state.command.js";
import { SweepVanishedStateCommand } from "../../../src/features/guild-state/commands/sweep-vanished-state.command.js";
import { UpsertRoleCommand } from "../../../src/features/guild-state/commands/upsert-role.command.js";
import { GetGuildStateStatusQuery } from "../../../src/features/guild-state/queries/get-guild-state-status.query.js";
import { createGuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import type { FakeGatewayProgram } from "./fakes/fake-guild-state-gateway.js";
import {
	FakeGuildStateGateway,
	channel,
	completeRoster,
	member,
	role,
	thread,
	threadPage
} from "./fakes/fake-guild-state-gateway.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import { RecordingRegistries } from "./fakes/recording-registry-repositories.js";

/**
 * R2's status rules and R11's stale window, read through the public contract
 * (`docs/features/guild-state.md`; Contracts: "`GetGuildStateStatusQuery` — bootstrap/resync completeness and
 * staleness, for readiness reporting and for the authorization feature's own gating policy").
 *
 * The status is never stored and never assembled twice: the transition suite below drives one tracker and one
 * ledger and asks the query at each step, so `incomplete → current → stale → current` is a property of the
 * same two facts, not of four hand-written answers. The two fail-closed halves are asserted explicitly: a
 * partial read must never be `current` (R11), and a lost Guild outranks a converged part list (R1, R2).
 */

const GUILD_ID = "160000000000000001";
const ROLE_BACKEND = "160000000000000010";
const USER_ONE = "160000000000000101";
const CHANNEL_PRIVATE = "160000000000000201";
const CHANNEL_PUBLIC = "160000000000000202";
const THREAD_PRIVATE = "160000000000000203";

interface Harness {
	readonly status: GetGuildStateStatusQuery;
	readonly resync: ResyncGuildStateCommand;
	readonly bootstrap: ApplyGuildBootstrapCommand;
	readonly gateway: FakeGuildStateGateway;
	readonly registries: RecordingRegistries;
	readonly tracker: InMemoryBootstrapStateTracker;
	readonly ledger: InMemoryGuildResyncLedger;
	readonly logger: RecordingLogger;
}

function baseProgram(): FakeGatewayProgram {
	return {
		snapshot: { guildId: GUILD_ID, name: "Example Guild HQ" },
		roles: [role(GUILD_ID, GUILD_ID, "0", 0), role(GUILD_ID, ROLE_BACKEND, "1024", 1)],
		channels: [
			channel(GUILD_ID, CHANNEL_PRIVATE, {
				name: "private",
				position: 0,
				permissionOverwrites: [
					{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: "1024", denyBitfield: "0" }
				]
			}),
			channel(GUILD_ID, CHANNEL_PUBLIC, { name: "public", position: 1 }),
			thread(GUILD_ID, THREAD_PRIVATE, CHANNEL_PRIVATE, "private-thread", { name: "incident" })
		],
		roster: completeRoster(GUILD_ID, [member(GUILD_ID, USER_ONE, [ROLE_BACKEND])]),
		threadMembers: { [THREAD_PRIVATE]: [threadPage(THREAD_PRIVATE, [USER_ONE])] }
	};
}

function harness(program: FakeGatewayProgram = baseProgram()): Harness {
	const logger = new RecordingLogger();
	const gateway = new FakeGuildStateGateway(program, GUILD_ID);
	const registries = new RecordingRegistries();
	const tracker = new InMemoryBootstrapStateTracker({ guildId: GUILD_ID });
	const ledger = new InMemoryGuildResyncLedger({ guildId: GUILD_ID });
	const config = createGuildStateConfig({ guildId: GUILD_ID });
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
	const resync = new ResyncGuildStateCommand({
		config,
		gateway,
		tracker,
		ledger,
		bootstrapCommand: bootstrap,
		upsertRoleCommand: new UpsertRoleCommand({ config, roleRegistry: registries.rolesContract, logger }),
		sweepCommand: new SweepVanishedStateCommand({
			config,
			membershipRegistry: registries.membershipsContract,
			roleRegistry: registries.rolesContract,
			channelRegistry: registries.channelsContract,
			deleteRoleCommand: new DeleteRoleCommand({ config, roleRegistry: registries.rolesContract, logger }),
			deleteChannelCommand: new DeleteChannelCommand({
				config,
				channelRegistry: registries.channelsContract,
				logger
			}),
			logger
		}),
		roleRegistry: registries.rolesContract,
		channelRegistry: registries.channelsContract,
		logger
	});
	const status = new GetGuildStateStatusQuery({
		config,
		tracker,
		ledger,
		guildRegistry: registries.guildsContract,
		logger
	});
	return { status, resync, bootstrap, gateway, registries, tracker, ledger, logger };
}

describe("GetGuildStateStatusQuery — the R2/R11 status transitions", () => {
	it("a fresh installation is incomplete and never authoritative", async () => {
		const scope = harness();

		const result = await scope.status.execute();

		expect(result.status).toBe("incomplete");
		expect(result.guildRegistered).toBe(false);
		expect(result.bootstrap.complete).toBe(false);
		expect(result.bootstrap.pendingParts).toEqual(["guild", "roles", "channels", "roster", "thread-members"]);
		expect(result.bootstrap.appliedParts).toEqual([]);
		// R2's boundary: an empty registry is not a "current" one, so a consumer gating on status stays closed.
		expect(result.status).not.toBe("current");
	});

	it("a completed bootstrap is current, with no gaps and every anomaly count named at zero", async () => {
		const scope = harness();

		const report = await scope.bootstrap.execute();
		const result = await scope.status.execute();

		expect(report.complete).toBe(true);
		expect(result).toMatchObject({
			guildId: GUILD_ID,
			status: "current",
			guildRegistered: true,
			bootstrap: { complete: true, pendingParts: [] },
			resync: { inFlight: false, epoch: null, convergedEpoch: null },
			unavailableReason: null
		});
		expect(result.gaps.openGapCount).toBe(0);
		// R14: the report is counts by reason; every reason is present so the shape never moves.
		expect(Object.values(result.anomalyCounts).every((count) => count === 0)).toBe(true);
		expect(result.anomalyCounts).toHaveProperty(["foreign-guild"]);
	});

	it("walks fresh → incomplete → current → resync-needed → stale → current over one ledger", async () => {
		const scope = harness();
		expect((await scope.status.execute()).status).toBe("incomplete");

		await scope.bootstrap.execute();
		expect((await scope.status.execute()).status).toBe("current");

		// The signal's in-flight window: R11 names it explicitly, and it is visible while the pass runs.
		scope.ledger.beginResync(7);
		const inFlight = await scope.status.execute();
		expect(inFlight.status).toBe("stale");
		expect(inFlight.resync).toMatchObject({ inFlight: true, epoch: 7 });
		// A reset tracker plus an in-flight resync still answers `stale`, not the vaguer `incomplete`.
		scope.tracker.reset();
		expect((await scope.status.execute()).status).toBe("stale");
		scope.ledger.endResync();

		// And the run itself returns the registry to current, because the gap list emptied with the reads.
		const result = await scope.resync.execute({ epoch: 8, reason: "reconnect" });
		expect(result.status).toBe("current");
		expect(await scope.status.execute()).toMatchObject({
			status: "current",
			resync: { inFlight: false, convergedEpoch: 8 }
		});
	});

	it("an unresolved gap holds the status stale even with every part applied (R11 error case)", async () => {
		const scope = harness();
		await scope.bootstrap.execute();
		expect((await scope.status.execute()).status).toBe("current");

		// T5's fact: the overwrite set is still without a source, and this read could not supply it.
		const result = await scope.resync.execute({
			epoch: 2,
			gaps: [
				{
					kind: "channel-pending-rest-fields",
					resourceId: CHANNEL_PUBLIC,
					reason: "payload-carried-no-overwrite-set",
					pendingFields: ["permissionOverwrites"]
				}
			]
		});

		const status = await scope.status.execute();
		expect(result.bootstrap?.complete).toBe(true);
		expect(status.bootstrap.complete).toBe(true);
		expect(status.status).toBe("stale");
		expect(status.gaps.openGapCount).toBe(1);
		expect(status.gaps.pendingRestFieldCount).toBe(1);
		expect(status.gaps.gapCounts["channel-pending-rest-fields"]).toBe(1);
		// Never current on a partial read, whatever the part list says.
		expect(status.status).not.toBe("current");
	});

	it("counts anomalies by the reason the event path reported (R3, R5, R7, R8, R11)", async () => {
		const scope = harness();

		await scope.resync.execute({
			epoch: 1,
			gaps: [
				{
					kind: "role-incomplete-description",
					resourceId: "160000000000000099",
					reason: "incomplete-role-description"
				},
				{
					kind: "channel-pending-rest-fields",
					resourceId: CHANNEL_PUBLIC,
					reason: "payload-carried-no-overwrite-set",
					pendingFields: ["permissionOverwrites"]
				},
				{
					kind: "thread-membership-unobserved",
					resourceId: THREAD_PRIVATE,
					reason: "unknown thread at event time"
				}
			]
		});

		expect((await scope.status.execute()).anomalyCounts).toMatchObject({
			"incomplete-role-description": 1,
			"payload-carried-no-overwrite-set": 2,
			"unknown-thread-membership": 1
		});
	});

	it("a lost guild is unavailable, and the reason travels with it (R1 boundary, R2 error)", async () => {
		const scope = harness({ ...baseProgram(), failures: { guild: { reason: "not-found", status: 404 } } });

		await scope.resync.execute({ epoch: 1, reason: "reconnect" });
		const status = await scope.status.execute();

		expect(status.status).toBe("unavailable");
		expect(status.unavailableReason).toBe("guild-unavailable");
		expect(status.anomalyCounts["guild-unavailable"]).toBe(1);
		// The part list may be anything; unavailability outranks it, because the rows are no longer authority.
		expect(status.status).not.toBe("incomplete");
		expect(scope.logger.linesAt("error").length).toBeGreaterThan(0);

		// Recovery is a good read of the configured Guild, not a status the hub grants itself.
		const recovered = harness();
		await recovered.resync.execute({ epoch: 1 });
		expect((await recovered.status.execute()).status).toBe("current");
	});

	it("reads the registry row instead of assuming one, and writes nothing while reporting (R13)", async () => {
		const scope = harness();
		const writesBefore = scope.registries.writes.length;

		await scope.status.execute();
		await scope.status.execute();

		expect(scope.registries.writes.length).toBe(writesBefore);
		expect(scope.gateway.calls).toHaveLength(0);
		expect(scope.registries.guilds.size).toBe(0);
	});

	it("reports the truncated roster as the incomplete state it is, with the gap named (R2, R11)", async () => {
		const scope = harness({
			...baseProgram(),
			roster: {
				guildId: GUILD_ID,
				members: [member(GUILD_ID, USER_ONE, [ROLE_BACKEND])],
				pages: 20,
				complete: false,
				truncatedBy: "page-limit"
			}
		});

		await scope.resync.execute({ epoch: 1 });
		const status = await scope.status.execute();

		expect(status.status).toBe("incomplete");
		expect(status.bootstrap.pendingParts).toContain("roster");
		expect(status.gaps.openGaps.map((gap) => gap.kind)).toContain("roster-truncated");
		expect(status.anomalyCounts["roster-truncated"]).toBe(1);
	});

	it("reports an unobservable thread's part as pending forever, and the gap as open (R8, O1)", async () => {
		// The fake gateway answers an unprogrammed thread with 403, which is exactly the coverage limit.
		const scope = harness({ ...baseProgram(), threadMembers: {} });

		await scope.resync.execute({ epoch: 1 });
		const status = await scope.status.execute();

		expect(status.bootstrap.pendingParts).toContain("thread-members");
		expect(status.bootstrap.complete).toBe(false);
		expect(status.status).toBe("incomplete");
		expect(status.gaps.openGaps.map((gap) => gap.resourceId)).toContain(THREAD_PRIVATE);
		expect(status.anomalyCounts["thread-member-list-unreadable"]).toBe(1);
	});
});
