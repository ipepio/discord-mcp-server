import type { NormalizedMessageType } from "../../../discord/index.js";
import { requireDiscordIdentifier } from "./discord-identifier.js";
import { InvalidMessageFieldValueError } from "./ingestion-store.errors.js";
import type {
	ChannelMessageExclusion,
	MessageEditWrite,
	MessageTombstoneWrite,
	MessageWrite,
	StoredMessage,
	StoredMessageAttachment
} from "./message-records.js";

/**
 * The message store's invariants, stated once, in code (docs/features/ingestion.md R1, R4, R5, R6, R11, with
 * ADR-0007). Both the commands and the PostgreSQL adapter call these before a statement runs, so a record
 * that breaks a rule is rejected by the feature rather than by a constraint error a caller would have to
 * interpret — and so the schema's CHECK constraints have a code-side twin that a unit test can reach.
 *
 * Nothing here touches SQL, the driver, a clock or a payload shape: these are pure functions over the
 * records in `./message-records.ts`.
 */

/**
 * R1: an event that names a Guild other than the configured one belongs to this store's mirror of nobody.
 * The comparison is on the id alone; the caller decides how to report it, because a dropped event is an
 * anomaly and an anomaly is counted rather than swallowed.
 */
export function isForeignGuildRecord(recordGuildId: string, configuredGuildId: string): boolean {
	return recordGuildId !== configuredGuildId;
}

/**
 * R5 and R8, the one comparison that decides whether stored content may be replaced: does the incoming edit
 * instant prove the incoming state is older than what is stored?
 *
 * - Nothing stored to regress from (`storedEditedInstant === null`) → no. The first reported edit always applies.
 * - An incoming state with no edit instant against a row that has one → yes. A write that cannot say when it
 *   happened cannot overwrite a state that can, which is exactly the late REST-backfill record of a
 *   pre-edit version arriving after the Gateway already applied the edit.
 * - Both instants known → older only when the incoming one is strictly earlier. Equal timestamps are not a
 *   regression: the same state written twice is R7's replay, and it changes nothing observable.
 *
 * Processing order never enters, which is the convergence rule (R8: "outcomes do not depend on the order
 * events arrived in").
 */
export function editWouldRegress(storedEditedInstant: Date | null, incomingEditedInstant: Date | null): boolean {
	if (storedEditedInstant === null) {
		return false;
	}
	if (incomingEditedInstant === null) {
		return true;
	}
	return incomingEditedInstant.getTime() < storedEditedInstant.getTime();
}

/**
 * R6, made structural: a tombstoned message has no content and no attachment metadata, wherever it is read.
 * A read path runs every row through this so "tombstoned messages are excluded from every read path" is not
 * a promise per query but a property of the record type itself — an id, an author, both instants and
 * `deleted_at` survive, and nothing that was ever shown to a user does. The schema enforces the content half
 * of the same rule with `message_content_is_dropped_by_a_tombstone`.
 */
export function tombstoneProjection(message: StoredMessage): StoredMessage {
	if (message.deletedAt === null) {
		return message;
	}
	return {
		...message,
		content: null,
		attachments: Object.freeze([] as readonly StoredMessageAttachment[])
	};
}

/** Whether the row this read found is a tombstone — the check every later read path must respect (R6). */
export function messageIsTombstoned(message: StoredMessage): boolean {
	return message.deletedAt !== null;
}

/**
 * R6 with ADR-0007, the same rule on the way in: the record that remains once a deletion has been applied to
 * this message. Content and attachment metadata are gone — not marked, gone — and every identifying fact stays.
 * The instant keeps its first value, because R7 requires the state after a replayed deletion to be
 * indistinguishable from the state after the first, and a `deleted_at` that moves on every redelivery is a
 * visible difference.
 */
export function tombstoneDropsContent(message: StoredMessage, deletedAt: Date): StoredMessage {
	return tombstoneProjection({
		...message,
		content: null,
		attachments: Object.freeze([] as readonly StoredMessageAttachment[]),
		deletedAt: message.deletedAt ?? deletedAt
	});
}

/** The two fields of an update that a partial Discord payload may have left out, named as the payload names them. */
export type MessageEditField = "content" | "editedInstant";

/**
 * R5: which fields this update did not carry, and therefore cannot be applied without reconciling the message
 * through REST first. An empty result means the payload was complete and no read is needed — which is what
 * keeps a full edit from spending a rate-limited request it does not need (R7's bounds).
 */
