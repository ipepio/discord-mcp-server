import { DiscordEventKind } from "../domain/discord-event-kind.enum.js";
import type {
	MessageAttachmentMetadata,
	MessageBulkDeletedEvent,
	MessageCreatedEvent,
	MessageDeletedEvent,
	MessageUpdatedEvent,
	NormalizedReplyReference
} from "../domain/normalized-discord-event.js";
import { messageTypeNameFor } from "../domain/discord-resource-types.js";
import type { RawObject } from "./raw-payload.reader.js";
import { RawPayloadReader } from "./raw-payload.reader.js";

/**
 * MESSAGE_* raw payloads to normalized events (spec R3). Content travels in memory because ingestion
 * stores it; nothing here logs it, and a validation failure quotes the field path only (R11).
 */

function readAuthor(
	reader: RawPayloadReader,
	message: RawObject
): { authorId: string; authorUsername?: string; authorIsBot?: boolean; webhookId?: string } {
	const author = reader.requireObject(message, "author", "author");
	const authorId = reader.requireId(author, "id", "author.id");
	const username = reader.optionalString(author, "username", "author.username");
	const isBot = reader.optionalBoolean(author, "bot", "author.bot");
	const webhookId = reader.optionalId(author, "webhook_id", "author.webhook_id");

	return {
		authorId,
		...(username === undefined ? {} : { authorUsername: username }),
		...(isBot === undefined ? {} : { authorIsBot: isBot }),
		...(webhookId === undefined ? {} : { webhookId })
	};
}

function readReplyReference(reader: RawPayloadReader, message: RawObject): NormalizedReplyReference | undefined {
	const reference = reader.optionalObject(message, "message_reference", "message_reference");
	if (reference === undefined) {
		return undefined;
	}

	const messageId = reader.requireId(reference, "message_id", "message_reference.message_id");
	const channelId = reader.optionalId(reference, "channel_id", "message_reference.channel_id");
	const guildId = reader.optionalId(reference, "guild_id", "message_reference.guild_id");

	return {
		messageId,
		...(channelId === undefined ? {} : { channelId }),
		...(guildId === undefined ? {} : { guildId })
	};
}

function readAttachments(reader: RawPayloadReader, message: RawObject): MessageAttachmentMetadata[] | undefined {
	const list = reader.optionalArray(message, "attachments", "attachments");
	if (list === undefined) {
		return undefined;
	}

	const attachments: MessageAttachmentMetadata[] = [];

	for (const [index, entry] of list.entries()) {
		const path = `attachments[${index}]`;
		const attachment = reader.elementAsObject(entry, path);
		const attachmentId = reader.requireId(attachment, "id", `${path}.id`);
		const filename = reader.requireString(attachment, "filename", `${path}.filename`);
		const url = reader.requireString(attachment, "url", `${path}.url`);
		const sizeBytes = reader.requireNumber(attachment, "size", `${path}.size`);
		const contentType = reader.optionalString(attachment, "content_type", `${path}.content_type`);

		attachments.push({
			attachmentId,
			filename,
			url,
			sizeBytes,
			...(contentType === undefined ? {} : { contentType })
		});
	}

	return attachments;
}

export function mapMessageCreate(rawEventName: string, guildId: string, payload: RawObject): MessageCreatedEvent {
	const reader = new RawPayloadReader(rawEventName);
	const messageId = reader.requireId(payload, "id");
	const channelId = reader.requireId(payload, "channel_id");
	const author = readAuthor(reader, payload);
	const content = reader.requireString(payload, "content");
	const createdInstant = reader.requireInstant(payload, "timestamp");
	const typeCode = reader.requireNumber(payload, "type");
	const editedInstant = reader.optionalInstant(payload, "edited_timestamp");
	const replyReference = readReplyReference(reader, payload);
	const attachments = readAttachments(reader, payload);

	return {
		kind: DiscordEventKind.messageCreated,
		guildId,
		messageId,
		channelId,
		...author,
		content,
		createdInstant,
		messageType: messageTypeNameFor(typeCode),
		...(editedInstant === undefined ? {} : { editedInstant }),
		...(replyReference === undefined ? {} : { replyReference }),
		...(attachments === undefined ? {} : { attachments })
	};
}

/**
 * MESSAGE_UPDATE is partial: a field Discord omitted stays absent, so ingestion can reconcile it by a
 * REST read instead of overwriting stored content with an empty one (ingestion R5, spec R3 boundary).
 */
export function mapMessageUpdate(rawEventName: string, guildId: string, payload: RawObject): MessageUpdatedEvent {
	const reader = new RawPayloadReader(rawEventName);
	const messageId = reader.requireId(payload, "id");
	const channelId = reader.requireId(payload, "channel_id");
	const content = reader.optionalString(payload, "content");
	const editedInstant = reader.optionalInstant(payload, "edited_timestamp");
	const typeCode = reader.optionalNumber(payload, "type");

	return {
		kind: DiscordEventKind.messageUpdated,
		guildId,
		messageId,
		channelId,
		...(content === undefined ? {} : { content }),
		...(editedInstant === undefined ? {} : { editedInstant }),
		...(typeCode === undefined ? {} : { messageType: messageTypeNameFor(typeCode) })
	};
}

export function mapMessageDelete(rawEventName: string, guildId: string, payload: RawObject): MessageDeletedEvent {
	const reader = new RawPayloadReader(rawEventName);

	return {
		kind: DiscordEventKind.messageDeleted,
		guildId,
		messageId: reader.requireId(payload, "id"),
		channelId: reader.requireId(payload, "channel_id")
	};
}

export function mapMessageDeleteBulk(
	rawEventName: string,
	guildId: string,
	payload: RawObject
): MessageBulkDeletedEvent {
	const reader = new RawPayloadReader(rawEventName);

	return {
		kind: DiscordEventKind.messageBulkDeleted,
		guildId,
		channelId: reader.requireId(payload, "channel_id"),
		messageIds: reader.idList(payload, "ids")
	};
}
