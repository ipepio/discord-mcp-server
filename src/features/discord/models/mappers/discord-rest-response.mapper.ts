import type { DiscordRestOperation } from "../domain/discord-rest-operation.enum.js";
import type {
	DiscordChannelRecord,
	DiscordGuildSnapshot,
	DiscordMemberRecord,
	DiscordMessageRecord,
	DiscordRoleRecord,
	DiscordThreadMemberRecord
} from "../domain/discord-rest-results.js";
import { channelTypeNameFor, messageTypeNameFor, overwriteTargetTypeFor } from "../domain/discord-resource-types.js";
import type {
	ChannelPermissionOverwrite,
	MessageAttachmentMetadata,
	NormalizedReplyReference
} from "../domain/normalized-discord-event.js";
import { DiscordRestFailureError } from "../../gateways/discord-rest.errors.js";
import type { RawObject } from "./raw-payload.reader.js";
import { MalformedRawPayloadError } from "./raw-payload.errors.js";
import { RawPayloadReader } from "./raw-payload.reader.js";

/**
 * Validation of a Discord REST response into application types (spec R7 error bullet). Discord's REST
 * bodies carry the same resource shapes the Gateway sends, so the same field-by-field reader that
 * normalizes events validates them — one rule for what a snowflake, a timestamp or an overwrite target
 * is, at both boundaries.
 *
 * A response that fails validation raises `DiscordRestFailureError` naming the operation and the offending
 * field path, never a partially populated result, never a fabricated default and never a value: content
 * and credentials cannot reach an error message (R11).
 */

/** Runs a validation and turns its field-path rejection into the named REST failure of that operation. */
export function validateRestPayload<T>(operation: DiscordRestOperation, run: (reader: RawPayloadReader) => T): T {
	try {
		return run(new RawPayloadReader(operation));
	} catch (error) {
		if (error instanceof MalformedRawPayloadError) {
			throw new DiscordRestFailureError({
				operation,
				reason: "validation",
				attempts: 1,
				fieldPath: error.fieldPath,
				detail: error.reason
			});
		}

		throw error;
	}
}

/** The root of a list endpoint: an array, or the response is not a list (R7: never a silently empty one). */
function rootArray(reader: RawPayloadReader, payload: unknown, field: string): readonly unknown[] {
	if (!Array.isArray(payload)) {
		reader.reject(field, "expected a JSON array of resources");
	}

	return payload;
}

export function mapGuildSnapshot(operation: DiscordRestOperation, payload: unknown): DiscordGuildSnapshot {
	return validateRestPayload(operation, (reader) => {
		const guild = reader.root(payload);
		const guildId = reader.requireId(guild, "id");
		const name = reader.requireString(guild, "name");
		const ownerId = reader.optionalId(guild, "owner_id");
		const memberCount =
			reader.optionalNumber(guild, "member_count") ?? reader.optionalNumber(guild, "approximate_member_count");
		const isUnavailable = reader.optionalBoolean(guild, "unavailable");

		return {
			guildId,
			name,
			...(ownerId === undefined ? {} : { ownerId }),
			...(memberCount === undefined ? {} : { memberCount }),
			...(isUnavailable === undefined ? {} : { isUnavailable })
		};
	});
}

export function mapRoleRecords(
	operation: DiscordRestOperation,
	guildId: string,
	payload: unknown
): readonly DiscordRoleRecord[] {
	return validateRestPayload(operation, (reader) =>
		rootArray(reader, payload, "roles").map((entry, index) => {
			const path = `roles[${index}]`;
			const role = reader.elementAsObject(entry, path);
			const roleId = reader.requireId(role, "id", `${path}.id`);
			const name = reader.requireString(role, "name", `${path}.name`);
			const permissionsBitfield = reader.requireString(role, "permissions", `${path}.permissions`);
			const position = reader.requireNumber(role, "position", `${path}.position`);
			const isManaged = reader.optionalBoolean(role, "managed", `${path}.managed`);

			return {
				guildId,
				roleId,
				name,
				permissionsBitfield,
				position,
				...(isManaged === undefined ? {} : { isManaged })
			};
		})
	);
}

/** Overwrite entries of a REST channel object; an unresolvable target type rejects the whole read (R7). */
function readOverwrites(
	reader: RawPayloadReader,
	channel: RawObject,
	prefix: string
): ChannelPermissionOverwrite[] | undefined {
	const list = reader.optionalArray(channel, "permission_overwrites", `${prefix}permission_overwrites`);
	if (list === undefined) {
		return undefined;
	}

	const overwrites: ChannelPermissionOverwrite[] = [];

	for (const [index, entry] of list.entries()) {
		const path = `${prefix}permission_overwrites[${index}]`;
		const overwrite = reader.elementAsObject(entry, path);
		const targetId = reader.requireId(overwrite, "id", `${path}.id`);
		const typeCode = reader.requireNumber(overwrite, "type", `${path}.type`);
		const targetType = overwriteTargetTypeFor(typeCode);
		if (targetType === undefined) {
			reader.reject(path, `unresolvable overwrite target type ${typeCode}`);
		}

		overwrites.push({
			targetId,
			targetType,
			allowBitfield: reader.requireString(overwrite, "allow", `${path}.allow`),
			denyBitfield: reader.requireString(overwrite, "deny", `${path}.deny`)
		});
	}

	return overwrites;
}

