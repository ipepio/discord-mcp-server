import { describe, expect, it } from "vitest";
import { DeleteChannelCommand } from "../../../src/features/guild-state/commands/delete-channel.command.js";
import type { DeleteChannelEvent } from "../../../src/features/guild-state/commands/delete-channel.command.js";
import { createGuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import type { RegistryChannel } from "../../../src/features/guild-state/models/domain/registry-records.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import { RecordingRegistries } from "./fakes/recording-registry-repositories.js";

/**
 * T5 — channel and thread deletion (docs/features/guild-state.md R6, R9, R14).
 *
 * R6's cascade belongs to the repository: one transaction removing the row, the overwrite rows of it and of
 * every thread under it, and the private-thread membership edges. This command issues that call exactly once
 * per event and reports the counts, for the same reason `DeleteRoleCommand` does — a read-modify-write of
 * each dependent would be a merge by another name and an unbounded sweep besides.
 *
 * R9: a `CHANNEL_DELETE` that arrives twice, or that arrives after a resync already converged the row, is a
 * counted no-op. The channel is *not* known and the row was never there, the registry says so with zeros, and
 * no error is raised — which is what makes a replayed delivery harmless.
 *
 * R14: the log names the Guild id, the channel id and the counts the database returned.
 */

const GUILD_ID = "160000000000000001";
const OTHER_GUILD_ID = "160000000000000999";
const ROLE_BACKEND = "160000000000000010";
const USER_ONE = "160000000000000101";
const CHANNEL_PRIVATE = "160000000000000201";
const CHANNEL_PUBLIC = "160000000000000202";
const THREAD_PRIVATE = "160000000000000203";
const VIEW_CHANNEL = "1024";

interface Harness {
	readonly command: DeleteChannelCommand;
	readonly registries: RecordingRegistries;
	readonly logger: RecordingLogger;
}

function harness(registries = new RecordingRegistries()): Harness {
	const logger = new RecordingLogger();
	const command = new DeleteChannelCommand({
		config: createGuildStateConfig({ guildId: GUILD_ID }),
		channelRegistry: registries.channelsContract,
		logger
	});
	return { command, registries, logger };
}

function row(
	channelId: string,
	channelType: RegistryChannel["channelType"],
	parentChannelId: string | null
): RegistryChannel {
	return { guildId: GUILD_ID, channelId, channelType, name: null, position: null, parentChannelId };
}

/** The whole channel tree: a text channel, a thread under it, and an unrelated channel. */
async function seededRegistries(): Promise<RecordingRegistries> {
	const registries = new RecordingRegistries();
	await registries.channelsContract.upsertChannels([
		row(CHANNEL_PRIVATE, "guild-text", null),
		row(THREAD_PRIVATE, "private-thread", CHANNEL_PRIVATE),
		row(CHANNEL_PUBLIC, "guild-text", null)
	]);
	await registries.channelsContract.replaceChannelOverwrites({
		guildId: GUILD_ID,
		channelId: CHANNEL_PRIVATE,
		overwrites: [{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }]
	});
	await registries.channelsContract.replaceChannelOverwrites({
		guildId: GUILD_ID,
		channelId: THREAD_PRIVATE,
		overwrites: [{ targetId: USER_ONE, targetType: "member", allowBitfield: "0", denyBitfield: "0" }]
	});
	await registries.threadMembershipsContract.addThreadMembership({
		guildId: GUILD_ID,
		threadId: THREAD_PRIVATE,
		userId: USER_ONE
	});
	registries.writes.splice(0, registries.writes.length);
	return registries;
}

const deletion: DeleteChannelEvent = { guildId: GUILD_ID, channelId: CHANNEL_PRIVATE };

describe("DeleteChannelCommand (R6, R9, R14)", () => {
	it("removes the channel with its threads, their overwrites and their thread edges in one cascade call (R6)", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);

		const outcome = await command.execute(deletion);

		expect(outcome).toMatchObject({
			status: "applied",
			channelId: CHANNEL_PRIVATE,
			channelRemoved: true,
			childThreadsRemoved: 1,
			overwritesRemoved: 2,
			threadMembershipsRemoved: 1
		});
	});

	it("removes exactly one transaction's worth of work per event and never re-reads dependents itself (R6)", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);

		await command.execute(deletion);

		// The cascade is one call. A second `deleteChannelAndDependents`, or a per-thread loop, would mean the
		// command is composing the repository's transaction out of smaller ones — and losing its atomicity.
		expect(registries.writes.map((write) => write.operation)).toEqual(["deleteChannelAndDependents"]);
	});

	it("removes the channel rows so no later event can resolve against them, and leaves other channels (R6)", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);

		await command.execute(deletion);

		expect(registries.channels.has(CHANNEL_PRIVATE)).toBe(false);
		// The thread went with its parent: a thread row that outlived its parent could not be evaluated (R6).
		expect(registries.channels.has(THREAD_PRIVATE)).toBe(false);
		expect(registries.channels.has(CHANNEL_PUBLIC)).toBe(true);
		expect(registries.overwrites.has(THREAD_PRIVATE)).toBe(false);
		expect(registries.threadMemberships.has(THREAD_PRIVATE)).toBe(false);
		// The unrelated channel keeps its own overwrite set.
		expect(registries.overwrites.get(CHANNEL_PUBLIC) ?? []).toEqual([]);
	});

	it("replays a deletion as a counted no-op, not an error (R9)", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);

		const first = await command.execute(deletion);
		expect(first).toMatchObject({ status: "applied", channelRemoved: true });
		const state = registries.state();

		expect(await command.execute(deletion)).toMatchObject({
			status: "applied",
			channelRemoved: false,
			childThreadsRemoved: 0,
			overwritesRemoved: 0,
			threadMembershipsRemoved: 0
		});
		expect(registries.state()).toEqual(state);
	});

	it("reports zeros for a channel the registry never held (R6 boundary, R9)", async () => {
		const { command } = harness();

		expect(await command.execute({ guildId: GUILD_ID, channelId: THREAD_PRIVATE })).toMatchObject({
			status: "applied",
			channelRemoved: false,
			overwritesRemoved: 0
		});
	});

	it("deletes a thread by its own id without touching its parent channel (R6)", async () => {
		const registries = await seededRegistries();
		const { command } = harness(registries);

		const outcome = await command.execute({ guildId: GUILD_ID, channelId: THREAD_PRIVATE });

		expect(outcome).toMatchObject({
			status: "applied",
			channelRemoved: true,
			childThreadsRemoved: 0,
			overwritesRemoved: 1,
			threadMembershipsRemoved: 1
		});
		expect(registries.channels.has(CHANNEL_PRIVATE)).toBe(true);
	});

	it("drops a deletion that names another Guild, removing nothing (R1)", async () => {
		const registries = await seededRegistries();
		const { command, logger } = harness(registries);

		const outcome = await command.execute({ guildId: OTHER_GUILD_ID, channelId: CHANNEL_PRIVATE });

		expect(outcome).toMatchObject({ status: "dropped", reason: "foreign-guild" });
		expect(registries.writes).toEqual([]);
		expect(registries.channels.size).toBe(3);
		expect(JSON.stringify(logger.linesAt("warn")[0]?.fields)).toContain(OTHER_GUILD_ID);
	});

	it("logs ids and counts only (R14)", async () => {
		const registries = await seededRegistries();
		const { command, logger } = harness(registries);

		await command.execute(deletion);

		const transcript = logger.transcript();
		expect(transcript).toContain(GUILD_ID);
		expect(transcript).toContain(CHANNEL_PRIVATE);
		// The threads and edges that went with the channel are reported as counts, not as ids: R14 asks what the
		// cascade removed, and only the channel named by the event is named.
		expect(transcript).toContain('"childThreadsRemoved":1');
		expect(transcript).toContain('"threadMembershipsRemoved":1');
		// The overwrite bitfield and the member's stored data never appear.
		expect(transcript).not.toContain(VIEW_CHANNEL);
		expect(transcript).not.toContain(USER_ONE);
	});

	it("refuses a channel id that cannot live in a bigint column (R9 natural keys)", async () => {
		const { command, registries } = harness();

		await expect(command.execute({ guildId: GUILD_ID, channelId: "channel-name" })).rejects.toThrow(
			/channel.channel_id/
		);
		expect(registries.writes).toEqual([]);
	});
});
