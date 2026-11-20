import { describe, expect, it } from "vitest";
import {
	InvalidMessageFieldValueError,
	InvalidMessageIdentifierError
} from "../../../src/features/ingestion/models/domain/ingestion-store.errors.js";
import {
	editAssertsNothing,
	editChangesStoredState,
	editWouldRegress,
	isForeignGuildRecord,
	missingEditFields,
	replyReferenceIsStorable,
	tombstoneDropsContent,
	tombstoneProjection,
	validateChannelExclusion,
	validateMessageAttachment,
	validateMessageEdit,
	validateMessageTombstone,
	validateMessageWrite
} from "../../../src/features/ingestion/models/domain/message-rules.js";
import {
	AUTHOR_ID,
	CHANNEL_ID,
	CREATED_AT,
	DELETED_AT,
	EDITED_AT,
	EARLIER_EDIT_AT,
	GUILD_ID,
	LATER_EDIT_AT,
	MESSAGE_ID,
	OTHER_GUILD_ID,
	OUT_OF_RANGE_ID,
	REPLIED_MESSAGE_ID,
	SECRET_CONTENT,
	attachment,
	messageWrite,
	storedMessage,
	tombstoneWrite
} from "./fakes/message-fixtures.js";

/**
 * The message store's domain guards — the rules docs/features/ingestion.md R1, R4, R5, R6, R8 and R11 state,
 * and ADR-0007 states for a deletion, written once as functions both the commands and the PostgreSQL adapter
 * call (docs/architecture/conventions.md: "a business invariant used by more than one use case belongs to the
 * feature's domain model"). What a real database refuses is proven separately in
 * `tests/integration/ingestion-message-store.integration.test.ts`; what this file proves is that the feature
 * refuses the same set before it ever builds a statement.
 *
 * The two rules that decide correctness under at-least-once delivery are `editWouldRegress` (R5, R8) and
 * `tombstoneDropsContent` (R6, ADR-0007), so both are pinned over every input combination rather than the
 * happy path alone.
 */

describe("R1 — only the configured Guild is ingested", () => {
	it("recognises a record that names another Guild, compared on the id string alone", () => {
		expect(isForeignGuildRecord(OTHER_GUILD_ID, GUILD_ID)).toBe(true);
		expect(isForeignGuildRecord(GUILD_ID, GUILD_ID)).toBe(false);
	});

	it("does not confuse a differently spelled id with the configured one", () => {
		expect(isForeignGuildRecord("16000000000000001", GUILD_ID)).toBe(true);
	});
});

describe("R5, R8 — an edit never regresses newer stored content", () => {
	it("allows the first reported edit of a message that has never been edited", () => {
		expect(editWouldRegress(null, EDITED_AT)).toBe(false);
	});

	it("allows an edit at or after the stored edit instant, including the equal timestamp of a replay", () => {
		expect(editWouldRegress(EDITED_AT, EDITED_AT)).toBe(false);
		expect(editWouldRegress(EDITED_AT, LATER_EDIT_AT)).toBe(false);
	});

	it("refuses an edit whose Discord-reported instant is older than the stored one", () => {
		expect(editWouldRegress(EDITED_AT, EARLIER_EDIT_AT)).toBe(true);
	});

	it("refuses a state with no edit instant at all against a row that already has one", () => {
		// R8's named defect: the REST backfill record of a pre-edit version, arriving after the Gateway already
		// applied the edit. A missing instant is not "oldest" and not "newest" — it proves nothing.
		expect(editWouldRegress(EDITED_AT, null)).toBe(true);
	});

	it("lets a state with no edit instant through only when nothing was ever stored either", () => {
		expect(editWouldRegress(null, null)).toBe(false);
	});

	it("decides whether an update proves anything the payload could not carry (R5)", () => {
		expect(missingEditFields({ content: "new text", editedInstant: EDITED_AT })).toEqual([]);
		expect(missingEditFields({ content: "new text" })).toEqual(["editedInstant"]);
		expect(missingEditFields({ editedInstant: EDITED_AT })).toEqual(["content"]);
		expect(missingEditFields({})).toEqual(["content", "editedInstant"]);
	});

	it("names a payload with neither text nor an edit instant as one with nothing to apply", () => {
		// Discord sends this for a pin or flags change. There is no content rule to apply, and no REST read is
		// worth spending on it (R7's bounds).
		expect(editAssertsNothing({})).toBe(true);
		expect(editAssertsNothing({ content: "" })).toBe(false);
		expect(editAssertsNothing({ editedInstant: EDITED_AT })).toBe(false);
	});

	it("sees the difference between a replay and an actual change (R7)", () => {
		const stored = storedMessage({ content: SECRET_CONTENT, editedInstant: EDITED_AT });
		expect(
			editChangesStoredState(stored, { content: SECRET_CONTENT, editedInstant: EDITED_AT, messageType: null })
		).toBe(false);
		expect(
			editChangesStoredState(stored, {
				content: SECRET_CONTENT,
				// A different `Date` object naming the same instant is the same stored value.
				editedInstant: new Date(EDITED_AT.getTime()),
				messageType: "default"
			})
		).toBe(false);
		expect(
			editChangesStoredState(stored, { content: "corrected text", editedInstant: EDITED_AT, messageType: null })
		).toBe(true);
		expect(
			editChangesStoredState(stored, { content: SECRET_CONTENT, editedInstant: LATER_EDIT_AT, messageType: null })
		).toBe(true);
	});
});

