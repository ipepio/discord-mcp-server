import { describe, expect, it } from "vitest";
import { ApplyMessageDeletionCommand } from "../../../src/features/ingestion/commands/apply-message-deletion.command.js";
import type { ApplyMessageDeletionEvent } from "../../../src/features/ingestion/commands/apply-message-deletion.command.js";
import { createIngestionConfig } from "../../../src/features/ingestion/config/ingestion-config.interface.js";
import {
	CHANNEL_ID,
	CREATED_AT,
	DELETED_AT,
	EDITED_AT,
	GUILD_ID,
	MESSAGE_ID,
	OTHER_GUILD_ID,
	SECRET_CONTENT,
	SECRET_FILENAME,
	SECRET_URL,
	THREAD_ID,
	attachment,
	storedMessage
} from "./fakes/message-fixtures.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import { RecordingMessageStore, seedRows } from "./fakes/recording-message-store.js";

/**
 * T2 — `MESSAGE_DELETE` and `MESSAGE_DELETE_BULK` applied to the message store (docs/features/ingestion.md R6,
 * with R4, R7, R1 and R12; ADR-0007).
 *
 * One command for both events, because one fact is being mirrored: Discord says these ids are gone. The cases
 * are the four fates an id can have, and the promise that each is reported differently:
 *
 * - **Tombstoned now.** Content and attachment metadata disappear, every identifying fact stays (R6, ADR-0007),
 *   and the instant is the one the hub's clock was set to — not a wall-clock read a test could not pin.
 * - **Already tombstoned.** A replay changes nothing, `deleted_at` included, and is counted apart so the
 *   difference between "deleted twice" and "deleted once, seen twice" survives the trip to a log line (R7).
 * - **Never ingested.** Counted and named, and no row is written for it: a hub that never saw the message
 *   cannot mirror its deletion (R4's error case).
 * - **Another Guild's.** Refused before any statement, counted as an anomaly, and the ids are reported so the
 *   anomaly is attributable without storing a single thing (R1).
 *
 * The SQL — the sweep of attachment rows in the same transaction as the content drop, the bounded id batches,
 * the constraint that makes a tombstone-with-content impossible — is proven against a real PostgreSQL in
 * `tests/integration/ingestion-message-events.integration.test.ts`.
 */

const MESSAGE_TWO = "160000000000000402";
const MESSAGE_THREE = "160000000000000403";
const NEVER_SEEN = "160000000000000777";
const OBSERVED_AT = new Date("2026-03-04T09:00:00.000Z");

interface Harness {
	readonly command: ApplyMessageDeletionCommand;
	readonly store: RecordingMessageStore;
	readonly logger: RecordingLogger;
}

function harness(store = new RecordingMessageStore(), now: Date = OBSERVED_AT): Harness {
	const logger = new RecordingLogger();
	return {
		command: new ApplyMessageDeletionCommand({
			config: createIngestionConfig({ guildId: GUILD_ID }),
			messageStore: store,
			logger,
			clock: () => now
		}),
		store,
		logger
	};
}

/** A `MESSAGE_DELETE` (one id) or `MESSAGE_DELETE_BULK` (many) payload, as the binding hands it. */
function deletionEvent(overrides: Partial<ApplyMessageDeletionEvent> = {}): ApplyMessageDeletionEvent {
	return { guildId: GUILD_ID, channelId: CHANNEL_ID, messageIds: [MESSAGE_ID], ...overrides };
}

function seedMessage(
	store: RecordingMessageStore,
	messageId: string,
	overrides: Partial<ReturnType<typeof storedMessage>> = {}
): void {
	seedRows(store, storedMessage({ messageId, content: SECRET_CONTENT, attachments: [attachment()], ...overrides }));
}