export function missingEditFields(update: {
	readonly content?: string;
	readonly editedInstant?: Date;
}): readonly MessageEditField[] {
	const missing: MessageEditField[] = [];
	if (update.content === undefined) {
		missing.push("content");
	}
	if (update.editedInstant === undefined) {
		missing.push("editedInstant");
	}
	return Object.freeze(missing);
}

/**
 * R5, the one case that is not an edit of content at all: a payload that reports neither new text nor an edit
 * instant. Discord sends this for a flags or pin change, and the mirror has no content rule to apply, so the
 * stored state is reported unchanged rather than written and reconciled for nothing.
 */
export function editAssertsNothing(update: { readonly content?: string; readonly editedInstant?: Date }): boolean {
	return missingEditFields(update).length === 2;
}

/**
 * R7: would writing this state change anything observable? The same question the upsert and edit statements ask
 * with `IS DISTINCT FROM`, stated once in code so the in-memory double and the SQL agree about what a replay
 * is. Instants are compared as times, because two `Date` objects naming one instant are one stored value.
 */
export function editChangesStoredState(
	stored: StoredMessage,
	incoming: {
		readonly content: string;
		readonly editedInstant: Date | null;
		readonly messageType: NormalizedMessageType | null;
	}
): boolean {
	const storedEditedMs = stored.editedInstant?.getTime() ?? null;
	const incomingEditedMs = incoming.editedInstant?.getTime() ?? null;
	return (
		stored.content !== incoming.content ||
		storedEditedMs !== incomingEditedMs ||
		(incoming.messageType !== null && incoming.messageType !== stored.messageType)
	);
}

/**
 * R4, the one reference that is not a reference: Discord can name a reply channel or guild without naming the
 * message replied to. There is then nothing to reply to, so the whole reference is dropped rather than stored
 * as a half one — which is also what `message_reply_reference_has_a_target` refuses. The caller counts and
 * names it, because a dropped field is reported and never swallowed.
 */
export function replyReferenceIsStorable(reference: {
	readonly messageId?: string | null;
	readonly channelId?: string | null;
	readonly guildId?: string | null;
}): boolean {
	return reference.messageId !== undefined && reference.messageId !== null;
}

/** Text that must not be blank where a name is required: a filename, a URL, a message type. */
function requireStorableText(field: string, value: unknown): string {
	if (typeof value !== "string") {
		throw new InvalidMessageFieldValueError(field, "expected text");
	}
	if (value.trim() === "") {
		throw new InvalidMessageFieldValueError(field, "expected non-blank text");
	}
	return value;
}

/** A message body as Discord reported it. Empty is legitimate; absent is not (R4, R5, and R3 there). */
function requireStorableContent(field: string, value: unknown): string {
	if (typeof value !== "string") {
		throw new InvalidMessageFieldValueError(field, "expected text");
	}
	return value;
}

/** An instant Discord named, as a real `Date`: an unparseable timestamp is refused, never stored as `Invalid Date`. */
function requireStorableInstant(field: string, value: unknown): Date {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw new InvalidMessageFieldValueError(field, "expected a real instant");
	}
	return value;
}

/** R11: metadata fields, validated as metadata. No field of an attachment can carry bytes or a local path. */
export function validateMessageAttachment(attachment: StoredMessageAttachment): StoredMessageAttachment {
	return {
		attachmentId: requireDiscordIdentifier("message_attachment.attachment_id", attachment.attachmentId),
		filename: requireStorableText("message_attachment.filename", attachment.filename),
		url: requireStorableText("message_attachment.url", attachment.url),
		contentType:
			attachment.contentType === null
				? null
				: requireStorableText("message_attachment.content_type", attachment.contentType),
		sizeBytes: requireStorableSizeBytes(attachment.sizeBytes)
	};
}

/** `size_bytes` is a non-negative whole number of bytes: negative, fractional or unsafe is refused (R11). */
export function requireStorableSizeBytes(sizeBytes: number): number {
	if (!Number.isInteger(sizeBytes)) {
		throw new InvalidMessageFieldValueError("message_attachment.size_bytes", "expected a whole number of bytes");
	}
	if (sizeBytes < 0) {
		throw new InvalidMessageFieldValueError("message_attachment.size_bytes", "expected a non-negative size");
	}
	if (!Number.isSafeInteger(sizeBytes)) {
		throw new InvalidMessageFieldValueError("message_attachment.size_bytes", "expected a representable size");
	}
	return sizeBytes;
}

