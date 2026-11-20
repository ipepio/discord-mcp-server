import { describe, expect, it } from "vitest";
import { RecordMessageCommand } from "../../../src/features/ingestion/commands/record-message.command.js";
import type { RecordMessageEvent } from "../../../src/features/ingestion/commands/record-message.command.js";
import { createIngestionConfig } from "../../../src/features/ingestion/config/ingestion-config.interface.js";
import { InvalidMessageIdentifierError } from "../../../src/features/ingestion/models/domain/ingestion-store.errors.js";
import type { MessageAttachmentMetadata, NormalizedReplyReference } from "../../../src/features/discord/index.js";
import {
	ATTACHMENT_ID,
	AUTHOR_ID,
	CHANNEL_ID,
	CREATED_AT,
	EDITED_AT,
	GUILD_ID,
	LATER_EDIT_AT,
	MESSAGE_ID,
	OTHER_GUILD_ID,
	OUT_OF_RANGE_ID,
	SECRET_CONTENT,
	SECRET_FILENAME,
	SECRET_URL,
	SECRET_USERNAME,
	THREAD_ID,
	attachment as storedAttachment
} from "./fakes/message-fixtures.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import { RecordingMessageStore } from "./fakes/recording-message-store.js";
import { reconciliationAttachment } from "./fakes/fake-message-rest-gateway.js";
import { payloadOf } from "./fakes/payload-shape.js";

/**
 * T2 — `MESSAGE_CREATE` applied to the message store (docs/features/ingestion.md R4, with R1, R7, R8, R11, R12).
 *
 * The store double refuses the writes the PostgreSQL statement refuses, so these cases prove the command's own
 * behaviour: that it hands the store a whole record rather than a guessed one, that a replay moves nothing —
 * attachment rows included — that another Guild's event never reaches a statement, and that nothing a payload
 * said *about* a message ever appears in a log line. The SQL, the batch bounds and the constraint refusals are
 * proven against a real PostgreSQL in `tests/integration/ingestion-message-events.integration.test.ts`.
 *
 * The absences matter as much as the values: a create event that carried no author kind, no webhook, no edit
 * instant and no attachment list is four distinct facts, and each is stored as "not reported" rather than as a
 * placeholder the mirror invented (R4, R10, R11).
 */

const WEBHOOK_ID = "160000000000000301";
const REPLIED_MESSAGE_ID = "160000000000000402";
const JOIN_MESSAGE_ID = "160000000000000403";

interface Harness {
	readonly command: RecordMessageCommand;
	readonly store: RecordingMessageStore;
	readonly logger: RecordingLogger;
}

function harness(store = new RecordingMessageStore()): Harness {
	const logger = new RecordingLogger();
	return {
		command: new RecordMessageCommand({
			config: createIngestionConfig({ guildId: GUILD_ID }),
			messageStore: store,
			logger
		}),
		store,
		logger
	};
}

/**
 * A `MESSAGE_CREATE`-shaped payload, as the subscription binding will hand it. `omit` leaves a field genuinely
 * absent, which is the only form a partial payload has (see `fakes/payload-shape.ts`).
 */
function createEvent(overrides: Partial<RecordMessageEvent> = {}, omit: readonly string[] = []): RecordMessageEvent {
	return payloadOf<RecordMessageEvent>(
		{
			guildId: GUILD_ID,
			messageId: MESSAGE_ID,
			channelId: CHANNEL_ID,
			authorId: AUTHOR_ID,
			authorUsername: SECRET_USERNAME,
			authorIsBot: false,
			messageType: "default",
			content: SECRET_CONTENT,
			createdInstant: CREATED_AT,
			...overrides
		},
		omit
	);
}