export function mapChannelRecords(
	operation: DiscordRestOperation,
	guildId: string,
	payload: unknown
): readonly DiscordChannelRecord[] {
	return validateRestPayload(operation, (reader) =>
		rootArray(reader, payload, "channels").map((entry, index) => {
			const path = `channels[${index}].`;
			const channel = reader.elementAsObject(entry, path.slice(0, -1));
			const channelId = reader.requireId(channel, "id", `${path}id`);
			const typeCode = reader.requireNumber(channel, "type", `${path}type`);
			const name = reader.optionalString(channel, "name", `${path}name`);
			const parentId = reader.optionalId(channel, "parent_id", `${path}parent_id`);
			const position = reader.optionalNumber(channel, "position", `${path}position`);
			const permissionOverwrites = readOverwrites(reader, channel, path);

			return {
				guildId,
				channelId,
				channelType: channelTypeNameFor(typeCode),
				...(name === undefined ? {} : { name }),
				...(parentId === undefined ? {} : { parentId }),
				...(position === undefined ? {} : { position }),
				...(permissionOverwrites === undefined ? {} : { permissionOverwrites })
			};
		})
	);
}

/** One REST guild-member object. `user` is required: a member without a User is a malformed response. */
function readMember(reader: RawPayloadReader, entry: unknown, guildId: string, index: number): DiscordMemberRecord {
	const path = `members[${index}].`;
	const member = reader.elementAsObject(entry, `${path.slice(0, -1)}`);
	const user = reader.requireObject(member, "user", `${path}user`);
	const userId = reader.requireId(user, "id", `${path}user.id`);
	const username = reader.optionalString(user, "username", `${path}user.username`);
	const isBot = reader.optionalBoolean(user, "bot", `${path}user.bot`);
	const roleIds = reader.idList(member, "roles", `${path}roles`);
	const nickname = reader.optionalString(member, "nick", `${path}nick`);
	const joinedInstant = reader.optionalInstant(member, "joined_at", `${path}joined_at`);
	const isPending = reader.optionalBoolean(member, "pending", `${path}pending`);

	return {
		guildId,
		userId,
		roleIds,
		...(username === undefined ? {} : { username }),
		...(isBot === undefined ? {} : { isBot }),
		...(nickname === undefined ? {} : { nickname }),
		...(joinedInstant === undefined ? {} : { joinedInstant }),
		...(isPending === undefined ? {} : { isPending })
	};
}

export function mapMemberRecords(
	operation: DiscordRestOperation,
	guildId: string,
	payload: unknown
): readonly DiscordMemberRecord[] {
	return validateRestPayload(operation, (reader) =>
		rootArray(reader, payload, "members").map((entry, index) => readMember(reader, entry, guildId, index))
	);
}

function readReplyReference(
	reader: RawPayloadReader,
	message: RawObject,
	prefix: string
): NormalizedReplyReference | undefined {
	const reference = reader.optionalObject(message, "message_reference", `${prefix}message_reference`);
	if (reference === undefined) {
		return undefined;
	}

	// Discord omits `message_id` when the referenced message no longer exists (deleted, or a system event
	// whose origin is gone): the reference is still present but carries nothing resolvable. Treating it as
	// required made a whole history page invalid and stopped every walk that met one — the 43 channels
	// deferred by the 2026-11-13 import. A reference without an id is therefore "no reply we can point at",
	// which is the same fact ingestion records when it drops a dangling reference.
	const messageId = reader.optionalId(reference, "message_id", `${prefix}message_reference.message_id`);
	if (messageId === undefined) {
		return undefined;
	}
	const channelId = reader.optionalId(reference, "channel_id", `${prefix}message_reference.channel_id`);
	const guildId = reader.optionalId(reference, "guild_id", `${prefix}message_reference.guild_id`);

	return {
		messageId,
		...(channelId === undefined ? {} : { channelId }),
		...(guildId === undefined ? {} : { guildId })
	};
}

function readAttachments(
	reader: RawPayloadReader,
	message: RawObject,
	prefix: string
): MessageAttachmentMetadata[] | undefined {
	const list = reader.optionalArray(message, "attachments", `${prefix}attachments`);
	if (list === undefined) {
		return undefined;
	}

	const attachments: MessageAttachmentMetadata[] = [];

	for (const [index, entry] of list.entries()) {
		const path = `${prefix}attachments[${index}]`;
		const attachment = reader.elementAsObject(entry, path);
		const contentType = reader.optionalString(attachment, "content_type", `${path}.content_type`);

		attachments.push({
			attachmentId: reader.requireId(attachment, "id", `${path}.id`),
			filename: reader.requireString(attachment, "filename", `${path}.filename`),
			url: reader.requireString(attachment, "url", `${path}.url`),
			sizeBytes: reader.requireNumber(attachment, "size", `${path}.size`),
			...(contentType === undefined ? {} : { contentType })
		});
	}

	return attachments;
}