/** Every id, instant, name and attachment of one whole-message write, validated as a unit (R4, R11). */
export function validateMessageWrite(message: MessageWrite): MessageWrite {
	return {
		guildId: requireDiscordIdentifier("message.guild_id", message.guildId),
		messageId: requireDiscordIdentifier("message.message_id", message.messageId),
		channelId: requireDiscordIdentifier("message.channel_id", message.channelId),
		authorId: requireDiscordIdentifier("message.author_id", message.authorId),
		authorUsername:
			message.authorUsername === null
				? null
				: requireStorableText("message.author_username", message.authorUsername),
		authorIsBot: message.authorIsBot,
		webhookId:
			message.webhookId === null ? null : requireDiscordIdentifier("message.webhook_id", message.webhookId),
		messageType: requireStorableText("message.message_type", message.messageType) as NormalizedMessageType,
		content: requireStorableContent("message.content", message.content),
		createdInstant: requireStorableInstant("message.created_instant", message.createdInstant),
		editedInstant:
			message.editedInstant === null
				? null
				: requireStorableInstant("message.edited_instant", message.editedInstant),
		replyReference:
			message.replyReference === null
				? null
				: {
						messageId: requireDiscordIdentifier(
							"message.reply_message_id",
							message.replyReference.messageId
						),
						channelId:
							message.replyReference.channelId === null
								? null
								: requireDiscordIdentifier(
										"message.reply_channel_id",
										message.replyReference.channelId
									),
						guildId:
							message.replyReference.guildId === null
								? null
								: requireDiscordIdentifier("message.reply_guild_id", message.replyReference.guildId)
					},
		attachments: message.attachments === null ? null : toStoredAttachments(message.attachments)
	};
}

/** The fields one edit may replace. An absent message type or attachment set stays exactly as stored (R5). */
export function validateMessageEdit(edit: MessageEditWrite): MessageEditWrite {
	return {
		guildId: requireDiscordIdentifier("message.guild_id", edit.guildId),
		messageId: requireDiscordIdentifier("message.message_id", edit.messageId),
		content: requireStorableContent("message.content", edit.content),
		editedInstant:
			edit.editedInstant === null ? null : requireStorableInstant("message.edited_instant", edit.editedInstant),
		messageType:
			edit.messageType === null
				? null
				: (requireStorableText("message.message_type", edit.messageType) as NormalizedMessageType),
		attachments: edit.attachments === null ? null : toStoredAttachments(edit.attachments)
	};
}

/**
 * A deletion's ids, validated as a unit. An empty list is refused rather than treated as "nothing to do":
 * a caller that names no message has lost a payload field, and a statement built on an empty array is how a
 * sweep silently becomes a no-op that is then reported as a success.
 */
export function validateMessageTombstone(tombstone: MessageTombstoneWrite): MessageTombstoneWrite {
	if (tombstone.messageIds.length === 0) {
		throw new InvalidMessageFieldValueError("message.message_ids", "a deletion must name at least one message");
	}
	return {
		guildId: requireDiscordIdentifier("message.guild_id", tombstone.guildId),
		messageIds: Object.freeze(
			tombstone.messageIds.map((messageId) => requireDiscordIdentifier("message.message_id", messageId))
		),
		deletedAt: requireStorableInstant("message.deleted_at", tombstone.deletedAt)
	};
}

/**
 * The channel and thread ids a bulk exclusion sweeps. An empty set is refused: without a named channel this
 * statement would cover the configured Guild's whole message table, which is not what "exclude the messages
 * of the channel that changed" says (R6).
 */
export function validateChannelExclusion(exclusion: ChannelMessageExclusion): ChannelMessageExclusion {
	if (exclusion.channelIds.length === 0) {
		throw new InvalidMessageFieldValueError("message.channel_ids", "an exclusion must name at least one channel");
	}
	return {
		guildId: requireDiscordIdentifier("message.guild_id", exclusion.guildId),
		channelIds: Object.freeze(
			exclusion.channelIds.map((channelId) => requireDiscordIdentifier("message.channel_id", channelId))
		),
		deletedAt: requireStorableInstant("message.deleted_at", exclusion.deletedAt)
	};
}

/** The attachment metadata of one message, in Discord's own list order, as storable rows (R11). */
export function toStoredAttachments(
	attachments: readonly StoredMessageAttachment[]
): readonly StoredMessageAttachment[] {
	return Object.freeze(attachments.map(validateMessageAttachment));
}