describe("RecordMessageCommand — what a stored message keeps (R4, R11)", () => {
	it("stores every fact a create event carried, including the reply reference and the attachment metadata", async () => {
		const { command, store } = harness();

		const outcome = await command.execute(
			createEvent({
				messageType: "reply",
				editedInstant: EDITED_AT,
				replyReference: { messageId: REPLIED_MESSAGE_ID, channelId: CHANNEL_ID },
				attachments: [reconciliationAttachment()]
			})
		);

		expect(outcome).toMatchObject({ status: "applied", rowsWritten: 1, rowsSkipped: 0, attachmentsWritten: 1 });
		expect(store.rows.get(MESSAGE_ID)).toEqual({
			guildId: GUILD_ID,
			messageId: MESSAGE_ID,
			channelId: CHANNEL_ID,
			authorId: AUTHOR_ID,
			authorUsername: SECRET_USERNAME,
			authorIsBot: false,
			webhookId: null,
			messageType: "reply",
			content: SECRET_CONTENT,
			createdInstant: CREATED_AT,
			editedInstant: EDITED_AT,
			replyReference: { messageId: REPLIED_MESSAGE_ID, channelId: CHANNEL_ID, guildId: null },
			attachments: [storedAttachment()],
			deletedAt: null
		});
	});

	it("stores an attachment-only message with the empty text Discord sent, not with a placeholder (R4)", async () => {
		const { command, store } = harness();

		await command.execute(createEvent({ content: "", attachments: [reconciliationAttachment()] }));

		expect(store.rows.get(MESSAGE_ID)?.content).toBe("");
		expect(store.rows.get(MESSAGE_ID)?.attachments).toHaveLength(1);
	});

	it("keeps an absent author kind as absence, not as false and not as an empty name (R4)", async () => {
		const { command, store } = harness();

		await command.execute(createEvent({ webhookId: WEBHOOK_ID }, ["authorUsername", "authorIsBot"]));

		const stored = store.rows.get(MESSAGE_ID);
		expect(stored?.webhookId).toBe(WEBHOOK_ID);
		expect(stored?.authorUsername).toBeNull();
		expect(stored?.authorIsBot).toBeNull();
	});

	it("keeps the attachment metadata the payload reported and derives nothing from it (R11)", async () => {
		const { command, store } = harness();
		// No content type at all: Discord's own "this attachment did not say", which is stored as null.
		const metadata = payloadOf<MessageAttachmentMetadata>(
			{
				attachmentId: ATTACHMENT_ID,
				filename: SECRET_FILENAME,
				url: SECRET_URL,
				sizeBytes: 2_048
			},
			["contentType"]
		);

		await command.execute(createEvent({ attachments: [metadata] }));

		expect(store.rows.get(MESSAGE_ID)?.attachments).toEqual([
			{
				attachmentId: ATTACHMENT_ID,
				filename: SECRET_FILENAME,
				url: SECRET_URL,
				contentType: null,
				sizeBytes: 2_048
			}
		]);
	});

	it("leaves a thread's message under the thread's own id, which is what a later exclusion matches (R2 there)", async () => {
		const { command, store } = harness();

		await command.execute(createEvent({ channelId: THREAD_ID }));

		expect(store.rows.get(MESSAGE_ID)?.channelId).toBe(THREAD_ID);
	});

	it("stores every message type it is handed, because ingestion filters nothing (R4)", async () => {
		const { command, store } = harness();

		await command.execute(createEvent({ messageId: JOIN_MESSAGE_ID, messageType: "member-join" }));

		expect(store.rows.get(JOIN_MESSAGE_ID)?.messageType).toBe("member-join");
	});

	it("drops a reply reference that names no message, and counts that it did (R4)", async () => {
		const { command, store, logger } = harness();
		const halfReference = payloadOf<NormalizedReplyReference>({ channelId: CHANNEL_ID, guildId: GUILD_ID }, [
			"messageId"
		]);

		const outcome = await command.execute(createEvent({ replyReference: halfReference }));

		expect(outcome).toMatchObject({ status: "applied", replyReferenceDropped: true });
		expect(store.rows.get(MESSAGE_ID)?.replyReference).toBeNull();
		expect(logger.messagesMatching("named no message")).toHaveLength(1);
	});
});

describe("RecordMessageCommand — a replay moves nothing (R7, R8)", () => {
	it("changes nothing when the same delivery arrives twice, attachment rows included", async () => {
		const { command, store } = harness();
		const event = createEvent({ attachments: [reconciliationAttachment()] });

		const first = await command.execute(event);
		const second = await command.execute(event);

		expect(first).toMatchObject({ rowsWritten: 1, rowsSkipped: 0 });
		expect(second).toMatchObject({
			status: "applied",
			rowsWritten: 0,
			rowsSkipped: 1,
			attachmentsWritten: 0,
			attachmentsRemoved: 0
		});
		expect(store.rows.get(MESSAGE_ID)?.attachments).toHaveLength(1);
		expect(store.callsTo("upsertMessages")).toHaveLength(2);
	});

	it("refuses to let a late backfill record of a pre-edit version overwrite the stored edit", async () => {
		const { command, store } = harness();
		await command.execute(createEvent({ content: "the edited text", editedInstant: EDITED_AT }));

		const outcome = await command.execute(createEvent({ content: "the pre-edit text" }, ["editedInstant"]));

		expect(outcome).toMatchObject({ rowsWritten: 0, rowsSkipped: 1 });
		expect(store.rows.get(MESSAGE_ID)?.content).toBe("the edited text");
		expect(store.rows.get(MESSAGE_ID)?.editedInstant).toEqual(EDITED_AT);
	});

	it("lets a backfill record through when it is the newest state the Gateway has not applied yet", async () => {
		const { command, store } = harness();
		await command.execute(createEvent({ content: "the edited text", editedInstant: EDITED_AT }));

		const outcome = await command.execute(
			createEvent({ content: "a newer revision", editedInstant: LATER_EDIT_AT })
		);

		expect(outcome).toMatchObject({ rowsWritten: 1, rowsSkipped: 0 });
		expect(store.rows.get(MESSAGE_ID)?.content).toBe("a newer revision");
	});

	it("leaves the stored attachment set untouched when a later record carried no list at all (R11)", async () => {
		const { command, store } = harness();
		await command.execute(createEvent({ attachments: [reconciliationAttachment()] }));

		// A REST record with no `attachments` key is not a message with no attachments (discord R3).
		const outcome = await command.execute(createEvent({ content: "another text" }, ["attachments"]));

		expect(outcome).toMatchObject({ rowsWritten: 1 });
		expect(store.rows.get(MESSAGE_ID)?.attachments).toHaveLength(1);
	});

	it("clears the stored set only when a later record explicitly reports that the message has none", async () => {
		const { command, store } = harness();
		await command.execute(createEvent({ attachments: [reconciliationAttachment()] }));

		const outcome = await command.execute(createEvent({ content: "another text", attachments: [] }));

		expect(outcome).toMatchObject({ attachmentsRemoved: 1, attachmentsWritten: 0 });
		expect(store.rows.get(MESSAGE_ID)?.attachments).toEqual([]);
	});

	it("needs no Discord read and no point read: one create is one guarded write (R7 bounds)", async () => {
		const { command, store } = harness();

		await command.execute(createEvent({ attachments: [reconciliationAttachment()] }));

		expect(store.operationOrder()).toEqual(["upsertMessages"]);
	});
});

