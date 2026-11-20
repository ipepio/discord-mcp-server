import { describe, expect, it } from "vitest";
import { DiscordRestFailureError } from "../../../src/features/discord/index.js";
import { ApplyGuildBootstrapCommand } from "../../../src/features/guild-state/commands/apply-guild-bootstrap.command.js";
import { InMemoryBootstrapStateTracker } from "../../../src/features/guild-state/bootstrap/in-memory-bootstrap-state.js";
import { createGuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import { GuildBootstrapUnavailableError } from "../../../src/features/guild-state/models/domain/bootstrap.errors.js";
import { GUILD_BOOTSTRAP_PARTS } from "../../../src/features/guild-state/models/domain/bootstrap-state.js";
import type { GuildBootstrapPart } from "../../../src/features/guild-state/models/domain/bootstrap-state.js";
import type { FakeGatewayProgram } from "./fakes/fake-guild-state-gateway.js";
import {
	FakeGuildStateGateway,
	channel,
	completeRoster,
	member,
	role,
	thread,
	threadPage,
	truncatedRoster
} from "./fakes/fake-guild-state-gateway.js";
import { RecordingRegistries } from "./fakes/recording-registry-repositories.js";
import type { RecordingRegistryOptions } from "./fakes/recording-registry-repositories.js";
import { RecordingLogger } from "./fakes/recording-logger.js";

/**
 * R2's second and third sentences — "resumes without duplicating rows, and reports a completion status.
 * Bootstrap completion is never claimed while any part is pending" — and its error case, which says a 4xx on
 * the Guild read fails the bootstrap loudly with the status `unavailable` instead of degrading into an
 * empty-but-"complete" registry.
 *
 * A process restart is modelled the way it actually happens: the rows survive (they are PostgreSQL's) and the
 * tracker does not, so the test constructs a new tracker over the same `RecordingRegistries`. The command
 * offers two resumabilities and both are asserted here — within a process, a pass skips the parts already
 * applied; across one, the whole path re-runs and the registry's own idempotent writes (R9, proven with real
 * SQL in `tests/integration/`) mean re-applying the same REST data changes nothing observable.
 */

const GUILD_ID = "160000000000000001";
const ROLE_BACKEND = "160000000000000010";
const USER_ONE = "160000000000000101";
const USER_TWO = "160000000000000102";
const CHANNEL_PRIVATE = "160000000000000201";
const THREAD_PRIVATE = "160000000000000203";

interface Run {
	readonly command: ApplyGuildBootstrapCommand;
	readonly gateway: FakeGuildStateGateway;
	readonly registries: RecordingRegistries;
	readonly tracker: InMemoryBootstrapStateTracker;
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
			thread(GUILD_ID, THREAD_PRIVATE, CHANNEL_PRIVATE, "private-thread", { name: "incident" })
		],
		roster: completeRoster(GUILD_ID, [member(GUILD_ID, USER_ONE, [ROLE_BACKEND]), member(GUILD_ID, USER_TWO, [])]),
		threadMembers: { [THREAD_PRIVATE]: [threadPage(THREAD_PRIVATE, [USER_ONE])] }
	};
}

/** A run that keeps the doubles, so several passes — or a "restart" — can share the stored rows. */
function run(
	program: FakeGatewayProgram,
	existing?: { registries: RecordingRegistries; logger?: RecordingLogger },
	registryOptions?: RecordingRegistryOptions
): Run {
	const registries = existing?.registries ?? new RecordingRegistries(registryOptions);
	const logger = existing?.logger ?? new RecordingLogger();
	const gateway = new FakeGuildStateGateway(program, GUILD_ID);
	// Every call builds a fresh tracker: that is exactly what a process start looks like to this feature.
	const tracker = new InMemoryBootstrapStateTracker({ guildId: GUILD_ID });
	const command = new ApplyGuildBootstrapCommand({
		config: createGuildStateConfig({ guildId: GUILD_ID }),
		gateway,
		tracker,
		guildRegistry: registries.guildsContract,
		roleRegistry: registries.rolesContract,
		channelRegistry: registries.channelsContract,
		membershipRegistry: registries.membershipsContract,
		threadMembershipRegistry: registries.threadMembershipsContract,
		logger
	});
	return { command, gateway, registries, tracker, logger };
}

function statesOf(report: { parts: readonly { part: GuildBootstrapPart; state: string }[] }) {
	return Object.fromEntries(report.parts.map((part) => [part.part, part.state]));
}

