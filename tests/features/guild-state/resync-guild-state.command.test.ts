import { describe, expect, it } from "vitest";
import { InMemoryBootstrapStateTracker } from "../../../src/features/guild-state/bootstrap/in-memory-bootstrap-state.js";
import { InMemoryGuildResyncLedger } from "../../../src/features/guild-state/bootstrap/in-memory-resync-ledger.js";
import { ApplyGuildBootstrapCommand } from "../../../src/features/guild-state/commands/apply-guild-bootstrap.command.js";
import { DeleteChannelCommand } from "../../../src/features/guild-state/commands/delete-channel.command.js";
import { DeleteRoleCommand } from "../../../src/features/guild-state/commands/delete-role.command.js";
import { EndMembershipCommand } from "../../../src/features/guild-state/commands/end-membership.command.js";
import { ResyncGuildStateCommand } from "../../../src/features/guild-state/commands/resync-guild-state.command.js";
import { SweepVanishedStateCommand } from "../../../src/features/guild-state/commands/sweep-vanished-state.command.js";
import { UpsertRoleCommand } from "../../../src/features/guild-state/commands/upsert-role.command.js";
import type { GuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import { createGuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import { GetGuildStateStatusQuery } from "../../../src/features/guild-state/queries/get-guild-state-status.query.js";
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
import type { RecordingRegistryOptions } from "./fakes/recording-registry-repositories.js";
import { RecordingRegistries } from "./fakes/recording-registry-repositories.js";

/**
 * R11 — the reconnect/anomaly resynchronization, and the status rules R2 and R11 attach to it
 * (docs/features/guild-state.md; `odd/tasks/guild-state.md` T8).
 *
 * What is proven here is the shape of the convergence, against the same doubles the bootstrap is proven with:
 * the resync delegates the re-read to `ApplyGuildBootstrapCommand` rather than copying it, it resets the
 * tracker so the pass is a genuine full replace-and-converge (R10), it completes exactly the gaps the event
 * path could not know (T3's refused role, T5's missing overwrite set, R5's deferred role id), and it never
 * closes what only O1 can close (an unobserved private thread). Every assertion about status goes through the
 * real {@link GetGuildStateStatusQuery}, because a rule that only the command's own result obeys is not a
 * rule the authorization feature can gate on.
 */

const GUILD_ID = "160000000000000001";
const ROLE_BACKEND = "160000000000000010";
const ROLE_OPS = "160000000000000011";
const ROLE_VANISHED = "160000000000000012";
const USER_ONE = "160000000000000101";
const USER_VANISHED = "160000000000000102";
const CHANNEL_PRIVATE = "160000000000000201";
const CHANNEL_PUBLIC = "160000000000000202";
const CHANNEL_VANISHED = "160000000000000204";
const THREAD_PRIVATE = "160000000000000203";
const VIEW_CHANNEL = "1024";

interface Harness {
	readonly resync: ResyncGuildStateCommand;
	readonly bootstrap: ApplyGuildBootstrapCommand;
	readonly status: GetGuildStateStatusQuery;
	readonly gateway: FakeGuildStateGateway;
	readonly registries: RecordingRegistries;
	readonly tracker: InMemoryBootstrapStateTracker;
	readonly ledger: InMemoryGuildResyncLedger;
	readonly logger: RecordingLogger;
}

function baseProgram(): FakeGatewayProgram {
	return {
		snapshot: { guildId: GUILD_ID, name: "Example Guild HQ" },
		roles: [
			role(GUILD_ID, GUILD_ID, "0", 0),
			role(GUILD_ID, ROLE_BACKEND, VIEW_CHANNEL, 1),
			// Known to the REST list but never to the event path: what R3's refusal and T8's read are for.
			role(GUILD_ID, ROLE_OPS, VIEW_CHANNEL, 2)
		],
		channels: [
			channel(GUILD_ID, CHANNEL_PRIVATE, {
				name: "private",
				position: 0,
				permissionOverwrites: [
					{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }
				]
			}),
			// No overwrite list at all: T5 leaves this as `pendingRestFields`, and T8's read must complete it.
			channel(GUILD_ID, CHANNEL_PUBLIC, { name: "public", position: 1 }),
			thread(GUILD_ID, THREAD_PRIVATE, CHANNEL_PRIVATE, "private-thread", { name: "incident" })
		],
		roster: completeRoster(GUILD_ID, [member(GUILD_ID, USER_ONE, [ROLE_BACKEND])]),
		threadMembers: { [THREAD_PRIVATE]: [threadPage(THREAD_PRIVATE, [USER_ONE])] }
	};
}

function harness(
	program: FakeGatewayProgram,
	config: GuildStateConfig = createGuildStateConfig({ guildId: GUILD_ID }),
	registryOptions: RecordingRegistryOptions = {}
): Harness {
	const logger = new RecordingLogger();
	const gateway = new FakeGuildStateGateway(program, GUILD_ID);
	const registries = new RecordingRegistries(registryOptions);
	const tracker = new InMemoryBootstrapStateTracker({ guildId: GUILD_ID });
	const ledger = new InMemoryGuildResyncLedger({ guildId: GUILD_ID });
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
	const upsertRole = new UpsertRoleCommand({
		config,
		roleRegistry: registries.rolesContract,
		logger
	});
	// The convergence sweep is a real command here, not a stub: what it removes is the security content of R11,
	// and the cascades it routes through are the ones the event path uses.
	const sweep = new SweepVanishedStateCommand({
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
	});
	const resync = new ResyncGuildStateCommand({
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
	});
	const status = new GetGuildStateStatusQuery({
		config,
		tracker,
		ledger,
		guildRegistry: registries.guildsContract,
		logger
	});
	return { resync, bootstrap, status, gateway, registries, tracker, ledger, logger };
}

describe("ResyncGuildStateCommand — the bootstrap path, reused (R11, R2, R9, R10)", () => {
	it("resets the tracker and re-runs the whole bootstrap pass", async () => {
		const scope = harness(baseProgram());
		await scope.bootstrap.execute();
		expect(scope.tracker.isComplete()).toBe(true);
		const readsBefore = scope.gateway.calls.length;

		const result = await scope.resync.execute({ epoch: 1, reason: "reconnect" });

		// R11's boundary: a full replace-and-converge over the bootstrap path, not a replay of missed events.
		expect(scope.tracker.isComplete()).toBe(true);
		expect(result.bootstrap).not.toBeNull();
		expect(result.bootstrap?.complete).toBe(true);
		expect(result.skipped).toBe(false);
		expect(scope.gateway.countOf("guild")).toBe(2);
		expect(scope.gateway.countOf("roles")).toBe(2);
		expect(scope.gateway.countOf("channels")).toBe(2);
		expect(scope.gateway.countOf("roster")).toBe(2);
		expect(scope.gateway.calls.length).toBeGreaterThan(readsBefore);
		// R9: the second pass re-confirms the same rows; nothing about the registry changed.
		expect(scope.registries.roles.size).toBe(3);
		expect(scope.registries.memberships.size).toBe(1);
		expect(result.status).toBe("current");
	});

	it("reports the signal's own facts and counts the kinds it names without narrowing the pass", async () => {
		const scope = harness(baseProgram());

		const result = await scope.resync.execute({
			epoch: 3,
			reason: "dropped-delivery",
			affectedKinds: ["channel-updated"],
			gaps: []
		});

		expect(result.epoch).toBe(3);
		expect(scope.logger.messagesMatching("resync started").at(-1)?.fields).toMatchObject({
			epoch: 3,
			reason: "dropped-delivery",
			affectedKinds: ["channel-updated"]
		});
		// A narrowed signal still re-reads everything: the reset is the convergence, not a per-kind guess.
		expect(scope.gateway.countOf("roster")).toBe(1);
	});

	it("answers a replayed or older epoch without spending another read budget (R9)", async () => {
		const scope = harness(baseProgram());
		await scope.resync.execute({ epoch: 5, reason: "reconnect" });
		const reads = scope.gateway.calls.length;

		const replay = await scope.resync.execute({ epoch: 5, reason: "reconnect" });

		expect(replay.skipped).toBe(true);
		expect(replay.bootstrap).toBeNull();
		expect(scope.gateway.calls.length).toBe(reads);
		expect(replay.status).toBe("current");

		// A genuinely newer epoch is served again.
		expect((await scope.resync.execute({ epoch: 6, reason: "reconnect" })).skipped).toBe(false);
	});

	it("drops a signal that names another guild and counts it as an anomaly (R1)", async () => {
		const scope = harness(baseProgram());

		const result = await scope.resync.execute({ epoch: 1, guildId: "999999999999999999" });

		expect(result.skipped).toBe(true);
		expect(scope.gateway.calls).toHaveLength(0);
		expect(result.anomalyCounts["foreign-guild"]).toBe(1);
		expect(scope.logger.linesAt("warn").at(-1)?.fields).toMatchObject({ eventGuildId: "999999999999999999" });
	});
});

describe("ResyncGuildStateCommand — targeted completion of the gaps T3–T6 left", () => {
	it("completes a refused role description from the targeted role read and re-applies it", async () => {
		const scope = harness(baseProgram());
		// The event path refused a role the REST list does know (R3's error case): that is what T3 reports here.
		expect(
			(await scope.registries.rolesContract.findRoles(GUILD_ID)).some(
				(candidate) => candidate.roleId === ROLE_OPS
			)
		).toBe(false);

		const result = await scope.resync.execute({
			epoch: 1,
			reason: "anomaly",
			gaps: [
				{
					kind: "role-incomplete-description",
					resourceId: ROLE_OPS,
					reason: "incomplete-role-description",
					pendingFields: ["roleName", "permissionsBitfield"]
				}
			]
		});

		expect(result.targetedReads.roles).toBe(true);
		// The targeted role read is the second one of the run: the bootstrap pass and the anomaly read are separate.
		expect(scope.gateway.countOf("roles")).toBe(2);
		expect(result.completions).toContainEqual({
			kind: "role-incomplete-description",
			resourceId: ROLE_OPS,
			outcome: "completed"
		});
		expect(result.anomalyCounts["incomplete-role-description"]).toBe(1);
		// The role row now exists, written through UpsertRoleCommand rather than a second copy of its rules.
		expect(scope.registries.roles.get(ROLE_OPS)).toMatchObject({
			roleName: `role-${ROLE_OPS}`,
			permissionsBitfield: "1024"
		});
		expect(result.openGaps).toEqual([]);
		expect(result.status).toBe("current");
	});

	it("leaves a role gap open when the REST list does not name the role either", async () => {
		const scope = harness(baseProgram());
		const unknownRole = "160000000000000099";

		const result = await scope.resync.execute({
			epoch: 1,
			gaps: [
				{ kind: "role-incomplete-description", resourceId: unknownRole, reason: "incomplete-role-description" }
			]
		});

		expect(result.completions).toContainEqual({
			kind: "role-incomplete-description",
			resourceId: unknownRole,
			outcome: "still-open",
			reason: "role-absent-from-rest-read"
		});
		expect(scope.registries.roles.has(unknownRole)).toBe(false);
		expect((await scope.status.execute()).status).toBe("stale");
	});

	it("completes a channel left with pendingRestFields and replaces its overwrite set wholesale", async () => {
		const program = baseProgram();
		// The targeted read carries the set the event payload never sent.
		program.channels = (program.channels ?? []).map((candidate) =>
			candidate.channelId === CHANNEL_PUBLIC
				? {
						...candidate,
						permissionOverwrites: [
							{
								targetId: ROLE_BACKEND,
								targetType: "role" as const,
								allowBitfield: VIEW_CHANNEL,
								denyBitfield: "0"
							}
						]
					}
				: candidate
		);
		const scope = harness(program);

		const result = await scope.resync.execute({
			epoch: 1,
			gaps: [
				{
					kind: "channel-pending-rest-fields",
					resourceId: CHANNEL_PUBLIC,
					reason: "payload-carried-no-overwrite-set",
					pendingFields: ["permissionOverwrites"]
				}
			]
		});

		expect(result.targetedReads.channels).toBe(true);
		expect(result.completions).toContainEqual({
			kind: "channel-pending-rest-fields",
			resourceId: CHANNEL_PUBLIC,
			outcome: "completed"
		});
		// R7: the set arrived, so the replacement transaction ran and the grant is now stored.
		expect(scope.registries.overwriteEntries.get(CHANNEL_PUBLIC)).toEqual([
			{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }
		]);
		expect(scope.registries.writesOf("replaceChannelOverwrites").length).toBeGreaterThan(1);
		expect(result.openGaps).toEqual([]);
		expect((await scope.status.execute()).gaps.pendingRestFieldCount).toBe(0);
	});

	it("keeps the gap open when even the REST read carried no overwrite set — absent is never empty (R10)", async () => {
		const scope = harness(baseProgram());

		const result = await scope.resync.execute({
			epoch: 1,
			gaps: [
				{
					kind: "channel-pending-rest-fields",
					resourceId: CHANNEL_PUBLIC,
					reason: "payload-carried-no-overwrite-set",
					pendingFields: ["permissionOverwrites"]
				}
			]
		});

		expect(result.completions).toContainEqual({
			kind: "channel-pending-rest-fields",
			resourceId: CHANNEL_PUBLIC,
			outcome: "still-open",
			reason: "rest-read-carried-no-overwrite-set"
		});
		// The stored set was not touched: no invented revocation.
		expect(scope.registries.overwrites.get(CHANNEL_PUBLIC)).toBeUndefined();
		expect(result.status).toBe("stale");
		expect((await scope.status.execute()).gaps.pendingRestFieldCount).toBe(1);
		expect(
			scope.logger.linesAt("warn").some((line) => line.fields["reason"] === "rest-read-carried-no-overwrite-set")
		).toBe(true);
	});

	it("converges deferred member role ids through the fresh role list, and only when the row exists", async () => {
		const scope = harness(baseProgram());
		const stillUnknown = "160000000000000098";

		const result = await scope.resync.execute({
			epoch: 1,
			gaps: [
				{ kind: "role-id-deferred", resourceId: ROLE_BACKEND, reason: "role row absent at the FK boundary" },
				{ kind: "role-id-deferred", resourceId: stillUnknown, reason: "role row absent at the FK boundary" }
			]
		});

		expect(result.completions).toContainEqual({
			kind: "role-id-deferred",
			resourceId: ROLE_BACKEND,
			outcome: "completed"
		});
		expect(result.completions).toContainEqual({
			kind: "role-id-deferred",
			resourceId: stillUnknown,
			outcome: "still-open",
			reason: "role-row-still-absent"
		});
		expect(result.openGaps.map((gap) => gap.resourceId)).toEqual([stillUnknown]);
	});

	it("never closes an unknown-thread deferral: the O1 gap stays open and keeps the status stale (R8)", async () => {
		const scope = harness(baseProgram());

		const result = await scope.resync.execute({
			epoch: 1,
			gaps: [
				{
					kind: "thread-membership-unobserved",
					resourceId: THREAD_PRIVATE,
					reason: "unknown thread at event time"
				}
			]
		});

		expect(result.openGaps).toContainEqual({
			kind: "thread-membership-unobserved",
			resourceId: THREAD_PRIVATE,
			reason: "unknown thread at event time"
		});
		expect(result.gapCounts["thread-membership-unobserved"]).toBe(1);
		expect(result.anomalyCounts["unknown-thread-membership"]).toBe(1);
		expect(result.status).toBe("stale");
		// No membership edge was invented to make the gap disappear.
		expect(scope.registries.threadMemberships.get(THREAD_PRIVATE)).toEqual([USER_ONE]);
		expect(scope.logger.messagesMatching("O1 undecided").length).toBeGreaterThan(0);
	});

	it("records a truncated roster as an open gap straight from the bootstrap report", async () => {
		const program = baseProgram();
		program.roster = {
			guildId: GUILD_ID,
			members: [member(GUILD_ID, USER_ONE, [ROLE_BACKEND])],
			pages: 20,
			complete: false,
			truncatedBy: "page-limit"
		};
		const scope = harness(program);

		const result = await scope.resync.execute({ epoch: 1 });

		expect(result.bootstrap?.complete).toBe(false);
		expect(result.openGaps.map((gap) => gap.kind)).toContain("roster-truncated");
		expect(result.anomalyCounts["roster-truncated"]).toBe(1);
		expect((await scope.status.execute()).status).toBe("incomplete");
	});

	it("keeps the registry stale when a targeted read itself fails, and does not throw at the caller (R11 error)", async () => {
		const program = baseProgram();
		program.channels = (program.channels ?? []).map((candidate) =>
			candidate.channelId === CHANNEL_PUBLIC ? { ...candidate, permissionOverwrites: [] } : candidate
		);
		program.failures = { channels: { reason: "server-error" } };
		const scope = harness(program);

		// The bootstrap's own channel read fails first, so the part stays pending and nothing explodes.
		const result = await scope.resync.execute({
			epoch: 1,
			gaps: [
				{
					kind: "channel-pending-rest-fields",
					resourceId: CHANNEL_PRIVATE,
					reason: "payload-carried-no-overwrite-set"
				}
			]
		});

		expect(result.completions).toContainEqual({
			kind: "channel-pending-rest-fields",
			resourceId: CHANNEL_PRIVATE,
			outcome: "still-open",
			reason: "targeted-read-failed"
		});
		expect(result.anomalyCounts["targeted-read-failed"]).toBeGreaterThan(0);
		expect(result.openGaps.map((gap) => gap.kind)).toContain("resync-read-failed");
		expect(scope.tracker.isComplete()).toBe(false);
	});

	it("turns a 4xx on the guild read into a loud unavailable status, retried by the caller (R2, R1)", async () => {
		const scope = harness({
			...baseProgram(),
			failures: { guild: { reason: "not-found", status: 404 } }
		});

		const result = await scope.resync.execute({ epoch: 1, reason: "reconnect" });

		expect(result.status).toBe("unavailable");
		expect(result.unavailable).toMatchObject({ reason: "guild-unavailable" });
		expect(result.bootstrap).toBeNull();
		expect(scope.ledger.snapshot().unavailable).toBe(true);
		expect(result.anomalyCounts["guild-unavailable"]).toBe(1);
		expect(scope.logger.linesAt("error").length).toBeGreaterThan(0);
		// The pass never degraded into an empty-but-current registry.
		expect((await scope.status.execute()).status).toBe("unavailable");

		// A later good read is the evidence that access came back.
		const recovered = harness({ ...baseProgram() });
		await recovered.bootstrap.execute();
		expect((await recovered.status.execute()).status).toBe("current");
	});
});

describe("ResyncGuildStateCommand — the missed change and the revocation window (R11, R12)", () => {
	it("makes a revocation that landed during the gap effective the moment the resync converged (R12 + R11)", async () => {
		const program = baseProgram();
		const scope = harness(program);
		await scope.bootstrap.execute();
		const ends = new EndMembershipCommand({
			config: createGuildStateConfig({ guildId: GUILD_ID }),
			membershipRegistry: scope.registries.membershipsContract,
			logger: scope.logger
		});

		// The state Discord is now in: USER_ONE holds the `ops` role, and the hub never received that event.
		program.roles = [...(program.roles ?? []), role(GUILD_ID, ROLE_OPS, VIEW_CHANNEL, 2)];
		program.roster = completeRoster(GUILD_ID, [member(GUILD_ID, USER_ONE, [ROLE_BACKEND, ROLE_OPS])]);

		const result = await scope.resync.execute({ epoch: 1, reason: "reconnect" });

		// R11's example in one assertion: after the resync the registry describes the change it missed.
		expect(result.status).toBe("current");
		expect(scope.registries.memberships.get(USER_ONE)?.roleIds).toEqual([ROLE_BACKEND, ROLE_OPS].sort());
		expect(scope.registries.roles.has(ROLE_OPS)).toBe(true);

		// And the revocation half is immediate, with no interval and nothing to expire: an end applied now is
		// visible in the very next read, which is R12's latency statement over the same converged state.
		await ends.execute({ guildId: GUILD_ID, userId: USER_ONE });
		expect(await scope.registries.membershipsContract.findMembership(GUILD_ID, USER_ONE)).toBeNull();
		expect(scope.registries.memberships.has(USER_ONE)).toBe(false);
		expect((await scope.status.execute()).status).toBe("current");
	});
});

/**
 * T10 — the remove-half of R11. The pass above writes what the snapshot reported; these cases prove the resync
 * also stops honouring what the snapshot stopped reporting, that a truncated roster forbids the membership sweep
 * absolutely, and that the sweep costs no second read because the pass handed it the sets it already took.
 */
describe("ResyncGuildStateCommand — the convergence sweep of vanished state (R11, R4, R3, R6)", () => {
	it("ends the membership a complete roster no longer reports, and reports the count", async () => {
		const program = baseProgram();
		program.roster = completeRoster(GUILD_ID, [
			member(GUILD_ID, USER_ONE, [ROLE_BACKEND]),
			member(GUILD_ID, USER_VANISHED, [ROLE_BACKEND])
		]);
		const scope = harness(program);
		await scope.bootstrap.execute();
		expect(scope.registries.memberships.has(USER_VANISHED)).toBe(true);

		// The outage: this member left and no `GUILD_MEMBER_REMOVE` ever reached the hub.
		program.roster = completeRoster(GUILD_ID, [member(GUILD_ID, USER_ONE, [ROLE_BACKEND])]);
		const result = await scope.resync.execute({ epoch: 1, reason: "reconnect" });

		expect(result.sweep).toMatchObject({ removedMemberships: 1, removedRoles: 0, removedChannels: 0 });
		expect(scope.registries.memberships.has(USER_VANISHED)).toBe(false);
		// The member the roster still reports is untouched, which is the whole safety property of the diff.
		expect(scope.registries.memberships.get(USER_ONE)?.roleIds).toEqual([ROLE_BACKEND]);
		expect(scope.registries.writesOf("deleteMembershipAndDependents")).toHaveLength(1);
		expect(result.status).toBe("current");
	});

	it("costs no second read, because the sweep diffs the sets the pass already took (R11, R2)", async () => {
		const program = baseProgram();
		program.roster = completeRoster(GUILD_ID, [
			member(GUILD_ID, USER_ONE, [ROLE_BACKEND]),
			member(GUILD_ID, USER_VANISHED, [])
		]);
		const scope = harness(program);
		await scope.bootstrap.execute();
		program.roster = completeRoster(GUILD_ID, [member(GUILD_ID, USER_ONE, [ROLE_BACKEND])]);
		const readsBefore = scope.gateway.readNames().length;

		const result = await scope.resync.execute({ epoch: 1, reason: "reconnect" });

		// One roster read for the pass and none for the sweep: the bounded REST budget is R2's, unchanged, and
		// the convergence still saw the whole set because the pass handed it over rather than reading it twice.
		expect(scope.gateway.readNames().slice(readsBefore).sort()).toEqual([
			"channels",
			"guild",
			"roles",
			"roster",
			"threadMembers"
		]);
		expect(scope.gateway.countOf("roster")).toBe(2);
		expect(result.sweep?.removedMemberships).toBe(1);
		expect(scope.registries.memberships.has(USER_VANISHED)).toBe(false);
	});

	it("sweeps a role deleted during the outage through R3's cascade, links and overwrites included", async () => {
		const program = baseProgram();
		program.roles = [...(program.roles ?? []), role(GUILD_ID, ROLE_VANISHED, VIEW_CHANNEL, 3)];
		program.channels = (program.channels ?? []).concat(
			channel(GUILD_ID, CHANNEL_VANISHED, {
				name: "staff-only",
				position: 9,
				permissionOverwrites: [
					{ targetId: ROLE_VANISHED, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }
				]
			})
		);
		program.roster = completeRoster(GUILD_ID, [member(GUILD_ID, USER_ONE, [ROLE_BACKEND, ROLE_VANISHED])]);
		const scope = harness(program);
		await scope.bootstrap.execute();
		expect(scope.registries.roles.has(ROLE_VANISHED)).toBe(true);

		// Discord's side of the outage: the role and the channel are gone; the hub heard nothing.
		program.roles = (program.roles ?? []).filter((entry) => entry.roleId !== ROLE_VANISHED);
		program.channels = (program.channels ?? []).filter((entry) => entry.channelId !== CHANNEL_VANISHED);
		const result = await scope.resync.execute({ epoch: 1, reason: "reconnect" });

		expect(result.sweep).toMatchObject({ removedRoles: 1, removedChannels: 1 });
		expect(scope.registries.roles.has(ROLE_VANISHED)).toBe(false);
		expect(scope.registries.channels.has(CHANNEL_VANISHED)).toBe(false);
		// The role read no longer names it, so the roster write re-confirmed the member without it: no link is
		// left, and the overwrite that granted the vanished channel's view went with the cascade.
		expect(scope.registries.memberships.get(USER_ONE)?.roleIds).not.toContain(ROLE_VANISHED);
		expect(scope.registries.overwrites.has(CHANNEL_VANISHED)).toBe(false);
		expect(result.sweep?.dependentRowsRemoved).toBeGreaterThan(0);
	});

	it("refuses to sweep memberships from a truncated roster, and says so in the gap and the result (R2, R11)", async () => {
		const program = baseProgram();
		program.roster = completeRoster(GUILD_ID, [
			member(GUILD_ID, USER_ONE, [ROLE_BACKEND]),
			member(GUILD_ID, USER_VANISHED, [ROLE_BACKEND])
		]);
		const scope = harness(program);
		await scope.bootstrap.execute();

		// The same member is gone from the page this pass managed to read — but the read stopped at its bound,
		// which is a statement about pagination and not about who left the Guild.
		program.roster = {
			guildId: GUILD_ID,
			members: [member(GUILD_ID, USER_ONE, [ROLE_BACKEND])],
			pages: 20,
			complete: false,
			truncatedBy: "page-limit"
		};
		const result = await scope.resync.execute({ epoch: 1, reason: "reconnect" });

		expect(result.sweep?.removedMemberships).toBe(0);
		expect(result.sweep?.skipped).toEqual([{ target: "memberships", reason: "roster-truncated" }]);
		expect(scope.registries.writesOf("deleteMembershipAndDependents")).toEqual([]);
		// The mass revocation the rule exists to prevent: the member past the bound keeps their row.
		expect(scope.registries.memberships.has(USER_VANISHED)).toBe(true);
		expect(result.openGaps.map((gap) => gap.kind)).toContain("roster-truncated");
		// T8's precedence is unchanged and honest: a pending roster part is `incomplete`, never `current`. The
		// gap is the durable fact, and it holds the status out of `current` in every later pass too.
		expect(result.status).toBe("incomplete");
		expect((await scope.status.execute()).status).not.toBe("current");
	});

	it("sweeps nothing over an empty registry, which is why a first bootstrap needs no branch (R9, R11)", async () => {
		const scope = harness(baseProgram());

		// A resync that starts from a fresh installation: the pass writes every row, so the diff is empty by
		// construction and no delete transaction is opened.
		const result = await scope.resync.execute({ epoch: 1, reason: "reconnect" });

		expect(result.sweep).toMatchObject({ removedMemberships: 0, removedRoles: 0, removedChannels: 0, batches: 0 });
		expect(result.sweep?.skipped).toEqual([]);
		expect(scope.registries.writes.filter((write) => write.operation.startsWith("delete"))).toEqual([]);
		expect(result.status).toBe("current");
	});

	it("never sweeps on the plain bootstrap path: only a resync asks for the convergence (R11)", async () => {
		const program = baseProgram();
		const scope = harness(program);
		// A row the read will never name, planted the way an event path could leave one behind.
		scope.registries.memberships.set(USER_VANISHED, { guildId: GUILD_ID, userId: USER_VANISHED, roleIds: [] });

		await scope.bootstrap.execute();

		// The pass wrote what Discord reported and removed nothing: a first bootstrap has no sweep to run.
		expect(scope.registries.memberships.has(USER_VANISHED)).toBe(true);
		expect(scope.registries.writesOf("deleteMembershipAndDependents")).toEqual([]);
	});

	it("keeps the run total when the sweep itself cannot write, and holds the status out of current (R11 error)", async () => {
		const program = baseProgram();
		program.roster = completeRoster(GUILD_ID, [
			member(GUILD_ID, USER_ONE, [ROLE_BACKEND]),
			member(GUILD_ID, USER_VANISHED, [ROLE_BACKEND])
		]);
		const scope = harness(program, undefined, { failOperation: "deleteMembershipAndDependents" });
		await scope.bootstrap.execute();
		program.roster = completeRoster(GUILD_ID, [member(GUILD_ID, USER_ONE, [ROLE_BACKEND])]);

		const result = await scope.resync.execute({ epoch: 1, reason: "reconnect" });

		// A failed sweep is a resync step that did not finish: reported, gapped, and never rounded up to done.
		expect(result.sweep).toBeNull();
		expect(result.openGaps.map((gap) => gap.kind)).toContain("resync-read-failed");
		expect(result.anomalyCounts["targeted-read-failed"]).toBeGreaterThan(0);
		expect(result.status).not.toBe("current");
		expect(scope.registries.memberships.has(USER_VANISHED)).toBe(true);
	});

	it("reports no sweep at all when the run was skipped or the guild was lost (R9, R2)", async () => {
		const scope = harness(baseProgram());
		await scope.resync.execute({ epoch: 4, reason: "reconnect" });

		expect((await scope.resync.execute({ epoch: 4, reason: "reconnect" })).sweep).toBeNull();

		const lost = harness({ ...baseProgram(), failures: { guild: { reason: "not-found", status: 404 } } });
		expect((await lost.resync.execute({ epoch: 1, reason: "reconnect" })).sweep).toBeNull();
	});
});
