import { describe, expect, it } from "vitest";
import { ApplyMessageEditCommand } from "../../../src/features/ingestion/commands/apply-message-edit.command.js";
import type { ApplyMessageEditEvent } from "../../../src/features/ingestion/commands/apply-message-edit.command.js";
import type { MessageRestGateway } from "../../../src/features/ingestion/gateways/message-rest-gateway.interface.js";
import { createIngestionConfig } from "../../../src/features/ingestion/config/ingestion-config.interface.js";
import type { DiscordMessageRecord } from "../../../src/features/discord/index.js";
import {
	CHANNEL_ID,
	CREATED_AT,
	EDITED_AT,
	GUILD_ID,
	LATER_EDIT_AT,
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
import {
	FakeMessageRestGateway,
	reconciliationAttachment,
	reconciliationRecord
} from "./fakes/fake-message-rest-gateway.js";
import { payloadOf, withoutKey } from "./fakes/payload-shape.js";

/**
 * T2 — `MESSAGE_UPDATE` applied to the message store (docs/features/ingestion.md R5, with R7, R8, R10, R11, R12).
 *
 * The store double refuses the same edits the PostgreSQL guard refuses, so every case below proves a *command*
 * decision rather than a double's opinion. The three that carry the rule:
 *
 * - **A complete update is written directly**, with one statement and no Discord read at all — which is what
 *   keeps an ordinary edit from spending a rate-limited request it does not need (R7's bounds).
 * - **A partial update is reconciled first**: exactly one `readMessage` for the message the event named, then
 *   the guarded write of the *completed* state. Where the event and the read disagree the event wins, because
 *   the event is the newer observation and a read that answers after it must not restore text the author
 *   already replaced (R5, R8).
 * - **A reconciliation that cannot be had writes nothing.** The stored state stays exactly as it was, no field
 *   is invented, and the outcome carries the boundary's own reason (R10).
 *
 * The read itself — its timeout, its retry bound, its refusal to retry a client error, its payload validation —
 * is proven in `tests/features/discord/gateways/discord-rest.gateway.test.ts`; the guard's SQL is proven against
 * a real PostgreSQL in `tests/integration/ingestion-message-events.integration.test.ts`.
 */

const ATTACHMENT_ONE = "160000000000000501";
const ATTACHMENT_TWO = "160000000000000502";
const DELETED_AT = new Date("2026-03-05T00:00:00.000Z");

interface Harness {
	readonly command: ApplyMessageEditCommand;
	readonly store: RecordingMessageStore;
	readonly rest: FakeMessageRestGateway;
	readonly logger: RecordingLogger;
}

function harness(store = new RecordingMessageStore(), rest = new FakeMessageRestGateway()): Harness {
	const logger = new RecordingLogger();
	return {
		command: new ApplyMessageEditCommand({
			config: createIngestionConfig({ guildId: GUILD_ID }),
			messageStore: store,
			messageRest: rest,
			logger
		}),
		store,
		rest,
		logger
	};
}

/**
 * A `MESSAGE_UPDATE`-shaped payload. `omit` is how a partial update is built: the field is absent, not
 * `undefined`, which is the distinction R5 turns on (see `fakes/payload-shape.ts`).
 */
function editEvent(
	overrides: Partial<ApplyMessageEditEvent> = {},
	omit: readonly string[] = []
): ApplyMessageEditEvent {
	return payloadOf<ApplyMessageEditEvent>(
		{
			guildId: GUILD_ID,
			messageId: MESSAGE_ID,
			channelId: CHANNEL_ID,
			content: "the edited text",
			editedInstant: EDITED_AT,
			...overrides
		},
		omit
	);
}

/** One stored row in a chosen state: the state the guard compares an incoming edit against. */
function seed(store: RecordingMessageStore, overrides: Partial<ReturnType<typeof storedMessage>> = {}): void {
	seedRows(store, storedMessage({ content: "the first text", createdInstant: CREATED_AT, ...overrides }));
}

describe("ApplyMessageEditCommand — a complete update is written directly (R5, R7)", () => {
	it("replaces content and edited instant with one write and no Discord read at all", async () => {
		const store = new RecordingMessageStore();
		const { command, rest } = harness(store);
		seed(store);

		const outcome = await command.execute(editEvent());

		expect(outcome).toMatchObject({ status: "applied", reconciled: false, storedEditedInstant: EDITED_AT });
		expect(store.rows.get(MESSAGE_ID)).toMatchObject({ content: "the edited text", editedInstant: EDITED_AT });
		expect(store.operationOrder()).toEqual(["applyMessageEdit"]);
		expect(rest.calls).toEqual([]);
	});

	it("names a replay of the identical edit as changed nothing, and writes no content (R7)", async () => {
		const store = new RecordingMessageStore();
		const { command, rest } = harness(store);
		seed(store, { content: "the edited text", editedInstant: EDITED_AT });

		const outcome = await command.execute(editEvent());

		expect(outcome).toMatchObject({ status: "refused", reason: "unchanged", reconciled: false });
		expect(store.rows.get(MESSAGE_ID)?.content).toBe("the edited text");
		expect(rest.calls).toEqual([]);
	});

	it("refuses an older edit instant arriving after a newer one, leaving the stored text alone (R5, R8)", async () => {
		const store = new RecordingMessageStore();
		const { command } = harness(store);
		seed(store, { content: "the newest text", editedInstant: LATER_EDIT_AT });

		const outcome = await command.execute(editEvent({ content: "an older revision" }));

		expect(outcome).toMatchObject({ status: "refused", reason: "stale", storedEditedInstant: LATER_EDIT_AT });
		expect(store.rows.get(MESSAGE_ID)).toMatchObject({ content: "the newest text", editedInstant: LATER_EDIT_AT });
	});

	it("refuses an edit of a message the store never ingested instead of inventing a row from half a payload (R4)", async () => {
		const { command, store } = harness();

		const outcome = await command.execute(editEvent());

		expect(outcome).toMatchObject({ status: "refused", reason: "absent", storedEditedInstant: null });
		expect(store.rows.size).toBe(0);
	});

	it("refuses an edit of a tombstoned message: a deletion is terminal (R6, ADR-0007)", async () => {
		const store = new RecordingMessageStore();
		const { command } = harness(store);
		seed(store, { content: null, attachments: [], deletedAt: DELETED_AT });

		const outcome = await command.execute(editEvent({ content: "text from a late delivery" }));

		expect(outcome).toMatchObject({ status: "refused", reason: "tombstoned" });
		expect(store.rows.get(MESSAGE_ID)?.content).toBeNull();
	});

	it("leaves the stored attachment set exactly as it was, because an edit payload reports none (R10, R11)", async () => {
		const store = new RecordingMessageStore();
		const { command } = harness(store);
		seed(store, { attachments: [attachment(ATTACHMENT_ONE), attachment(ATTACHMENT_TWO)] });

		const outcome = await command.execute(editEvent());

		expect(outcome).toMatchObject({ status: "applied", attachmentsWritten: 0, attachmentsRemoved: 0 });
		expect(store.rows.get(MESSAGE_ID)?.attachments.map((row) => row.attachmentId)).toEqual([
			ATTACHMENT_ONE,
			ATTACHMENT_TWO
		]);
	});

	it("keeps the stored message type when the payload said nothing about it, and replaces it when it did (R5)", async () => {
		const silent = new RecordingMessageStore();
		const silentHarness = harness(silent);
		seed(silent, { messageType: "reply" });
		await silentHarness.command.execute(editEvent({}, ["messageType"]));
		expect(silent.rows.get(MESSAGE_ID)?.messageType).toBe("reply");

		const reported = new RecordingMessageStore();
		const reportedHarness = harness(reported);
		seed(reported, { messageType: "default" });
		await reportedHarness.command.execute(editEvent({ messageType: "reply" }));
		expect(reported.rows.get(MESSAGE_ID)?.messageType).toBe("reply");
	});

	it("refuses a payload that asserts nothing, and spends no read on it (R5, R7)", async () => {
		const { command, store, rest, logger } = harness();

		// A flags or pin change: the payload names neither new text nor an edit instant.
		const outcome = await command.execute(editEvent({ messageType: "reply" }, ["content", "editedInstant"]));

		expect(outcome).toMatchObject({ status: "refused", reason: "nothing-asserted", reconciled: false });
		expect(rest.calls).toEqual([]);
		expect(store.calls).toEqual([]);
		expect(logger.transcript()).toContain("nothing-asserted");
	});
});

describe("ApplyMessageEditCommand — a partial update is reconciled first (R5)", () => {
	it("reads the message whole by id and writes the text the read reported", async () => {
		const store = new RecordingMessageStore();
		const { command, rest } = harness(store);
		seed(store);
		rest.record = reconciliationRecord({ content: "the text Discord reports now" });

		const outcome = await command.execute(editEvent({}, ["content"]));

		expect(outcome).toMatchObject({ status: "applied", reconciled: true, storedEditedInstant: EDITED_AT });
		expect(store.rows.get(MESSAGE_ID)?.content).toBe("the text Discord reports now");
		// One read for one message, addressed by both ids the event named, then one guarded write.
		expect(rest.calls).toEqual([{ channelId: CHANNEL_ID, messageId: MESSAGE_ID }]);
		expect(store.operationOrder()).toEqual(["applyMessageEdit"]);
	});

	it("reconciles an update that reported the edit instant but not the text", async () => {
		const store = new RecordingMessageStore();
		const { command, rest } = harness(store);
		seed(store);
		// The read has no edit instant either: the event's own instant is then the only instant the state has.
		rest.record = withoutKey(reconciliationRecord({ content: "the whole text from the read" }), "editedInstant");

		const outcome = await command.execute(editEvent({ editedInstant: LATER_EDIT_AT }, ["content"]));

		expect(outcome).toMatchObject({ status: "applied", reconciled: true });
		expect(store.rows.get(MESSAGE_ID)).toMatchObject({
			content: "the whole text from the read",
			editedInstant: LATER_EDIT_AT
		});
	});

	it("does not reconcile a payload that reported neither field: that is not an edit of content (R5, R7)", async () => {
		// `editAssertsNothing` is the rule, and it runs before the reconciliation decision: Discord sends this for
		// a pin or flags change, and spending a rate-limited read to rewrite text nobody changed is not R5.
		const { command, store, rest } = harness();

		const outcome = await command.execute(editEvent({}, ["content", "editedInstant"]));

		expect(outcome).toMatchObject({ status: "refused", reason: "nothing-asserted", reconciled: false });
		expect(rest.calls).toEqual([]);
		expect(store.calls).toEqual([]);
	});

	it("keeps the text the event itself carried over an older revision the read still shows (R8)", async () => {
		const store = new RecordingMessageStore();
		const { command, rest } = harness(store);
		seed(store);
		rest.record = reconciliationRecord({ content: "an older revision the read still shows" });

		await command.execute(editEvent({}, ["editedInstant"]));

		expect(store.rows.get(MESSAGE_ID)).toMatchObject({ content: "the edited text", editedInstant: EDITED_AT });
	});

	it("reconciles a thread message through the thread's own id (R2 there)", async () => {
		const { command, rest } = harness();
		rest.record = reconciliationRecord({ channelId: THREAD_ID });

		await command.execute(editEvent({ channelId: THREAD_ID }, ["content"]));

		expect(rest.addressed()).toEqual([[THREAD_ID, MESSAGE_ID]]);
	});

	it("takes the attachment set from the read — the only source an edit has — and replaces it whole (R11)", async () => {
		const store = new RecordingMessageStore();
		const { command, rest } = harness(store);
		seed(store, { attachments: [attachment(ATTACHMENT_ONE), attachment(ATTACHMENT_TWO)] });
		rest.record = reconciliationRecord({ attachments: [reconciliationAttachment(ATTACHMENT_TWO)] });

		const outcome = await command.execute(editEvent({}, ["content"]));

		expect(outcome).toMatchObject({ status: "applied", attachmentsRemoved: 2, attachmentsWritten: 1 });
		expect(store.rows.get(MESSAGE_ID)?.attachments.map((row) => row.attachmentId)).toEqual([ATTACHMENT_TWO]);
	});

	it("leaves the stored set untouched when the read reported no attachment list at all (R10, R11)", async () => {
		const store = new RecordingMessageStore();
		const { command, rest } = harness(store);
		seed(store, { attachments: [attachment(ATTACHMENT_ONE)] });
		rest.record = withoutKey(reconciliationRecord(), "attachments");

		const outcome = await command.execute(editEvent({}, ["content"]));

		expect(outcome).toMatchObject({ status: "applied", attachmentsWritten: 0, attachmentsRemoved: 0 });
		expect(store.rows.get(MESSAGE_ID)?.attachments.map((row) => row.attachmentId)).toEqual([ATTACHMENT_ONE]);
	});

	it("refuses a reconciled state that is older than what the store already holds (R5, R8)", async () => {
		const store = new RecordingMessageStore();
		const { command, rest } = harness(store);
		seed(store, { content: "the newest text", editedInstant: LATER_EDIT_AT });
		rest.record = reconciliationRecord({ content: "a stale revision", editedInstant: EDITED_AT });

		const outcome = await command.execute(editEvent({}, ["content"]));

		expect(outcome).toMatchObject({ status: "refused", reason: "stale", reconciled: true });
		expect(store.rows.get(MESSAGE_ID)?.content).toBe("the newest text");
	});

	it("writes nothing when the read cannot be had, and names which boundary failure stopped it (R5, R10)", async () => {
		const store = new RecordingMessageStore();
		const { command, rest, logger } = harness(store);
		seed(store);
		rest.failWith("timeout", { attempts: 3 });

		const outcome = await command.execute(editEvent({}, ["content"]));

		expect(outcome).toEqual({
			status: "deferred",
			guildId: GUILD_ID,
			messageId: MESSAGE_ID,
			channelId: CHANNEL_ID,
			reason: "reconcile-unavailable",
			missingFields: ["content"],
			failure: { reason: "timeout", attempts: 3, status: null, fieldPath: null }
		});
		// The half-state the event carried is not a state to store: the store was never reached.
		expect(store.calls).toEqual([]);
		expect(store.rows.get(MESSAGE_ID)?.content).toBe("the first text");
		expect(logger.linesAt("warn").at(-1)?.fields).toMatchObject({
			reason: "timeout",
			attempts: 3,
			missingFields: ["content"],
			operation: "discord-rest.message"
		});
	});

	it("defers for every failure the boundary can report, carrying its reason, status and field path", async () => {
		for (const [reason, extra] of [
			["not-found", { status: 404 }],
			["unauthorized", { status: 403 }],
			["client-error", { status: 400 }],
			["server-error", { status: 500 }],
			["rate-limit", { status: 429 }],
			["transport", {}],
			["validation", { fieldPath: "attachments[0].url" }]
		] as const) {
			const store = new RecordingMessageStore();
			const { command, rest } = harness(store);
			seed(store, { content: "the stored text" });
			rest.failWith(reason, extra);

			const outcome = await command.execute(editEvent({}, ["content"]));

			expect(outcome).toMatchObject({
				status: "deferred",
				reason: "reconcile-unavailable",
				failure: { reason, ...extra }
			});
			expect(store.calls).toEqual([]);
			expect(store.rows.get(MESSAGE_ID)?.content).toBe("the stored text");
		}
	});

	it("does not swallow a failure that is not the boundary's: a defect surfaces instead of deferring", async () => {
		const defective: MessageRestGateway = {
			readMessage: async (): Promise<DiscordMessageRecord> => {
				throw new Error("the seam itself is broken");
			}
		};
		const store = new RecordingMessageStore();
		const command = new ApplyMessageEditCommand({
			config: createIngestionConfig({ guildId: GUILD_ID }),
			messageStore: store,
			messageRest: defective,
			logger: new RecordingLogger()
		});

		await expect(command.execute(editEvent({}, ["content"]))).rejects.toThrow("the seam itself is broken");
		expect(store.calls).toEqual([]);
	});

	it("reconciles once per event, whatever the store then decided about the write (R7 bounds)", async () => {
		const store = new RecordingMessageStore();
		const { command, rest } = harness(store);
		seed(store, { content: "the stored text", editedInstant: LATER_EDIT_AT });
		rest.record = reconciliationRecord();

		await command.execute(editEvent({}, ["content"]));
		await command.execute(editEvent({}, ["content"]));

		expect(rest.calls).toHaveLength(2);
		expect(store.callsTo("applyMessageEdit")).toHaveLength(2);
	});
});

describe("ApplyMessageEditCommand — the boundaries that are not edits (R1, R4, R12)", () => {
	it("refuses an event that names another guild before a read and before a write (R1)", async () => {
		const { command, store, rest, logger } = harness();

		const outcome = await command.execute(editEvent({ guildId: OTHER_GUILD_ID }, ["content"]));

		expect(outcome).toEqual({
			status: "dropped",
			guildId: GUILD_ID,
			messageId: MESSAGE_ID,
			channelId: CHANNEL_ID,
			reason: "foreign-guild"
		});
		expect(store.calls).toEqual([]);
		expect(rest.calls).toEqual([]);
		expect(logger.messagesMatching("another guild")).toHaveLength(1);
	});

	it("refuses an id that cannot land in a `bigint` column before either the read or the write", async () => {
		const { command, store, rest } = harness();

		await expect(command.execute(editEvent({ messageId: "not-a-snowflake" }))).rejects.toMatchObject({
			field: "message.message_id"
		});
		expect(store.calls).toEqual([]);
		expect(rest.calls).toEqual([]);
	});

	it("carries ids, field counts and reasons on every path, and content on none (R12)", async () => {
		const store = new RecordingMessageStore();
		const { command, rest, logger } = harness(store);
		seed(store, { attachments: [attachment(ATTACHMENT_ONE)] });
		rest.record = reconciliationRecord({ content: SECRET_CONTENT });

		await command.execute(editEvent({ content: SECRET_CONTENT }));
		await command.execute(editEvent({}, ["content", "editedInstant"]));
		await command.execute(editEvent({ messageId: "160000000000000999" }));
		rest.failWith("timeout");
		await command.execute(editEvent({}, ["content"]));

		const transcript = logger.transcript();
		for (const secret of [SECRET_CONTENT, SECRET_FILENAME, SECRET_URL]) {
			expect(transcript).not.toContain(secret);
		}
		expect(transcript).toContain(MESSAGE_ID);
		expect(transcript).toContain(CHANNEL_ID);
		expect(transcript).toContain("deferred");
	});
});