/**
 * One REST message object, in the shape both message reads return.
 *
 * `path` is the field prefix the payload position deserves — `messages[0].` inside a page, empty for a
 * response that *is* the message — so a validation failure always names where the offending field sits. The
 * `channel_id` of the object must be the channel that was read: a response carrying another resource is a
 * malformed read, not a result, and is rejected at its field path instead of being returned (R2's rule
 * applied to a read — the adapter never hands a consumer another resource's data).
 */
function readMessageRecord(
	reader: RawPayloadReader,
	message: RawObject,
	path: string,
	channelId: string
): DiscordMessageRecord {
	const messageId = reader.requireId(message, "id", `${path}id`);
	const messageChannelId = reader.requireId(message, "channel_id", `${path}channel_id`);
	if (messageChannelId !== channelId) {
		reader.reject(`${path}channel_id`, "message belongs to another channel than the one that was read");
	}
	const author = reader.requireObject(message, "author", `${path}author`);
	const authorId = reader.requireId(author, "id", `${path}author.id`);
	const authorUsername = reader.optionalString(author, "username", `${path}author.username`);
	const authorIsBot = reader.optionalBoolean(author, "bot", `${path}author.bot`);
	const content = reader.requireString(message, "content", `${path}content`);
	const createdInstant = reader.requireInstant(message, "timestamp", `${path}timestamp`);
	const typeCode = reader.requireNumber(message, "type", `${path}type`);
	const editedInstant = reader.optionalInstant(message, "edited_timestamp", `${path}edited_timestamp`);
	const isPinned = reader.optionalBoolean(message, "pinned", `${path}pinned`);
	const webhookId = reader.optionalId(message, "webhook_id", `${path}webhook_id`);
	const replyReference = readReplyReference(reader, message, path);
	const attachments = readAttachments(reader, message, path);

	return {
		messageId,
		channelId: messageChannelId,
		authorId,
		content,
		createdInstant,
		messageType: messageTypeNameFor(typeCode),
		...(authorUsername === undefined ? {} : { authorUsername }),
		...(authorIsBot === undefined ? {} : { authorIsBot }),
		...(isPinned === undefined ? {} : { isPinned }),
		...(webhookId === undefined ? {} : { webhookId }),
		...(editedInstant === undefined ? {} : { editedInstant }),
		...(replyReference === undefined ? {} : { replyReference }),
		...(attachments === undefined ? {} : { attachments })
	};
}

/**
 * A REST message object: the same fields the Gateway sends, validated the same way (R3, R7).
 */
export function mapMessageRecords(
	operation: DiscordRestOperation,
	channelId: string,
	payload: unknown
): readonly DiscordMessageRecord[] {
	return validateRestPayload(operation, (reader) =>
		rootArray(reader, payload, "messages").map((entry, index) => {
			const path = `messages[${index}]`;
			return readMessageRecord(reader, reader.elementAsObject(entry, path), `${path}.`, channelId);
		})
	);
}

/**
 * A single-message response (`GET /channels/{channel.id}/messages/{message.id}`), validated as one message
 * and confirmed against both ids that were asked for. The id check is the reason this read exists at all:
 * a reconciliation that accepted another message's state would write a wrong content under a right id, so
 * a mismatch refuses the read instead of returning it (R7 error: never a partially usable result).
 */
export function mapMessageRecord(
	operation: DiscordRestOperation,
	channelId: string,
	messageId: string,
	payload: unknown
): DiscordMessageRecord {
	return validateRestPayload(operation, (reader) => {
		const record = readMessageRecord(reader, reader.root(payload), "", channelId);
		if (record.messageId !== messageId) {
			reader.reject("id", "the response names another message than the one that was read");
		}

		return record;
	});
}

/**
 * Thread-member objects. Discord sends the thread id as `id` and the User id as `user_id`; the read is
 * reported under the thread it was asked for, so a mismatched payload is a validation failure.
 */
export function mapThreadMemberRecords(
	operation: DiscordRestOperation,
	threadId: string,
	payload: unknown
): readonly DiscordThreadMemberRecord[] {
	return validateRestPayload(operation, (reader) =>
		rootArray(reader, payload, "thread_members").map((entry, index) => {
			const path = `thread_members[${index}]`;
			const member = reader.elementAsObject(entry, path);
			const memberThreadId = reader.requireId(member, "id", `${path}.id`);
			if (memberThreadId !== threadId) {
				reader.reject(`${path}.id`, "thread-member payload belongs to another thread");
			}

			const userId = reader.requireId(member, "user_id", `${path}.user_id`);
			const joinInstant = reader.optionalInstant(member, "join_timestamp", `${path}.join_timestamp`);

			return {
				threadId,
				userId,
				...(joinInstant === undefined ? {} : { joinInstant })
			};
		})
	);
}
