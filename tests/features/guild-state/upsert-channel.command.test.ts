import { describe, expect, it } from "vitest";
import type { ChannelPermissionOverwrite } from "../../../src/features/discord/index.js";
import { UpsertChannelCommand } from "../../../src/features/guild-state/commands/upsert-channel.command.js";
import type { UpsertChannelEvent } from "../../../src/features/guild-state/commands/upsert-channel.command.js";
import { createGuildStateConfig } from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import { InvalidPermissionBitfieldError } from "../../../src/features/guild-state/models/domain/guild-state-registry.errors.js";
import type { RegistryChannel } from "../../../src/features/guild-state/models/domain/registry-records.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import { RecordingRegistries } from "./fakes/recording-registry-repositories.js";

/**
 * T5 — channel and thread registry events (docs/features/guild-state.md R6, R7, R9, R10, with R1 at the event
 * boundary).
 *
 * One command serves channels and threads because the registry is one table: a thread is a channel with a
 * parent (R6). The doubles behind `ChannelRegistryRepository` apply the adapter's own write rules — the
 * parent CHECK, the parent foreign key, wholesale overwrite replacement — so a case here can prove what the
 * command *chose* rather than what the database would have forgiven it. The SQL and the one-transaction
 * cascade are proven against a real PostgreSQL in
 * `tests/integration/guild-state-event-application.integration.test.ts`.
 *
 * Three decisions carry the rules:
 *
 * - **R6.** A thread is never stored parentless: no parent from any source, or a parent the registry has no
 *   row for, is a refusal returned to the caller for the anomaly path — never a write, and never a thrown
 *   foreign-key error.
 * - **R7.** A reported overwrite set replaces the stored set wholesale; a set that is neither role nor
 *   member-targeted is dropped and counted, never guessed from the id.
 * - **R10.** A payload that carried no overwrite list leaves the stored list alone and reports the gap.
 *   Absent is not empty, so "the update said nothing" must never look like "the channel has no overwrites".
 */

const GUILD_ID = "160000000000000001";
const OTHER_GUILD_ID = "160000000000000999";
const ROLE_BACKEND = "160000000000000010";
const ROLE_OPS = "160000000000000011";
const USER_ONE = "160000000000000101";
const CHANNEL_PRIVATE = "160000000000000201";
const THREAD_PRIVATE = "160000000000000203";
const CATEGORY = "160000000000000204";
const VIEW_CHANNEL = "1024";
const READ_MESSAGE_HISTORY = "65536";
/** Beyond `Number.MAX_SAFE_INTEGER`: the text survives only if nothing coerces it (R3, R7). */
const UNSAFE_BITFIELD = "9007199254740993";

interface Harness {
	readonly command: UpsertChannelCommand;
	readonly registries: RecordingRegistries;
	readonly logger: RecordingLogger;
}

function harness(registries = new RecordingRegistries()): Harness {
	const logger = new RecordingLogger();
	const command = new UpsertChannelCommand({
		config: createGuildStateConfig({ guildId: GUILD_ID }),
		channelRegistry: registries.channelsContract,
		logger
	});
	return { command, registries, logger };
}

function channelRow(
	channelId: string,
	channelType: RegistryChannel["channelType"],
	parentChannelId: string | null
): RegistryChannel {
	return {
		guildId: GUILD_ID,
		channelId,
		channelType,
		name: `channel-${channelId}`,
		position: 3,
		parentChannelId
	};
}

/** A `GUILD_CHANNEL_CREATE`/`_UPDATE`-shaped payload, as the subscription binding hands it. */
function channelEvent(overrides: Partial<UpsertChannelEvent> = {}): UpsertChannelEvent {
	return {
		guildId: GUILD_ID,
		channelId: CHANNEL_PRIVATE,
		channelType: "guild-text",
		name: "private",
		position: 0,
		permissionOverwrites: [
			{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }
		],
		...overrides
	};
}

/** A `THREAD_CREATE`/`THREAD_UPDATE`-shaped payload. */
function threadEvent(overrides: Partial<UpsertChannelEvent> = {}): UpsertChannelEvent {
	return {
		guildId: GUILD_ID,
		channelId: THREAD_PRIVATE,
		channelType: "private-thread",
		name: "incident",
		parentChannelId: CHANNEL_PRIVATE,
		...overrides
	};
}

async function seedChannels(registries: RecordingRegistries, ...rows: readonly RegistryChannel[]): Promise<void> {
	await registries.channelsContract.upsertChannels(rows);
	registries.writes.splice(0, registries.writes.length);
}