describe("R6, ADR-0007 — a tombstone keeps the row and drops the content", () => {
	it("keeps every identifying fact of the message it deleted", () => {
		const after = tombstoneDropsContent(storedMessage({ editedInstant: EDITED_AT }), DELETED_AT);
		expect(after.messageId).toBe(MESSAGE_ID);
		expect(after.guildId).toBe(GUILD_ID);
		expect(after.channelId).toBe(CHANNEL_ID);
		expect(after.authorId).toBe(AUTHOR_ID);
		expect(after.createdInstant).toBe(CREATED_AT);
		expect(after.editedInstant).toBe(EDITED_AT);
		expect(after.messageType).toBe("default");
		expect(after.deletedAt).toBe(DELETED_AT);
	});

	it("drops the content and the attachment metadata, and keeps the reply reference's ids", () => {
		const after = tombstoneDropsContent(
			storedMessage({
				content: SECRET_CONTENT,
				attachments: [attachment()],
				replyReference: { messageId: REPLIED_MESSAGE_ID, channelId: CHANNEL_ID, guildId: GUILD_ID }
			}),
			DELETED_AT
		);
		expect(after.content).toBeNull();
		expect(after.attachments).toEqual([]);
		expect(after.replyReference?.messageId).toBe(REPLIED_MESSAGE_ID);
	});

	it("keeps the first tombstone instant when a replay of the deletion arrives later (R7)", () => {
		const tombstoned = tombstoneDropsContent(storedMessage(), DELETED_AT);
		expect(tombstoneDropsContent(tombstoned, LATER_EDIT_AT).deletedAt).toBe(DELETED_AT);
	});

	it("leaves a live row exactly as it was when a read path projects it", () => {
		const live = storedMessage();
		expect(tombstoneProjection(live)).toEqual(live);
	});

	it("forces the projection on a row that carries both a tombstone and content", () => {
		// The state the schema's CHECK refuses and the domain must still never hand to a caller: a deleted row
		// that somehow kept its text reads back with none.
		const inconsistent = storedMessage({ content: SECRET_CONTENT, deletedAt: DELETED_AT });
		const projected = tombstoneProjection(inconsistent);
		expect(projected.content).toBeNull();
		expect(projected.attachments).toEqual([]);
		expect(projected.deletedAt).toBe(DELETED_AT);
	});
});