describe("ApplyMessageDeletionCommand — the deletion itself (R6, ADR-0007)", () => {
	it("tombstones one message, dropping its content and attachment metadata and keeping every id", async () => {
		const store = new RecordingMessageStore();
		const { command } = harness(store);
		seedMessage(store, MESSAGE_ID, { editedInstant: EDITED_AT });

		const outcome = await command.execute(deletionEvent());

		expect(outcome).toMatchObject({
			status: "applied",
			requested: 1,
			messagesTombstoned: 1,
			attachmentsRemoved: 1,
			alreadyTombstoned: 0,
			unknownMessageIds: [],
			deletedAt: OBSERVED_AT
		});
		expect(store.rows.get(MESSAGE_ID)).toMatchObject({
			messageId: MESSAGE_ID,
			guildId: GUILD_ID,
			channelId: CHANNEL_ID,
			authorId: "160000000000000101",
			createdInstant: CREATED_AT,
			editedInstant: EDITED_AT,
			content: null,
			attachments: [],
			deletedAt: OBSERVED_AT
		});
	});

	it("keeps the author's identity and drops what the author wrote: ADR-0007's retained columns, exactly", async () => {
		const store = new RecordingMessageStore();
		const { command } = harness(store);
		seedMessage(store, MESSAGE_ID);

		await command.execute(deletionEvent());

		const stored = store.rows.get(MESSAGE_ID);
		expect(stored?.authorId).toBe("160000000000000101");
		expect(stored?.createdInstant).toEqual(CREATED_AT);
		expect(stored?.deletedAt).toEqual(OBSERVED_AT);
		expect(stored?.content).toBeNull();
		expect(stored?.attachments).toEqual([]);
	});

	it("tombstones a bulk deletion's whole id list in one call, counting every one", async () => {
		const store = new RecordingMessageStore();
		const { command } = harness(store);
		seedMessage(store, MESSAGE_ID);
		seedMessage(store, MESSAGE_TWO, { channelId: THREAD_ID });
		seedMessage(store, MESSAGE_THREE, { channelId: THREAD_ID });

		const outcome = await command.execute(deletionEvent({ messageIds: [MESSAGE_ID, MESSAGE_TWO, MESSAGE_THREE] }));

		expect(outcome).toMatchObject({
			status: "applied",
			requested: 3,
			messagesTombstoned: 3,
			attachmentsRemoved: 3
		});
		expect([...store.rows.values()].every((row) => row.deletedAt !== null)).toBe(true);
		expect(store.callsTo("tombstoneMessages")).toHaveLength(1);
	});

	it("names the instant from its own clock, so a tombstone instant is a fixed fact rather than a wall-clock read", async () => {
		const store = new RecordingMessageStore();
		const { command } = harness(store, DELETED_AT);
		seedMessage(store, MESSAGE_ID);

		const outcome = await command.execute(deletionEvent());

		expect(outcome).toMatchObject({ status: "applied", deletedAt: DELETED_AT });
		expect(store.rows.get(MESSAGE_ID)?.deletedAt).toEqual(DELETED_AT);
	});
});

describe("ApplyMessageDeletionCommand — the fates that are not a deletion (R4, R7)", () => {
	it("changes nothing when the same deletion arrives twice, and keeps the first tombstone instant (R7)", async () => {
		const store = new RecordingMessageStore();
		const first = harness(store, OBSERVED_AT);
		seedMessage(store, MESSAGE_ID);
		await first.command.execute(deletionEvent());

		// A redelivery observed later must not move the instant: the state after the second delivery has to be
		// indistinguishable from the state after the first.
		const later = new Date("2026-03-09T00:00:00.000Z");
		const replay = harness(store, later);
		const outcome = await replay.command.execute(deletionEvent());

		expect(outcome).toMatchObject({
			status: "applied",
			messagesTombstoned: 0,
			alreadyTombstoned: 1,
			attachmentsRemoved: 0
		});
		expect(store.rows.get(MESSAGE_ID)?.deletedAt).toEqual(OBSERVED_AT);
		expect(store.rows.get(MESSAGE_ID)?.content).toBeNull();
	});

	it("counts the ids the store never had and invents no tombstone for them (R4's error case)", async () => {
		const store = new RecordingMessageStore();
		const { command, logger } = harness(store);
		seedMessage(store, MESSAGE_ID);

		const outcome = await command.execute(deletionEvent({ messageIds: [MESSAGE_ID, NEVER_SEEN] }));

		expect(outcome).toMatchObject({
			status: "applied",
			requested: 2,
			messagesTombstoned: 1,
			unknownMessageIds: [NEVER_SEEN]
		});
		expect(store.rows.size).toBe(1);
		expect(logger.messagesMatching("the store never had")).toHaveLength(1);
		expect(logger.linesAt("warn").at(-1)?.fields).toMatchObject({ unknownMessageIds: [NEVER_SEEN] });
	});

	it("reports a deletion of nothing it had as counted no-ops rather than as a success", async () => {
		const store = new RecordingMessageStore();
		const { command } = harness(store);

		const outcome = await command.execute(deletionEvent({ messageIds: [MESSAGE_ID, MESSAGE_TWO] }));

		expect(outcome).toMatchObject({
			status: "applied",
			requested: 2,
			messagesTombstoned: 0,
			alreadyTombstoned: 0,
			unknownMessageIds: [MESSAGE_ID, MESSAGE_TWO]
		});
		expect(store.rows.size).toBe(0);
	});

	it("refuses a deletion that names no id at all, rather than sweeping the guild (R6)", async () => {
		const store = new RecordingMessageStore();
		const { command } = harness(store);
		seedMessage(store, MESSAGE_ID);

		await expect(command.execute(deletionEvent({ messageIds: [] }))).rejects.toMatchObject({
			field: "message.message_ids"
		});
		expect(store.calls).toEqual([]);
		expect(store.rows.get(MESSAGE_ID)?.deletedAt).toBeNull();
	});

	it("refuses an id in the list that cannot land in a `bigint` column, before any statement", async () => {
		const store = new RecordingMessageStore();
		const { command } = harness(store);
		seedMessage(store, MESSAGE_ID);

		await expect(
			command.execute(deletionEvent({ messageIds: [MESSAGE_ID, "not-a-snowflake"] }))
		).rejects.toMatchObject({ field: "message.message_id" });
		expect(store.calls).toEqual([]);
	});
});