describe("bootstrap resumability (R2, R9)", () => {
	it("a second pass in the same process skips every part the first one applied", async () => {
		const first = run(baseProgram());
		const shared = { registries: first.registries, logger: first.logger };

		const firstReport = await first.command.execute();
		expect(firstReport.complete).toBe(true);

		const second = run(baseProgram(), shared);
		// Resume the same process: hand the second pass the first pass's tracker.
		const resumed = new ApplyGuildBootstrapCommand({
			config: createGuildStateConfig({ guildId: GUILD_ID }),
			gateway: second.gateway,
			tracker: first.tracker,
			guildRegistry: second.registries.guildsContract,
			roleRegistry: second.registries.rolesContract,
			channelRegistry: second.registries.channelsContract,
			membershipRegistry: second.registries.membershipsContract,
			threadMembershipRegistry: second.registries.threadMembershipsContract,
			logger: second.logger
		});

		const secondReport = await resumed.execute();

		expect(secondReport.complete).toBe(true);
		// Nothing re-read and nothing re-written: every part was already applied in this process.
		expect(second.gateway.calls).toEqual([]);
		expect(second.registries.writes.length).toBe(first.registries.writes.length);
		expect(statesOf(secondReport)).toEqual(
			Object.fromEntries(GUILD_BOOTSTRAP_PARTS.map((part) => [part, "applied"]))
		);
	});

	it("a restart mid-pagination re-runs the pass and leaves the stored rows identical (R2 example, R9)", async () => {
		// The interruption: the roster came back stopped at its bound, so the roster part stayed pending.
		const interrupted = run({
			...baseProgram(),
			roster: truncatedRoster(GUILD_ID, [member(GUILD_ID, USER_ONE, [ROLE_BACKEND])], 3, "page-limit")
		});

		const firstReport = await interrupted.command.execute();

		expect(firstReport.complete).toBe(false);
		expect(statesOf(firstReport)).toEqual({
			guild: "applied",
			roles: "applied",
			channels: "applied",
			roster: "pending",
			"thread-members": "applied"
		});
		expect(firstReport.gaps.map((gap) => gap.part)).toEqual(["roster"]);
		expect(firstReport.gaps[0]?.reason).toContain("page-limit");
		const rowsAfterInterrupt = interrupted.registries.state();
		expect(interrupted.registries.memberships.size).toBe(1);

		// The restart: new process, new tracker, same database. The remaining pages arrive this time.
		const restarted = run(
			{ ...baseProgram(), roster: completeRoster(GUILD_ID, [member(GUILD_ID, USER_ONE, [ROLE_BACKEND])], 6) },
			{ registries: interrupted.registries, logger: interrupted.logger }
		);
		const secondReport = await restarted.command.execute();

		expect(secondReport.complete).toBe(true);
		expect(restarted.registries.state()).toEqual(rowsAfterInterrupt);
		// The guild/role/channel rows were re-written, not duplicated: one row each, still.
		expect(restarted.registries.guilds.size).toBe(1);
		expect(restarted.registries.roles.size).toBe(2);
		expect(restarted.registries.channels.size).toBe(2);
		expect(restarted.registries.memberships.size).toBe(1);
	});

	it("a transient failure on one part surfaces it, keeps that part pending, and keeps the applied parts applied", async () => {
		const program: FakeGatewayProgram = {
			...baseProgram(),
			failures: { roles: { reason: "server-error", status: 503, times: 1 } }
		};
		const stopped = run(program);

		await expect(stopped.command.execute()).rejects.toBeInstanceOf(DiscordRestFailureError);

		expect(stopped.tracker.isApplied("guild")).toBe(true);
		expect(stopped.tracker.isApplied("roles")).toBe(false);
		expect(stopped.tracker.isApplied("channels")).toBe(false);
		expect(stopped.tracker.isComplete()).toBe(false);
		// The read that failed is not retried here: the discord adapter already spent its own bound.
		expect(stopped.gateway.countOf("roles")).toBe(1);

		// The next pass in the same process resumes where the failure stopped it.
		const resumed = new ApplyGuildBootstrapCommand({
			config: createGuildStateConfig({ guildId: GUILD_ID }),
			gateway: new FakeGuildStateGateway(baseProgram(), GUILD_ID),
			tracker: stopped.tracker,
			guildRegistry: stopped.registries.guildsContract,
			roleRegistry: stopped.registries.rolesContract,
			channelRegistry: stopped.registries.channelsContract,
			membershipRegistry: stopped.registries.membershipsContract,
			threadMembershipRegistry: stopped.registries.threadMembershipsContract,
			logger: stopped.logger
		});
		const report = await resumed.execute();

		expect(report.complete).toBe(true);
		// The guild row was read once in total across both passes: the tracker said it was already done.
		expect(stopped.registries.writesOf("upsertGuild")).toHaveLength(1);
		expect(stopped.registries.writesOf("upsertRoles")).toHaveLength(1);
	});

	it("reports the tracker's state as the whole truth: complete only after every part applied", async () => {
		const program: FakeGatewayProgram = {
			...baseProgram(),
			roster: truncatedRoster(GUILD_ID, [member(GUILD_ID, USER_TWO, [])], 1, "member-limit"),
			threadMembers: {}
		};
		const harnessRun = run(program);

		const report = await harnessRun.command.execute();

		expect(report.complete).toBe(false);
		expect(harnessRun.tracker.isComplete()).toBe(false);
		expect(report.gaps.map((gap) => gap.part).sort()).toEqual(["roster", "thread-members"]);
		expect(report.parts.filter((part) => part.state === "applied").map((part) => part.part)).toEqual([
			"guild",
			"roles",
			"channels"
		]);
	});

	it("keeps the thread-members part pending when a thread's member list cannot be read, and never invents it (R8, O1)", async () => {
		const program: FakeGatewayProgram = { ...baseProgram(), threadMembers: {} };
		const harnessRun = run(program);

		const report = await harnessRun.command.execute();

		expect(report.complete).toBe(false);
		expect(harnessRun.tracker.isApplied("thread-members")).toBe(false);
		expect(harnessRun.registries.threadMemberships.has(THREAD_PRIVATE)).toBe(false);
		const gap = report.gaps.find((entry) => entry.part === "thread-members");
		expect(gap?.threadIds).toEqual([THREAD_PRIVATE]);
		// A gap is logged as an id and a reason, not as a payload (R14).
		expect(harnessRun.logger.transcript()).toContain(THREAD_PRIVATE);
	});

	it("treats a thread that promised another page with no cursor as unread, not as fully read", async () => {
		// An empty page that still promises more gives the pass nothing to continue with: R8's "not invented".
		const program: FakeGatewayProgram = {
			...baseProgram(),
			threadMembers: { [THREAD_PRIVATE]: [threadPage(THREAD_PRIVATE, [], true)] }
		};
		const harnessRun = run(program);

		const report = await harnessRun.command.execute();

		expect(report.complete).toBe(false);
		expect(harnessRun.registries.threadMemberships.has(THREAD_PRIVATE)).toBe(false);
		expect(report.gaps.find((gap) => gap.part === "thread-members")?.threadIds).toEqual([THREAD_PRIVATE]);
	});

	it("applies a thread's empty member list as empty when the API answered (empty is not unreadable)", async () => {
		const program: FakeGatewayProgram = {
			...baseProgram(),
			threadMembers: { [THREAD_PRIVATE]: [threadPage(THREAD_PRIVATE, [])] }
		};
		const harnessRun = run(program);

		const report = await harnessRun.command.execute();

		expect(report.complete).toBe(true);
		expect(harnessRun.registries.threadMemberships.get(THREAD_PRIVATE)).toEqual([]);
	});

	it("a repository failure mid-pass keeps that part pending and stops the pass where the write stopped (R2)", async () => {
		// The provider answered everything; the database refused one statement. Applied means written, so a
		// failed write must not count — this is the case a mock-only test would get wrong.
		const harnessRun = run(baseProgram(), undefined, { failOperation: "upsertChannels", failAfterWrites: 0 });

		await expect(harnessRun.command.execute()).rejects.toThrow(/failed upsertChannels/);

		expect(harnessRun.tracker.isApplied("guild")).toBe(true);
		expect(harnessRun.tracker.isApplied("roles")).toBe(true);
		expect(harnessRun.tracker.isApplied("channels")).toBe(false);
		expect(harnessRun.tracker.isComplete()).toBe(false);
		// The parts after the failure were never attempted: the roster read did not happen.
		expect(harnessRun.gateway.countOf("roster")).toBe(0);
		expect(harnessRun.gateway.countOf("threadMembers")).toBe(0);
		expect(harnessRun.tracker.pendingParts()).toEqual(["channels", "roster", "thread-members"]);
		// And nothing was recorded as applied for the part whose transaction failed.
		expect(harnessRun.registries.memberships.size).toBe(0);
	});

	it("holds no memory of its own between processes: a fresh tracker starts with every part pending", () => {
		const tracker = new InMemoryBootstrapStateTracker({ guildId: GUILD_ID });
		for (const part of GUILD_BOOTSTRAP_PARTS) {
			tracker.markApplied(part);
		}
		expect(tracker.isComplete()).toBe(true);

		const afterRestart = new InMemoryBootstrapStateTracker({ guildId: GUILD_ID });

		expect(afterRestart.pendingParts()).toEqual([...GUILD_BOOTSTRAP_PARTS]);
		expect(afterRestart.isComplete()).toBe(false);
		expect(afterRestart.snapshot().parts).toEqual(
			Object.fromEntries(GUILD_BOOTSTRAP_PARTS.map((part) => [part, "pending"]))
		);
	});

	it("a reset forgets the applied parts, which is what a resync needs before re-running this path (R11)", () => {
		const tracker = new InMemoryBootstrapStateTracker({ guildId: GUILD_ID });
		tracker.markApplied("roles");
		expect(tracker.pendingParts()).toEqual(["guild", "channels", "roster", "thread-members"]);

		tracker.reset();

		expect(tracker.pendingParts()).toEqual([...GUILD_BOOTSTRAP_PARTS]);
	});
});

