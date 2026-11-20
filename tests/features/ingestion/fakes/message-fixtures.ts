import type {
	MessageTombstoneWrite,
	MessageWrite,
	StoredMessage,
	StoredMessageAttachment
} from "../../../../src/features/ingestion/models/domain/message-records.js";

/**
 * The records the message store is written and read with — the shapes the repository contract names, not a
 * private approximation of them. Content is a value that must never reach a log line (R12), so every string
 * here that could leak is exported as a named secret and scanned for by the tests.
 *
 * The builders take typed overrides and return the contract's own type, so a call site never needs a cast to
 * put a fixture where a record is expected (docs/architecture/conventions.md: no casts standing in for handled
 * uncertainty). An unknown id, a non-text content or a negative size is produced on purpose by the tests that
 * check the refusals, and those say so locally with a narrow cast rather than weakening every builder.
 */

export const GUILD_ID = "160000000000000001";
export const OTHER_GUILD_ID = "160000000000000999";
export const CHANNEL_ID = "160000000000000201";
export const THREAD_ID = "160000000000000202";
export const OTHER_CHANNEL_ID = "160000000000000203";
export const AUTHOR_ID = "160000000000000101";
export const MESSAGE_ID = "160000000000000401";
export const REPLIED_MESSAGE_ID = "160000000000000402";
export const ATTACHMENT_ID = "160000000000000501";
/** Past PostgreSQL's `bigint` ceiling: anything built on it must be refused before a statement. */
export const OUT_OF_RANGE_ID = "9223372036854775808";

/** Must never appear in a log line, an error message or a thrown value (R12, R14). */
export const SECRET_CONTENT = "the guest email and the reservation code";
/** Likewise: attachment metadata is stored, and none of it is ever logged (R11, R12). */
export const SECRET_FILENAME = "passport-scan.pdf";
export const SECRET_URL = "https://cdn.discord.example/attachments/passport-scan.pdf";
export const SECRET_USERNAME = "reservations-bot";

export const CREATED_AT = new Date("2026-03-01T10:00:00.000Z");
export const EDITED_AT = new Date("2026-03-01T11:00:00.000Z");
export const LATER_EDIT_AT = new Date("2026-03-01T12:00:00.000Z");
export const EARLIER_EDIT_AT = new Date("2026-03-01T09:30:00.000Z");
export const DELETED_AT = new Date("2026-03-02T08:00:00.000Z");

/** One attachment with the fields R11 lists and nothing else: no bytes, no storage reference. */
export function attachment(
	attachmentId: string = ATTACHMENT_ID,
	overrides: Partial<Omit<StoredMessageAttachment, "attachmentId">> = {}
): StoredMessageAttachment {
	return {
		attachmentId,
		filename: SECRET_FILENAME,
		url: SECRET_URL,
		contentType: "application/pdf",
		sizeBytes: 1_048_576,
		...overrides
	};
}

/** The write record a whole-message write is: the contract's shape, with every absent fact stated as `null`. */
export function messageWrite(overrides: Partial<MessageWrite> = {}): MessageWrite {
	return {
		guildId: GUILD_ID,
		messageId: MESSAGE_ID,
		channelId: CHANNEL_ID,
		authorId: AUTHOR_ID,
		authorUsername: SECRET_USERNAME,
		authorIsBot: true,
		webhookId: null,
		messageType: "default",
		content: SECRET_CONTENT,
		createdInstant: CREATED_AT,
		editedInstant: null,
		replyReference: null,
		attachments: null,
		...overrides
	};
}

export function tombstoneWrite(
	messageIds: readonly string[] = [MESSAGE_ID],
	overrides: Partial<Omit<MessageTombstoneWrite, "messageIds">> = {}
): MessageTombstoneWrite {
	return { guildId: GUILD_ID, messageIds, deletedAt: DELETED_AT, ...overrides };
}

/** A stored row, as `findMessage` answers with — the state a test asserts the guards against. */
export function storedMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
	return {
		guildId: GUILD_ID,
		messageId: MESSAGE_ID,
		channelId: CHANNEL_ID,
		authorId: AUTHOR_ID,
		authorUsername: SECRET_USERNAME,
		authorIsBot: true,
		webhookId: null,
		messageType: "default",
		content: SECRET_CONTENT,
		createdInstant: CREATED_AT,
		editedInstant: null,
		replyReference: null,
		attachments: [],
		deletedAt: null,
		...overrides
	};
}

/**
 * The `MessageRow` shape the PostgreSQL adapter reads, exactly as `pg` hands it back: ids as text, instants as
 * dates, an absent column as `null`. Row shapes stay here, in the test double, because the adapter is the only
 * code that sees them (docs/architecture/persistence.md).
 */
export function messageRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		message_id: MESSAGE_ID,
		guild_id: GUILD_ID,
		channel_id: CHANNEL_ID,
		author_id: AUTHOR_ID,
		author_username: SECRET_USERNAME,
		author_is_bot: true,
		webhook_id: null,
		message_type: "default",
		content: SECRET_CONTENT,
		created_instant: CREATED_AT,
		edited_instant: null,
		reply_message_id: null,
		reply_channel_id: null,
		reply_guild_id: null,
		deleted_at: null,
		...overrides
	};
}

/** One attachment row as the driver returns it. `size_bytes` is `int8`, which arrives as text (R11). */
export function attachmentRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		attachment_id: ATTACHMENT_ID,
		filename: SECRET_FILENAME,
		url: SECRET_URL,
		content_type: "application/pdf",
		size_bytes: "1048576",
		...overrides
	};
}