describe("R4, R11 — a write that could never land in a column is refused here, not by the driver", () => {
	it("refuses an id that is not a snowflake, naming the column that would have received it", () => {
		expect(() => messageWrite({ messageId: "not-a-snowflake" })).not.toThrow();
		expect(() => validateMessageWrite(messageWrite({ messageId: "not-a-snowflake" }))).toThrow(
			InvalidMessageIdentifierError
		);
		expect(() => validateMessageWrite(messageWrite({ messageId: OUT_OF_RANGE_ID }))).toThrow(/out-of-bigint-range/);
		expect(() => validateMessageWrite(messageWrite({ authorId: "0" }))).toThrow(/message\.author_id/);
		expect(() => validateMessageWrite(messageWrite({ channelId: "" }))).toThrow(/message\.channel_id/);
	});

	it("refuses a message body that is not text, because absent is never empty", () => {
		expect(validateMessageWrite(messageWrite({ content: "" })).content).toBe("");
		expect(() => validateMessageWrite(messageWrite({ content: undefined as unknown as string }))).toThrow(
			/message\.content/
		);
		expect(() => validateMessageWrite(messageWrite({ content: null as unknown as string }))).toThrow(
			InvalidMessageFieldValueError
		);
	});

	it("refuses a timestamp it cannot store rather than writing an Invalid Date", () => {
		expect(() => validateMessageWrite(messageWrite({ createdInstant: "yesterday" as unknown as Date }))).toThrow(
			/message\.created_instant/
		);
		expect(() => validateMessageWrite(messageWrite({ createdInstant: new Date("not a day") }))).toThrow(
			/expected a real instant/
		);
		expect(validateMessageWrite(messageWrite({ editedInstant: null })).editedInstant).toBeNull();
		expect(validateMessageWrite(messageWrite({ editedInstant: EDITED_AT })).editedInstant).toBe(EDITED_AT);
	});

	it("refuses a blank message type, which the column's own check also refuses", () => {
		expect(() => validateMessageWrite(messageWrite({ messageType: "  " as never }))).toThrow(
			/message\.message_type/
		);
	});

	it("refuses attachment metadata that is not metadata: a blank name, a blank URL, a bad size", () => {
		const storable = attachment();
		expect(validateMessageAttachment(storable)).toEqual(storable);
		expect(() => validateMessageAttachment({ ...storable, filename: " " })).toThrow(/filename/);
		expect(() => validateMessageAttachment({ ...storable, url: "" })).toThrow(/message_attachment\.url/);
		expect(() => validateMessageAttachment({ ...storable, contentType: "  " })).toThrow(/content_type/);
		expect(() => validateMessageAttachment({ ...storable, sizeBytes: -1 })).toThrow(/non-negative/);
		expect(() => validateMessageAttachment({ ...storable, sizeBytes: 1.5 })).toThrow(/whole number/);
		expect(() => validateMessageAttachment({ ...storable, attachmentId: "nope" })).toThrow(/attachment_id/);
	});

	it("keeps an absent attachment set distinct from an empty one (R4, discord R3)", () => {
		expect(validateMessageWrite(messageWrite({ attachments: null })).attachments).toBeNull();
		expect(validateMessageWrite(messageWrite({ attachments: [] })).attachments).toEqual([]);
	});

	it("refuses a reply channel or guild that names no message, the way the schema does", () => {
		expect(replyReferenceIsStorable({ messageId: REPLIED_MESSAGE_ID })).toBe(true);
		expect(replyReferenceIsStorable({ channelId: CHANNEL_ID, guildId: GUILD_ID })).toBe(false);
		expect(replyReferenceIsStorable({})).toBe(false);
	});

	it("validates a reply reference's own ids, so a foreign shape cannot reach a bigint column", () => {
		const withReply = messageWrite({
			replyReference: { messageId: REPLIED_MESSAGE_ID, channelId: CHANNEL_ID, guildId: GUILD_ID }
		});
		expect(validateMessageWrite(withReply).replyReference).toEqual(withReply.replyReference);
		expect(() =>
			validateMessageWrite(messageWrite({ replyReference: { messageId: "x", channelId: null, guildId: null } }))
		).toThrow(/message\.reply_message_id/);
	});

	it("refuses an edit with no content, because a live row is never content-less (R5)", () => {
		const edit = {
			guildId: GUILD_ID,
			messageId: MESSAGE_ID,
			content: SECRET_CONTENT,
			editedInstant: EDITED_AT,
			messageType: null,
			attachments: null
		};
		expect(validateMessageEdit(edit).content).toBe(SECRET_CONTENT);
		expect(() => validateMessageEdit({ ...edit, content: null as unknown as string })).toThrow(/message\.content/);
		expect(() => validateMessageEdit({ ...edit, editedInstant: new Date("nope") })).toThrow(
			/message\.edited_instant/
		);
		expect(validateMessageEdit({ ...edit, messageType: "reply" }).messageType).toBe("reply");
	});
});

describe("R6 — a sweep that would cover the Guild without naming a target is refused", () => {
	it("refuses a deletion that names no message id", () => {
		expect(() => validateMessageTombstone(tombstoneWrite([]))).toThrow(/message\.message_ids/);
		expect(validateMessageTombstone(tombstoneWrite([MESSAGE_ID])).messageIds).toEqual([MESSAGE_ID]);
	});

	it("refuses a bulk exclusion that names no channel, which would sweep the whole Guild", () => {
		expect(() => validateChannelExclusion({ guildId: GUILD_ID, channelIds: [], deletedAt: DELETED_AT })).toThrow(
			/message\.channel_ids/
		);
		expect(
			validateChannelExclusion({ guildId: GUILD_ID, channelIds: [CHANNEL_ID], deletedAt: DELETED_AT }).channelIds
		).toEqual([CHANNEL_ID]);
	});

	it("refuses a non-snowflake id in a deletion list instead of binding it", () => {
		expect(() => validateMessageTombstone(tombstoneWrite([MESSAGE_ID, "-3"]))).toThrow(/message\.message_id/);
		expect(() =>
			validateMessageTombstone(tombstoneWrite([MESSAGE_ID], { deletedAt: "soon" as unknown as Date }))
		).toThrow(/message\.deleted_at/);
	});
});
