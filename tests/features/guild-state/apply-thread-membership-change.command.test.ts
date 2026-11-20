import { describe, expect, it } from "vitest";
import { ApplyThreadMembershipChangeCommand } from "../../../src/features/guild-state/commands/apply-thread-membership-change.command.js";
import type { ApplyThreadMembershipChangeEvent } from "../../../src/features/guild-state/commands/apply-thread-membership-change.command.js";
import { createGuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import type { RegistryChannel } from "../../../src/features/guild-state/models/domain/registry-records.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import { RecordingRegistries } from "./fakes/recording-registry-repositories.js";

/**
 * T6 — private-thread membership events (docs/features/guild-state.md R8, R9, with R1 at the event boundary).
 *
 * The rows are the whole of this command's job: (`thread id`, `User id`). What those rows *mean* is R8's
 * fail-closed rule, and it belongs to evaluation (T7) — absence never grants. Nothing here reads a set to
 * decide whether an edge is already there, because `addThreadMembership` / `removeThreadMembership` are the
 * natural-key writes R9 names, and the adapter makes each one replay-safe.
 *
 * R8's error case is the design: a change for a thread the registry does not hold is **returned** as a
 * deferral for the anomaly path (R11), never written. An orphan thread row would be invented Discord state —
 * an unresolvable grant, which R3 and R6 both forbid — and the thread arrives either through its own event or
 * through the resync pass, at which point the replayed change lands. The same reasoning refuses an edge on a
 * registry row that is not a thread: a non-thread channel has no thread membership to record, and storing one
 * would hand evaluation a contribution it cannot derive (a fail-closed reading of R8, like the sweep pinned
 * in `odd/tasks/guild-state.md` L3(2)).
 */

const GUILD_ID = "160000000000000001";
const OTHER_GUILD_ID = "160000000000000999";
const CHANNEL_PRIVATE = "160000000000000201";
const THREAD_PRIVATE = "160000000000000203";
const THREAD_PUBLIC = "160000000000000205";
const USER_ONE = "160000000000000101";
const USER_TWO = "160000000000000102";
const USER_UNKNOWN = "160000000000000199";

interface Harness {
	readonly command: ApplyThreadMembershipChangeCommand;
	readonly registries: RecordingRegistries;
	readonly logger: RecordingLogger;
}

function harness(registries = new RecordingRegistries()): Harness {
	const logger = new RecordingLogger();
	const command = new ApplyThreadMembershipChangeCommand({
		config: createGuildStateConfig({ guildId: GUILD_ID }),
		channelRegistry: registries.channelsContract,
		threadMembershipRegistry: registries.threadMembershipsContract,
		logger
	});
	return { command, registries, logger };
}

function row(channelId: string, channelType: RegistryChannel["channelType"]): RegistryChannel {
	return { guildId: GUILD_ID, channelId, channelType, name: null, position: null, parentChannelId: null };
}

/** One text channel and two threads under it, written through the doubles without leaving a write log. */
async function seededRegistries(): Promise<RecordingRegistries> {
	const registries = new RecordingRegistries();
	await registries.channelsContract.upsertChannels([
		{ ...row(CHANNEL_PRIVATE, "guild-text"), parentChannelId: null },
		{ ...row(THREAD_PRIVATE, "private-thread"), parentChannelId: CHANNEL_PRIVATE },
		{ ...row(THREAD_PUBLIC, "public-thread"), parentChannelId: CHANNEL_PRIVATE }
	]);
	registries.writes.splice(0, registries.writes.length);
	return registries;
}

function added(threadId = THREAD_PRIVATE, userId = USER_ONE): ApplyThreadMembershipChangeEvent {
	return { guildId: GUILD_ID, threadId, userId, change: "added" };
}

function removed(threadId = THREAD_PRIVATE, userId = USER_ONE): ApplyThreadMembershipChangeEvent {
	return { guildId: GUILD_ID, threadId, userId, change: "removed" };
}

describe("ApplyThreadMembershipChangeCommand (R8, R9)", () => {
	it("writes the edge a thread-member-added event names (R8)", async () => {
		const registries = await seededRegistries();
		const { command, logger } = harness(registries);

		const outcome = await command.execute(added());

		expect(outcome).toMatchObject({
			status: "applied",
			change: "added",
			threadId: THREAD_PRIVATE,
			userId: USER_ONE,
			rowWritten: true
		});
		expect(registries.threadMemberships.get(THREAD_PRIVATE)).toEqual([USER_ONE]);
		expect(logger.linesAt("info").at(-1)?.fields).toMatchObject({
			guildId: GUILD_ID,
			threadId: THREAD_PRIVATE,
			userId: USER_ONE,
			change: "added",
			rowWritten: true
		});
	});

	it("keeps the edge of a private thread that roles alone do not open, alongside the others (R8)", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);

		await command.execute(added(THREAD_PRIVATE, USER_ONE));
		await command.execute(added(THREAD_PRIVATE, USER_TWO));

		expect(registries.threadMemberships.get(THREAD_PRIVATE)?.slice().sort()).toEqual([USER_ONE, USER_TWO].sort());
		// A public thread is a thread too: the row is what the event said, and nothing else changes.
		await command.execute(added(THREAD_PUBLIC, USER_ONE));
		expect(registries.threadMemberships.get(THREAD_PUBLIC)).toEqual([USER_ONE]);
	});

	it("removes exactly the named edge and leaves the thread's other members (R8)", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);
		await command.execute(added(THREAD_PRIVATE, USER_ONE));
		await command.execute(added(THREAD_PRIVATE, USER_TWO));

		const outcome = await command.execute(removed(THREAD_PRIVATE, USER_ONE));

		expect(outcome).toMatchObject({ status: "applied", change: "removed", rowRemoved: true });
		expect(registries.threadMemberships.get(THREAD_PRIVATE)).toEqual([USER_TWO]);
	});

	it("replays an added event to one edge and a no-op second write (R9)", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);

		expect(await command.execute(added())).toMatchObject({ status: "applied", rowWritten: true });
		const state = registries.state();
		expect(await command.execute(added())).toMatchObject({ status: "applied", rowWritten: false });

		expect(registries.state()).toEqual(state);
		expect(registries.threadMemberships.get(THREAD_PRIVATE)).toEqual([USER_ONE]);
	});

	it("treats a repeated removal as a counted no-op, never an error (R9)", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);
		await command.execute(added());
		registries.writes.splice(0, registries.writes.length);

		expect(await command.execute(removed())).toMatchObject({ status: "applied", rowRemoved: true });
		expect(await command.execute(removed())).toMatchObject({ status: "applied", rowRemoved: false });
		expect(registries.threadMemberships.get(THREAD_PRIVATE)).toEqual([]);
	});

	it("defers a change for a thread the registry does not hold, writing no orphan row (R8 error)", async () => {
		const registries = await seededRegistries();
		const { command, logger } = harness(registries);

		const outcome = await command.execute(added("160000000000000999", USER_ONE));

		expect(outcome).toMatchObject({
			status: "refused",
			reason: "unknown-thread",
			threadId: "160000000000000999",
			userId: USER_ONE
		});
		// Nothing was written: not the edge, and above all not a thread row invented to hold it.
		expect(registries.writes).toEqual([]);
		expect(registries.channels.size).toBe(3);
		expect(registries.threadMemberships.has("160000000000000999")).toBe(false);
		// The deferral is an anomaly to converge, and it names ids only (R14).
		expect(logger.linesAt("warn").at(-1)?.fields).toMatchObject({
			reason: "unknown-thread",
			threadId: "160000000000000999",
			userId: USER_ONE
		});
	});

	it("applies the same change once the thread arrives, which is the convergence R10 promises", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);
		const event = added("160000000000000999", USER_ONE);

		expect(await command.execute(event)).toMatchObject({ status: "refused", reason: "unknown-thread" });

		await registries.channelsContract.upsertChannels([
			{ ...row("160000000000000999", "private-thread"), parentChannelId: CHANNEL_PRIVATE }
		]);
		registries.writes.splice(0, registries.writes.length);

		expect(await command.execute(event)).toMatchObject({ status: "applied", rowWritten: true });
	});

	it("defers a removal for an unknown thread too, because no edge could exist without its thread row (R8)", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);

		expect(await command.execute(removed("160000000000000999", USER_ONE))).toMatchObject({
			status: "refused",
			reason: "unknown-thread"
		});
		expect(registries.writes).toEqual([]);
	});

	it("defers a change naming a registry row that is not a thread instead of storing an unusable edge (R8)", async () => {
		const registries = await seededRegistries();
		const { command, logger } = harness(registries);

		const outcome = await command.execute(added(CHANNEL_PRIVATE, USER_ONE));

		expect(outcome).toMatchObject({ status: "refused", reason: "not-a-thread", threadId: CHANNEL_PRIVATE });
		expect(registries.writes).toEqual([]);
		expect(logger.linesAt("warn").at(-1)?.fields).toMatchObject({ reason: "not-a-thread" });
	});

	it("keeps membership for a user the guild roster does not hold, because the fact stands on its own (R8)", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);

		expect(await command.execute(added(THREAD_PRIVATE, USER_UNKNOWN))).toMatchObject({ status: "applied" });
		expect(registries.memberships.size).toBe(0);
		expect(registries.threadMemberships.get(THREAD_PRIVATE)).toEqual([USER_UNKNOWN]);
	});

	it("drops a change that names another Guild, writing nothing (R1)", async () => {
		const registries = await seededRegistries();
		const { command, logger } = harness(registries);

		const outcome = await command.execute({
			guildId: OTHER_GUILD_ID,
			threadId: THREAD_PRIVATE,
			userId: USER_ONE,
			change: "added"
		});

		expect(outcome).toMatchObject({ status: "dropped", reason: "foreign-guild" });
		expect(registries.writes).toEqual([]);
		expect(JSON.stringify(logger.linesAt("warn")[0]?.fields)).toContain(OTHER_GUILD_ID);
	});

	it("refuses a thread or user id that cannot live in a bigint column (R9 natural keys)", async () => {
		const { command, registries } = harness();

		await expect(
			command.execute({ guildId: GUILD_ID, threadId: "thread", userId: USER_ONE, change: "added" })
		).rejects.toThrow(/thread_membership.thread_id/);
		await expect(
			command.execute({ guildId: GUILD_ID, threadId: THREAD_PRIVATE, userId: "user", change: "added" })
		).rejects.toThrow(/thread_membership.user_id/);
		expect(registries.writes).toEqual([]);
	});

	it("refuses a change that is neither added nor removed instead of guessing the direction (R8)", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);

		const bogus = { ...added(), change: "unknown" } as unknown as ApplyThreadMembershipChangeEvent;
		await expect(command.execute(bogus)).rejects.toThrow(/thread_membership.change/);
		expect(registries.writes).toEqual([]);
	});

	it("logs ids and counts only, never a name or stored content (R14)", async () => {
		const registries = await seededRegistries();
		const { command, logger } = harness(registries);

		await command.execute(added());
		await command.execute(removed());

		const transcript = logger.transcript();
		expect(transcript).toContain(GUILD_ID);
		expect(transcript).toContain(THREAD_PRIVATE);
		expect(transcript).toContain(USER_ONE);
		expect(transcript).not.toMatch(/username|nickname|content|token/i);
	});
});