describe("RecordMessageCommand — what it refuses (R1, R4)", () => {
	it("refuses an event that names another guild, without issuing a single store call", async () => {
		const { command, store, logger } = harness();

		const outcome = await command.execute(createEvent({ guildId: OTHER_GUILD_ID }));

		expect(outcome).toEqual({
			status: "dropped",
			guildId: GUILD_ID,
			messageId: MESSAGE_ID,
			channelId: CHANNEL_ID,
			reason: "foreign-guild"
		});
		expect(store.calls).toEqual([]);
		expect(store.rows.size).toBe(0);
		expect(logger.messagesMatching("another guild")).toHaveLength(1);
		expect(logger.linesAt("warn")[0]?.fields).toMatchObject({
			eventGuildId: OTHER_GUILD_ID,
			messageId: MESSAGE_ID
		});
	});

	it("refuses an id that cannot land in a `bigint` column before any write, naming the column (R4)", async () => {
		const { command, store } = harness();

		await expect(command.execute(createEvent({ messageId: OUT_OF_RANGE_ID }))).rejects.toBeInstanceOf(
			InvalidMessageIdentifierError
		);
		await expect(command.execute(createEvent({ webhookId: "not-a-snowflake" }))).rejects.toMatchObject({
			field: "message.webhook_id"
		});
		expect(store.calls).toEqual([]);
	});

	it("refuses a blank author name the way the store's own rule refuses it, rather than storing whitespace", async () => {
		const { command, store } = harness();

		await expect(command.execute(createEvent({ authorUsername: "   " }))).rejects.toMatchObject({
			field: "message.author_username"
		});
		expect(store.calls).toEqual([]);
	});
});

describe("RecordMessageCommand — log safety (R12)", () => {
	it("reports a write the store refused without quoting the content it refused", async () => {
		const { command, logger } = harness();
		await command.execute(createEvent({ content: SECRET_CONTENT, editedInstant: EDITED_AT }));

		await command.execute(createEvent({ content: "second text" }, ["editedInstant"]));

		expect(logger.transcript()).not.toContain(SECRET_CONTENT);
		expect(logger.transcript()).not.toContain("second text");
		// The first delivery wrote; the late one was refused by the store's own guard, and the line says which.
		expect(logger.messagesMatching('"outcome":"written"')).toHaveLength(1);
		expect(logger.messagesMatching('"outcome":"unchanged-by-store-guard"')).toHaveLength(1);
	});

	it("keeps message text, author names and attachment metadata out of every line it writes", async () => {
		const { command, logger } = harness();

		await command.execute(
			createEvent({
				content: SECRET_CONTENT,
				authorUsername: SECRET_USERNAME,
				attachments: [reconciliationAttachment()],
				replyReference: { messageId: REPLIED_MESSAGE_ID }
			})
		);

		const transcript = logger.transcript();
		for (const secret of [SECRET_CONTENT, SECRET_USERNAME, SECRET_FILENAME, SECRET_URL]) {
			expect(transcript).not.toContain(secret);
		}
		// The resource ids and the counters a reviewer needs are all there is, which is the rule rather than an
		// accident: an attachment is named by nothing but its count, because its name and URL are display data.
		expect(transcript).toContain(MESSAGE_ID);
		expect(transcript).toContain(CHANNEL_ID);
		expect(transcript).toContain('"attachmentsWritten":1');
	});

	it("names a dropped foreign-guild event by guild ids alone", async () => {
		const { command, logger } = harness();

		await command.execute(createEvent({ guildId: OTHER_GUILD_ID, content: SECRET_CONTENT }));

		expect(logger.transcript()).not.toContain(SECRET_CONTENT);
		expect(logger.transcript()).toContain(OTHER_GUILD_ID);
	});
});
