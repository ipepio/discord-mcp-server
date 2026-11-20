import { describe, expect, it } from "vitest";
import type { DiscordChannelRecord } from "../../../src/features/discord/index.js";
import { ApplyGuildBootstrapCommand } from "../../../src/features/guild-state/commands/apply-guild-bootstrap.command.js";
import type { GuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import { createGuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import { InMemoryBootstrapStateTracker } from "../../../src/features/guild-state/bootstrap/in-memory-bootstrap-state.js";
import { GUILD_BOOTSTRAP_PARTS } from "../../../src/features/guild-state/models/domain/bootstrap-state.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
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
import { RecordingRegistries } from "./fakes/recording-registry-repositories.js";

/**
 * R2 — the REST bootstrap, part by part.
 *
 * The rule under test has three halves, and each is asserted against the doubles rather than mocked away:
 * a pass applies every part the rule names, applied parts are recorded only after their writes returned, and
 * completion is the tracker's verdict, never the command's. The writes themselves are the repositories'
 * bounded, idempotent ones (proven against real PostgreSQL in `tests/integration/`), so what the doubles
 * record here is *which* writes a pass issued and *when* a part stopped counting as done.
 */

const GUILD_ID = "160000000000000001";
const ROLE_BACKEND = "160000000000000010";
const USER_ONE = "160000000000000101";
const USER_TWO = "160000000000000102";
const CHANNEL_PRIVATE = "160000000000000201";
const CHANNEL_PUBLIC = "160000000000000202";
const THREAD_PRIVATE = "160000000000000203";
const VIEW_CHANNEL = "1024";

interface Harness {
	readonly command: ApplyGuildBootstrapCommand;
	readonly gateway: FakeGuildStateGateway;
	readonly registries: RecordingRegistries;
	readonly tracker: InMemoryBootstrapStateTracker;
	readonly logger: RecordingLogger;
}

/** One bootstrap-shaped fixture: a Guild, two roles, two channels (one with overwrites, one without), a thread, a roster. */
function baseProgram(): FakeGatewayProgram {
	const channels: DiscordChannelRecord[] = [
		channel(GUILD_ID, CHANNEL_PRIVATE, {
			name: "private",
			position: 0,
			permissionOverwrites: [
				{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }
			]
		}),
		// No `permissionOverwrites` key at all: Discord sent no list, which is not the same as an empty one.
		channel(GUILD_ID, CHANNEL_PUBLIC, { name: "public", position: 1 }),
		thread(GUILD_ID, THREAD_PRIVATE, CHANNEL_PRIVATE, "private-thread", { name: "incident", position: 0 })
	];

	return {
		snapshot: { guildId: GUILD_ID, name: "Example Guild HQ" },
		roles: [role(GUILD_ID, GUILD_ID, "0", 0), role(GUILD_ID, ROLE_BACKEND, "1024", 1)],
		channels,
		roster: completeRoster(GUILD_ID, [
			member(GUILD_ID, USER_ONE, [ROLE_BACKEND], { username: "peekaboo", nickname: "Peek-a-Boo" }),
			member(GUILD_ID, USER_TWO, [])
		]),
		threadMembers: { [THREAD_PRIVATE]: [threadPage(THREAD_PRIVATE, [USER_ONE])] }
	};
}

function harness(program: FakeGatewayProgram, config?: GuildStateConfig): Harness {
	const logger = new RecordingLogger();
	const gateway = new FakeGuildStateGateway(program, GUILD_ID);
	const registries = new RecordingRegistries();
	const tracker = new InMemoryBootstrapStateTracker({ guildId: GUILD_ID });
	const resolvedConfig = config ?? createGuildStateConfig({ guildId: GUILD_ID });
	const command = new ApplyGuildBootstrapCommand({
		config: resolvedConfig,
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

describe("ApplyGuildBootstrapCommand (R2)", () => {
	it("applies every part of one bootstrap pass and reports it complete", async () => {
		const { command, tracker, gateway, registries: store } = harness(baseProgram());

		const report = await command.execute();

		expect(report.complete).toBe(true);
		expect(report.gaps).toEqual([]);
		expect(tracker.isComplete()).toBe(true);
		expect(report.parts.map((part) => [part.part, part.state])).toEqual(
			GUILD_BOOTSTRAP_PARTS.map((part) => [part, "applied"])
		);
		expect(gateway.readNames()).toEqual(["guild", "roles", "channels", "roster", "threadMembers"]);

		// The rows the registry holds after one pass, from the reads it was given.
		expect(store.guilds.get("guild")).toEqual({ guildId: GUILD_ID, guildName: "Example Guild HQ" });
	});

	it("stores the guild row, the role list, the channel registry and the roster through the repositories (R2, R3, R4, R6)", async () => {
		const { command, registries: store } = harness(baseProgram());

		await command.execute();

		expect(store.operationOrder()).toEqual([
			"upsertGuild",
			"upsertRoles",
			"upsertChannels",
			"replaceChannelOverwrites",
			"upsertMemberships",
			"replaceThreadMemberships"
		]);
		expect([...store.roles.keys()]).toEqual([GUILD_ID, ROLE_BACKEND]);
		// @everyone is a role like any other, and its id is the Guild id (R3).
		expect(store.roles.get(GUILD_ID)?.permissionsBitfield).toBe("0");
		expect(store.roles.get(ROLE_BACKEND)?.permissionsBitfield).toBe("1024");
		expect([...store.channels.keys()]).toEqual([CHANNEL_PRIVATE, CHANNEL_PUBLIC, THREAD_PRIVATE]);
		// The thread keeps its parent; a thread is a channel with a parent (R6).
		expect(store.channels.get(THREAD_PRIVATE)?.parentChannelId).toBe(CHANNEL_PRIVATE);
		expect(store.memberships.get(USER_ONE)?.roleIds).toEqual([ROLE_BACKEND]);
		expect(store.memberships.get(USER_TWO)?.roleIds).toEqual([]);
		expect(store.threadMemberships.get(THREAD_PRIVATE)).toEqual([USER_ONE]);
	});

	it("replaces an overwrite set only when the read carried one, keeping absent distinct from empty (R7, R10)", async () => {
		const program = baseProgram();
		const { command, registries: store } = harness(program);
		// Something already stored, so a sweep would be visible: the channel that sends no list keeps it.
		store.overwrites.set(CHANNEL_PUBLIC, ["role:160000000000000010"]);

		await command.execute();

		// One call, for the channel that carried a list — not one per channel.
		expect(store.writesOf("replaceChannelOverwrites")).toHaveLength(1);
		expect(store.overwrites.get(CHANNEL_PUBLIC)).toEqual(["role:160000000000000010"]);
		expect(store.overwrites.get(CHANNEL_PRIVATE)).toEqual([`role:${ROLE_BACKEND}`]);
	});

	it("applies an explicitly empty overwrite set as empty (R7: a removed grant cannot survive)", async () => {
		const program = baseProgram();
		expect(program.channels?.[0]?.channelId).toBe(CHANNEL_PRIVATE);
		// The channel that carried a list now carries an explicitly empty one: a whole-set replacement, not an
		// absence, so the stored grant must go (R10 keeps the two cases apart).
		program.channels = (program.channels ?? []).map((candidate) =>
			candidate.channelId === CHANNEL_PRIVATE ? { ...candidate, permissionOverwrites: [] } : candidate
		);
		const { command, registries: store } = harness(program);
		store.overwrites.set(CHANNEL_PRIVATE, [`role:${ROLE_BACKEND}`]);

		await command.execute();

		expect(store.overwrites.get(CHANNEL_PRIVATE)).toEqual([]);
	});

	it("walks a thread member list across pages and replaces the whole set (R8, R10)", async () => {
		const program: FakeGatewayProgram = {
			...baseProgram(),
			threadMembers: {
				[THREAD_PRIVATE]: [
					threadPage(THREAD_PRIVATE, [USER_ONE], true, USER_ONE),
					threadPage(THREAD_PRIVATE, [USER_TWO], false)
				]
			}
		};
		const { command, gateway, registries: store } = harness(program);

		const report = await command.execute();

		expect(report.complete).toBe(true);
		expect(gateway.countOf("threadMembers")).toBe(2);
		expect(store.threadMemberships.get(THREAD_PRIVATE)?.slice().sort()).toEqual([USER_ONE, USER_TWO].sort());
	});

	it("asks the roster read for the bound this Installation declared, not for everything (R2, persistence.md)", async () => {
		const config = createGuildStateConfig({ guildId: GUILD_ID, bootstrap: { rosterMaxPages: 3 } });
		const { command, gateway } = harness(baseProgram(), config);

		await command.execute();

		expect(gateway.calls.find((call) => call.read === "roster")?.detail).toBe("maxPages=3");
	});

	it("keeps display data out of the registry and out of every log line (R14, O2)", async () => {
		const { command, logger, registries: store } = harness(baseProgram());

		await command.execute();

		const membership = store.memberships.get(USER_ONE);
		expect(membership).toBeDefined();
		expect(Object.keys(membership ?? {})).toEqual(["guildId", "userId", "roleIds"]);
		const transcript = logger.transcript();
		expect(transcript).not.toContain("peekaboo");
		expect(transcript).not.toContain("Peek-a-Boo");
		expect(transcript).not.toContain("token");
	});

	it("refuses a record that names a guild other than the configured one, and stores nothing for it (R1)", async () => {
		const program = baseProgram();
		// A role record from another Guild: the whole list is validated before anything is written (R1).
		program.roles = [...(program.roles ?? []), role("160000000000000999", "160000000000000500", "8", 9)];
		const { command, logger, registries: store, tracker } = harness(program);

		await expect(command.execute()).rejects.toThrow(/another guild|configured guild/);

		expect(store.roles.has("160000000000000500")).toBe(false);
		expect(store.memberships.size).toBe(0);
		expect(tracker.isApplied("roles")).toBe(false);
		expect(logger.linesAt("error").some((line) => line.fields["resultGuildId"] === "160000000000000999")).toBe(
			true
		);
	});

	it("refuses a guild read whose result names another guild (R1)", async () => {
		const program = { ...baseProgram(), snapshot: { guildId: "160000000000000999", name: "Elsewhere" } };
		const { command, registries: store } = harness(program);

		await expect(command.execute()).rejects.toThrow(/guild 160000000000000999/);
		expect(store.guilds.size).toBe(0);
	});

	/**
	 * The pass reports the ids it read, not only the rows it wrote, because that is what lets a resync converge a
	 * deletion rather than only an addition (R11). Nothing here decides what to remove: the report is the read
	 * result restated as ids, and the convergence sweep is its only consumer.
	 */
	it("reports the whole sets it read, which is what a resync sweeps against (R10, R11)", async () => {
		const { command } = harness(baseProgram());

		const report = await command.execute();

		expect(report.reads.roles).toEqual([GUILD_ID, ROLE_BACKEND]);
		expect(report.reads.channels).toEqual([CHANNEL_PRIVATE, CHANNEL_PUBLIC, THREAD_PRIVATE]);
		expect(report.reads.roster).toEqual({ complete: true, userIds: [USER_ONE, USER_TWO] });
	});

	it("reports a truncated roster as incomplete, so no sweep can read it as a departure list (R2, R11)", async () => {
		const program = baseProgram();
		program.roster = {
			guildId: GUILD_ID,
			members: [member(GUILD_ID, USER_ONE, [ROLE_BACKEND])],
			pages: 20,
			complete: false,
			truncatedBy: "page-limit"
		};
		const { command } = harness(program);

		const report = await command.execute();

		// The ids that did arrive are still reported — they are the fact this pass has — but flagged partial.
		expect(report.reads.roster).toEqual({ complete: false, userIds: [USER_ONE] });
		expect(report.complete).toBe(false);
		expect(report.gaps.map((gap) => gap.part)).toEqual(["roster"]);
	});

	it("carries no read set for a part it skipped as already applied, because this pass did not read it (R10)", async () => {
		const { command, tracker } = harness(baseProgram());
		await command.execute();
		expect(tracker.isApplied("roles")).toBe(true);
		// A second, resumed pass: the roles part is not read again, so it must report no role set to sweep from.
		const resumed = await command.execute();

		expect(resumed.reads.roles).toBeUndefined();
		expect(resumed.reads.channels).toBeUndefined();
		expect(resumed.reads.roster).toBeUndefined();
		expect(resumed.complete).toBe(true);
	});
});