describe("bootstrap unavailability (R2 error case)", () => {
	const guildFailures = [
		["unauthorized", 401],
		["not-found", 404],
		["client-error", 400]
	] as const;

	it.each(guildFailures)(
		"refuses a %s guild read as unavailable, without applying anything",
		async (reason, status) => {
			const program: FakeGatewayProgram = {
				...baseProgram(),
				failures: { guild: { reason, status, operation: "discord-rest.guild-snapshot" } }
			};
			const harnessRun = run(program);

			const failure = await harnessRun.command.execute().catch((error: unknown) => error);

			expect(failure).toBeInstanceOf(GuildBootstrapUnavailableError);
			expect((failure as GuildBootstrapUnavailableError).guildId).toBe(GUILD_ID);
			expect((failure as GuildBootstrapUnavailableError).status).toBe(status);
			// Nothing degraded: no part applied, no row written, no completion claimed.
			expect(harnessRun.tracker.snapshot().parts).toEqual(
				Object.fromEntries(GUILD_BOOTSTRAP_PARTS.map((part) => [part, "pending"]))
			);
			expect(harnessRun.registries.writes).toEqual([]);
			expect(harnessRun.logger.linesAt("error").map((line) => line.fields["reason"])).toContain(reason);
			// The reads that would have produced a plausible-looking empty registry were never attempted.
			expect(harnessRun.gateway.readNames()).toEqual(["guild"]);
		}
	);

	it("refuses a guild Discord reports as unavailable, naming the guild (R1 boundary)", async () => {
		const program: FakeGatewayProgram = {
			...baseProgram(),
			snapshot: { guildId: GUILD_ID, name: "Example Guild HQ", isUnavailable: true }
		};
		const harnessRun = run(program);

		await expect(harnessRun.command.execute()).rejects.toBeInstanceOf(GuildBootstrapUnavailableError);
		expect(harnessRun.registries.writes).toEqual([]);
		expect(harnessRun.logger.transcript()).toContain(GUILD_ID);
	});

	it("surfaces a transient guild failure as the boundary error it is, keeping every part pending (R2, R7)", async () => {
		const program: FakeGatewayProgram = {
			...baseProgram(),
			failures: { guild: { reason: "rate-limit", status: 429, operation: "discord-rest.guild-snapshot" } }
		};
		const harnessRun = run(program);

		const failure = await harnessRun.command.execute().catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(DiscordRestFailureError);
		expect(failure).not.toBeInstanceOf(GuildBootstrapUnavailableError);
		expect(harnessRun.tracker.isComplete()).toBe(false);
		expect(harnessRun.registries.writes).toEqual([]);
	});

	it("reports the part-level failure with the read and reason that caused it, never a payload (R14)", async () => {
		const program: FakeGatewayProgram = {
			...baseProgram(),
			failures: { channels: { reason: "timeout", operation: "discord-rest.channels" } }
		};
		const harnessRun = run(program);

		await expect(harnessRun.command.execute()).rejects.toBeInstanceOf(DiscordRestFailureError);

		const line = harnessRun.logger.linesAt("error").at(-1);
		expect(line?.fields["part"]).toBe("channels");
		// The read is named in this feature's own vocabulary; the boundary's message travels as the detail.
		expect(line?.fields["operation"]).toBe("readChannels");
		expect(line?.fields["reason"]).toBe("timeout");
		expect(Object.keys(line?.fields ?? {}).sort()).toEqual(["detail", "guildId", "operation", "part", "reason"]);
		// A channel's name is display data: it appears in no bootstrap log line (R14).
		expect(harnessRun.logger.transcript()).not.toContain("private");
	});

	it("leaves the roster part pending when a member page fails, with the guild row already applied", async () => {
		const program: FakeGatewayProgram = {
			...baseProgram(),
			failures: { roster: { reason: "server-error", status: 500, operation: "discord-rest.member-roster" } }
		};
		const harnessRun = run(program);

		await expect(harnessRun.command.execute()).rejects.toBeInstanceOf(DiscordRestFailureError);

		expect(harnessRun.tracker.isApplied("guild")).toBe(true);
		expect(harnessRun.tracker.isApplied("roster")).toBe(false);
		expect(harnessRun.tracker.pendingParts()).toEqual(["roster", "thread-members"]);
		expect(harnessRun.registries.memberships.size).toBe(0);
	});
});