describe("ApplyMessageDeletionCommand — the guild boundary and the log (R1, R12)", () => {
	it("refuses an event that names another guild, before any statement runs (R1)", async () => {
		const store = new RecordingMessageStore();
		const { command, logger } = harness(store);
		seedMessage(store, MESSAGE_ID);

		const outcome = await command.execute(deletionEvent({ guildId: OTHER_GUILD_ID }));

		expect(outcome).toEqual({
			status: "dropped",
			guildId: GUILD_ID,
			channelId: CHANNEL_ID,
			requested: 1,
			reason: "foreign-guild"
		});
		expect(store.calls).toEqual([]);
		expect(store.rows.get(MESSAGE_ID)?.deletedAt).toBeNull();
		expect(store.rows.get(MESSAGE_ID)?.content).toBe(SECRET_CONTENT);
		expect(logger.messagesMatching("another guild")).toHaveLength(1);
	});

	it("will not tombstone another guild's row through this guild's event (R1)", async () => {
		const store = new RecordingMessageStore();
		const { command } = harness(store);
		seedRows(store, storedMessage({ messageId: MESSAGE_ID, guildId: OTHER_GUILD_ID }));

		const outcome = await command.execute(deletionEvent());

		expect(outcome).toMatchObject({ messagesTombstoned: 0, unknownMessageIds: [MESSAGE_ID] });
		expect(store.rows.get(MESSAGE_ID)?.deletedAt).toBeNull();
	});

	it("carries ids and counts on every path, and content or attachment metadata on none (R12)", async () => {
		const store = new RecordingMessageStore();
		const { command, logger } = harness(store);
		seedMessage(store, MESSAGE_ID, { attachments: [attachment(), attachment("160000000000000502")] });

		await command.execute(deletionEvent({ messageIds: [MESSAGE_ID, NEVER_SEEN] }));

		const transcript = logger.transcript();
		for (const secret of [SECRET_CONTENT, SECRET_FILENAME, SECRET_URL]) {
			expect(transcript).not.toContain(secret);
		}
		expect(transcript).toContain(MESSAGE_ID);
		expect(transcript).toContain(NEVER_SEEN);
		expect(transcript).toContain('"attachmentsRemoved":2');
	});

	it("leaves a thread's messages tombstoned under the thread's own container id", async () => {
		const store = new RecordingMessageStore();
		const { command } = harness(store);
		seedMessage(store, MESSAGE_ID, { channelId: THREAD_ID });

		await command.execute(deletionEvent({ channelId: THREAD_ID }));

		expect(store.rows.get(MESSAGE_ID)).toMatchObject({ channelId: THREAD_ID, deletedAt: OBSERVED_AT });
	});

	it("writes no row for an id it never had, so a later read still reports absence", async () => {
		const store = new RecordingMessageStore();
		const { command } = harness(store);

		await command.execute(deletionEvent({ messageIds: [MESSAGE_ID] }));

		expect(store.rows.size).toBe(0);
		expect(await store.findMessage(GUILD_ID, MESSAGE_ID)).toBeNull();
	});
});