describe("UpsertChannelCommand (R6, R7, R9, R10)", () => {
	it("stores a channel event for an id the registry has never seen as a new row (R6)", async () => {
		const { command, registries } = harness();

		const outcome = await command.execute(channelEvent());

		expect(outcome).toMatchObject({ status: "applied", created: true, isThread: false });
		expect(registries.channels.get(CHANNEL_PRIVATE)).toEqual({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			channelType: "guild-text",
			name: "private",
			position: 0,
			parentChannelId: null
		});
	});

	it("replaces the stored overwrite set wholesale, so a withdrawn grant cannot survive (R7)", async () => {
		const registries = new RecordingRegistries();
		const { command } = harness(registries);
		await seedChannels(registries, channelRow(CHANNEL_PRIVATE, "guild-text", null));
		await registries.channelsContract.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [
				{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" },
				{ targetId: ROLE_OPS, targetType: "role", allowBitfield: "0", denyBitfield: "0" }
			]
		});
		registries.writes.splice(0, registries.writes.length);

		const outcome = await command.execute(
			channelEvent({
				// The backend role is simply not in the new set: replacement is not a merge.
				permissionOverwrites: [
					{ targetId: ROLE_OPS, targetType: "role", allowBitfield: "0", denyBitfield: READ_MESSAGE_HISTORY }
				]
			})
		);

		expect(outcome).toMatchObject({ status: "applied", overwriteSetReplaced: true, overwritesWritten: 1 });
		expect(registries.overwriteEntries.get(CHANNEL_PRIVATE)).toEqual([
			{ targetId: ROLE_OPS, targetType: "role", allowBitfield: "0", denyBitfield: READ_MESSAGE_HISTORY }
		]);
		// One row per overwrite write: the sweep and the inserts are the adapter's single transaction.
		expect(registries.writesOf("replaceChannelOverwrites")).toHaveLength(1);
	});

	it("stores an explicitly empty overwrite set as the empty set (R7, R10 boundary)", async () => {
		const registries = new RecordingRegistries();
		const { command } = harness(registries);
		await seedChannels(registries, channelRow(CHANNEL_PRIVATE, "guild-text", null));
		await registries.channelsContract.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }]
		});

		const outcome = await command.execute(channelEvent({ permissionOverwrites: [] }));

		expect(outcome).toMatchObject({ status: "applied", overwriteSetReplaced: true, overwritesWritten: 0 });
		expect(registries.overwriteEntries.get(CHANNEL_PRIVATE)).toEqual([]);
		expect(registries.overwrites.get(CHANNEL_PRIVATE)).toEqual([]);
	});

	it("leaves stored overwrites untouched and reports the gap when the payload carried no set (R10)", async () => {
		const registries = new RecordingRegistries();
		const { command, logger } = harness(registries);
		const stored: ChannelPermissionOverwrite = {
			targetId: ROLE_BACKEND,
			targetType: "role",
			allowBitfield: "0",
			denyBitfield: VIEW_CHANNEL
		};
		await seedChannels(registries, channelRow(CHANNEL_PRIVATE, "guild-text", null));
		await registries.channelsContract.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [stored]
		});
		registries.writes.splice(0, registries.writes.length);

		const event: UpsertChannelEvent = {
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			channelType: "guild-text",
			name: "private",
			position: 0
		};
		const outcome = await command.execute(event);

		expect(outcome).toMatchObject({
			status: "applied",
			overwriteSetReplaced: false,
			pendingRestFields: ["permissionOverwrites"]
		});
		// The deny stays exactly where it was: an absent field never became an empty set.
		expect(registries.overwriteEntries.get(CHANNEL_PRIVATE)).toEqual([stored]);
		expect(registries.writesOf("replaceChannelOverwrites")).toEqual([]);
		// The gap is named for the resync path, with ids only (R14).
		expect(logger.linesAt("warn").at(-1)?.fields).toMatchObject({
			channelId: CHANNEL_PRIVATE,
			pendingRestFields: ["permissionOverwrites"]
		});
	});

	it("drops an overwrite whose target kind is neither role nor member and counts it (R7 error)", async () => {
		const registries = new RecordingRegistries();
		const { command, logger } = harness(registries);

		const outcome = await command.execute(
			channelEvent({
				permissionOverwrites: [
					{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" },
					// A kind the vocabulary does not name: never guessed from the id, never stored.
					{
						targetId: USER_ONE,
						targetType: "channel" as unknown as "member",
						allowBitfield: VIEW_CHANNEL,
						denyBitfield: "0"
					}
				]
			})
		);

		expect(outcome).toMatchObject({
			status: "applied",
			overwritesWritten: 1,
			droppedOverwriteTargetIds: [USER_ONE]
		});
		expect(registries.overwriteEntries.get(CHANNEL_PRIVATE)).toEqual([
			{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }
		]);
		expect(logger.linesAt("warn").at(-1)?.fields).toMatchObject({ droppedOverwriteTargetIds: [USER_ONE] });
	});

	it("stores a thread with its parent as a row of the one registry (R6)", async () => {
		const registries = new RecordingRegistries();
		const { command } = harness(registries);
		await seedChannels(registries, channelRow(CHANNEL_PRIVATE, "guild-text", null));

		const outcome = await command.execute(threadEvent());

		expect(outcome).toMatchObject({ status: "applied", isThread: true, created: true });
		expect(registries.channels.get(THREAD_PRIVATE)).toEqual({
			guildId: GUILD_ID,
			channelId: THREAD_PRIVATE,
			channelType: "private-thread",
			name: "incident",
			position: null,
			parentChannelId: CHANNEL_PRIVATE
		});
	});

	it("refuses a thread event with no parent from any source and writes nothing (R6 error)", async () => {
		const { command, registries, logger } = harness();

		// No parent from any source: the payload simply carries no `parentChannelId`, which is not the same
		// thing as one whose value is undefined (R10's absent-versus-empty rule).
		const parentless: UpsertChannelEvent = {
			guildId: GUILD_ID,
			channelId: THREAD_PRIVATE,
			channelType: "private-thread",
			name: "incident"
		};
		const outcome = await command.execute(parentless);

		expect(outcome).toMatchObject({
			status: "refused",
			reason: "thread-parent-missing",
			channelId: THREAD_PRIVATE,
			parentChannelId: null
		});
		expect(registries.channels.has(THREAD_PRIVATE)).toBe(false);
		expect(registries.writes).toEqual([]);
		// Logged with the thread's id, because that is what the anomaly path retries (R14).
		expect(logger.linesAt("warn").at(-1)?.fields).toMatchObject({
			channelId: THREAD_PRIVATE,
			reason: "thread-parent-missing"
		});
	});

	it("refuses a thread whose parent the registry has no row for, and converges once it arrives (R6, R10)", async () => {
		const registries = new RecordingRegistries();
		const { command } = harness(registries);

		const event = threadEvent({ parentChannelId: CATEGORY });
		expect(await command.execute(event)).toMatchObject({
			status: "refused",
			reason: "parent-not-registered",
			parentChannelId: CATEGORY
		});
		expect(registries.channels.has(THREAD_PRIVATE)).toBe(false);

		// The category is registered by its own event; the replay of the same thread event now applies.
		await command.execute(
			channelEvent({ channelId: CATEGORY, channelType: "guild-category", permissionOverwrites: [] })
		);
		expect(await command.execute(event)).toMatchObject({ status: "applied", created: true });
		expect(registries.channels.get(THREAD_PRIVATE)?.parentChannelId).toBe(CATEGORY);
	});

	it("refuses a channel whose reported category parent is not registered, instead of storing it parentless (R6)", async () => {
		const { command, registries } = harness();

		const outcome = await command.execute(channelEvent({ parentChannelId: CATEGORY }));

		expect(outcome).toMatchObject({ status: "refused", reason: "parent-not-registered" });
		expect(registries.channels.has(CHANNEL_PRIVATE)).toBe(false);
		expect(registries.writes).toEqual([]);
	});

	it("completes a field the payload omitted from the stored row instead of blanking it (R10)", async () => {
		const registries = new RecordingRegistries();
		const { command } = harness(registries);
		await seedChannels(
			registries,
			channelRow(CATEGORY, "guild-category", null),
			channelRow(CHANNEL_PRIVATE, "guild-text", CATEGORY)
		);

		// An update that carried a new position only: no name, no parent, no overwrite list.
		const outcome = await command.execute({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			channelType: "guild-text",
			position: 7
		});

		expect(outcome).toMatchObject({
			status: "applied",
			created: false,
			completedFields: ["name", "parentChannelId"]
		});
		expect(registries.channels.get(CHANNEL_PRIVATE)).toEqual({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			channelType: "guild-text",
			name: `channel-${CHANNEL_PRIVATE}`,
			position: 7,
			parentChannelId: CATEGORY
		});
	});

	it("keeps a bitfield beyond the safe-integer range exactly as Discord encoded it (R3, R7)", async () => {
		const { command, registries } = harness();

		await command.execute(
			channelEvent({
				permissionOverwrites: [
					{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: UNSAFE_BITFIELD, denyBitfield: "0" }
				]
			})
		);

		expect(registries.overwriteEntries.get(CHANNEL_PRIVATE)?.[0]?.allowBitfield).toBe(UNSAFE_BITFIELD);
	});

	it("replays a channel event to identical state, including its overwrite set (R9)", async () => {
		const { command, registries } = harness();

		const event = channelEvent();
		expect(await command.execute(event)).toMatchObject({ status: "applied", created: true });
		const before = registries.state();
		expect(await command.execute(event)).toMatchObject({ status: "applied", created: false });

		expect(registries.state()).toEqual(before);
		expect(registries.channels.size).toBe(1);
		expect(registries.overwriteEntries.get(CHANNEL_PRIVATE)).toHaveLength(1);
	});

	it("drops a channel event that names another Guild, writing nothing (R1)", async () => {
		const { command, registries, logger } = harness();

		const outcome = await command.execute(channelEvent({ guildId: OTHER_GUILD_ID }));

		expect(outcome).toMatchObject({ status: "dropped", reason: "foreign-guild" });
		expect(registries.writes).toEqual([]);
		expect(registries.channels.size).toBe(0);
		const warn = logger.linesAt("warn")[0];
		expect(JSON.stringify(warn?.fields)).toContain(OTHER_GUILD_ID);
		// R14: a dropped event is named by its ids, and a channel never stores or logs more than that anyway.
		expect(JSON.stringify(warn?.fields)).not.toContain("private");
	});

	it("logs ids and counts only — never the channel name (R14)", async () => {
		const { command, logger } = harness();

		await command.execute(channelEvent({ name: "secret-planning", permissionOverwrites: [] }));

		const transcript = logger.transcript();
		expect(transcript).toContain(GUILD_ID);
		expect(transcript).toContain(CHANNEL_PRIVATE);
		expect(transcript).not.toContain("secret-planning");
		expect(transcript).not.toContain(VIEW_CHANNEL);
	});

	it("refuses a bitfield that arrived as a number instead of storing a coerced grant (R7)", async () => {
		const { command, registries } = harness();

		const coerced = channelEvent({
			permissionOverwrites: [
				{
					targetId: ROLE_BACKEND,
					targetType: "role",
					allowBitfield: Number(VIEW_CHANNEL) as unknown as string,
					denyBitfield: "0"
				}
			]
		});

		await expect(command.execute(coerced)).rejects.toBeInstanceOf(InvalidPermissionBitfieldError);
		expect(registries.writes).toEqual([]);
	});

	it("refuses a position that is not a whole number instead of rounding it into the row (R6)", async () => {
		const { command, registries } = harness();

		await expect(command.execute(channelEvent({ position: 1.5 }))).rejects.toThrow(/channel_position/);
		expect(registries.writes).toEqual([]);
	});

	it("refuses an id that cannot live in a bigint column (R9 natural keys)", async () => {
		const { command, registries } = harness();

		await expect(command.execute(channelEvent({ channelId: "not-an-id" }))).rejects.toThrow(/channel\.channel_id/);
		await expect(command.execute(threadEvent({ parentChannelId: "not-an-id" }))).rejects.toThrow(
			/channel.parent_channel_id/
		);
		expect(registries.writes).toEqual([]);
	});

	it("writes no overwrite rows for a thread event that reported none, leaving other channels alone (R7)", async () => {
		const registries = new RecordingRegistries();
		const { command } = harness(registries);
		await seedChannels(registries, channelRow(CHANNEL_PRIVATE, "guild-text", null));
		await registries.channelsContract.replaceChannelOverwrites({
			guildId: GUILD_ID,
			channelId: CHANNEL_PRIVATE,
			overwrites: [{ targetId: ROLE_BACKEND, targetType: "role", allowBitfield: VIEW_CHANNEL, denyBitfield: "0" }]
		});

		await command.execute(threadEvent());

		expect(registries.overwriteEntries.get(CHANNEL_PRIVATE)).toHaveLength(1);
		expect(registries.overwriteEntries.has(THREAD_PRIVATE)).toBe(false);
	});
});
