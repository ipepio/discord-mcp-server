import { DiscordEventKind } from "../domain/discord-event-kind.enum.js";
import type {
	ChannelCreatedEvent,
	ChannelDeletedEvent,
	ChannelPermissionOverwrite,
	ChannelUpdatedEvent,
	ThreadCreatedEvent,
	ThreadDeletedEvent,
	ThreadUpdatedEvent
} from "../domain/normalized-discord-event.js";
import { channelTypeNameFor, isThreadChannelCode, overwriteTargetTypeFor } from "../domain/discord-resource-types.js";
import type { RawObject } from "./raw-payload.reader.js";
import { RawPayloadReader } from "./raw-payload.reader.js";

/**
 * CHANNEL_* and THREAD_* raw payloads to normalized events (spec R3). A `CHANNEL_*` payload whose type
 * is a thread type becomes a thread event, because the kind names the resource the consumer stores.
 * A channel created while this Installation was down is still published: the consumer runs its own
 * resync path instead of losing the fact at the transport (R2 boundary, guild-state R11).
 */

function readOverwrites(reader: RawPayloadReader, payload: RawObject): ChannelPermissionOverwrite[] | undefined {
	const list = reader.optionalArray(payload, "permission_overwrites", "permission_overwrites");
	if (list === undefined) {
		return undefined;
	}

	const overwrites: ChannelPermissionOverwrite[] = [];

	for (const [index, entry] of list.entries()) {
		const path = `permission_overwrites[${index}]`;
		const overwrite = reader.elementAsObject(entry, path);
		const targetId = reader.requireId(overwrite, "id", `${path}.id`);
		const typeCode = reader.requireNumber(overwrite, "type", `${path}.type`);
		const targetType = overwriteTargetTypeFor(typeCode);
		if (targetType === undefined) {
			reader.reject(path, `unknown overwrite target type ${typeCode}`);
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

function readThreadMetadata(reader: RawPayloadReader, payload: RawObject): boolean | undefined {
	const metadata = reader.optionalObject(payload, "thread_metadata", "thread_metadata");
	if (metadata === undefined) {
		return undefined;
	}

	return reader.optionalBoolean(metadata, "archived", "thread_metadata.archived");
}

function channelCore(
	reader: RawPayloadReader,
	payload: RawObject
): {
	channelId: string;
	typeCode: number;
	name?: string;
	parentId?: string;
	overwrites?: ChannelPermissionOverwrite[];
} {
	const channelId = reader.requireId(payload, "id");
	const typeCode = reader.requireNumber(payload, "type");
	const name = reader.optionalString(payload, "name");
	const parentId = reader.optionalId(payload, "parent_id") ?? reader.optionalId(payload, "parent_channel_id");
	const overwrites = readOverwrites(reader, payload);

	return {
		channelId,
		typeCode,
		...(name === undefined ? {} : { name }),
		...(parentId === undefined ? {} : { parentId }),
		...(overwrites === undefined ? {} : { overwrites })
	};
}

/** A created channel or thread: the type code decides which application resource was created. */
export function mapChannelCreate(
	rawEventName: string,
	guildId: string,
	payload: RawObject
): ChannelCreatedEvent | ThreadCreatedEvent {
	const reader = new RawPayloadReader(rawEventName);
	const core = channelCore(reader, payload);

	if (isThreadChannelCode(core.typeCode)) {
		return mapThreadCreated(reader, guildId, payload, core.channelId, core.typeCode);
	}

	return {
		kind: DiscordEventKind.channelCreated,
		guildId,
		channelId: core.channelId,
		channelType: channelTypeNameFor(core.typeCode),
		...(core.name === undefined ? {} : { name: core.name }),
		...(core.parentId === undefined ? {} : { parentId: core.parentId }),
		...(core.overwrites === undefined ? {} : { permissionOverwrites: core.overwrites })
	};
}

export function mapChannelUpdate(
	rawEventName: string,
	guildId: string,
	payload: RawObject
): ChannelUpdatedEvent | ThreadUpdatedEvent {
	const reader = new RawPayloadReader(rawEventName);
	const core = channelCore(reader, payload);

	if (isThreadChannelCode(core.typeCode)) {
		return mapThreadUpdated(reader, guildId, payload, core.channelId, core.typeCode);
	}

	return {
		kind: DiscordEventKind.channelUpdated,
		guildId,
		channelId: core.channelId,
		channelType: channelTypeNameFor(core.typeCode),
		...(core.name === undefined ? {} : { name: core.name }),
		...(core.parentId === undefined ? {} : { parentId: core.parentId }),
		...(core.overwrites === undefined ? {} : { permissionOverwrites: core.overwrites })
	};
}

export function mapChannelDelete(
	rawEventName: string,
	guildId: string,
	payload: RawObject
): ChannelDeletedEvent | ThreadDeletedEvent {
	const reader = new RawPayloadReader(rawEventName);
	const channelId = reader.requireId(payload, "id");
	const typeCode = reader.requireNumber(payload, "type");

	if (isThreadChannelCode(typeCode)) {
		return {
			kind: DiscordEventKind.threadDeleted,
			guildId,
			threadId: channelId,
			...optionalParent(reader, payload)
		};
	}

	return {
		kind: DiscordEventKind.channelDeleted,
		guildId,
		channelId,
		channelType: channelTypeNameFor(typeCode)
	};
}

export function mapThreadCreate(rawEventName: string, guildId: string, payload: RawObject): ThreadCreatedEvent {
	const reader = new RawPayloadReader(rawEventName);
	const threadId = reader.requireId(payload, "id");
	const typeCode = reader.requireNumber(payload, "type");

	return mapThreadCreated(reader, guildId, payload, threadId, typeCode);
}

export function mapThreadUpdate(rawEventName: string, guildId: string, payload: RawObject): ThreadUpdatedEvent {
	const reader = new RawPayloadReader(rawEventName);
	const threadId = reader.requireId(payload, "id");
	const typeCode = reader.requireNumber(payload, "type");

	return mapThreadUpdated(reader, guildId, payload, threadId, typeCode);
}

export function mapThreadDelete(rawEventName: string, guildId: string, payload: RawObject): ThreadDeletedEvent {
	const reader = new RawPayloadReader(rawEventName);

	return {
		kind: DiscordEventKind.threadDeleted,
		guildId,
		threadId: reader.requireId(payload, "id"),
		...optionalParent(reader, payload)
	};
}

function optionalParent(reader: RawPayloadReader, payload: RawObject): { parentChannelId?: string } {
	const parentId = reader.optionalId(payload, "parent_id") ?? reader.optionalId(payload, "parent_channel_id");
	return parentId === undefined ? {} : { parentChannelId: parentId };
}

function mapThreadCreated(
	reader: RawPayloadReader,
	guildId: string,
	payload: RawObject,
	threadId: string,
	typeCode: number
): ThreadCreatedEvent {
	const name = reader.optionalString(payload, "name");
	const parentId = reader.optionalId(payload, "parent_id") ?? reader.optionalId(payload, "parent_channel_id");
	const archived = readThreadMetadata(reader, payload);
	const memberIds = reader.optionalArray(payload, "member_ids", "member_ids");

	return {
		kind: DiscordEventKind.threadCreated,
		guildId,
		threadId,
		threadType: channelTypeNameFor(typeCode),
		...(name === undefined ? {} : { name }),
		...(parentId === undefined ? {} : { parentChannelId: parentId }),
		...(archived === undefined ? {} : { archived }),
		...(memberIds === undefined ? {} : { memberIds: reader.idEntryList(memberIds, "member_ids") })
	};
}

function mapThreadUpdated(
	reader: RawPayloadReader,
	guildId: string,
	payload: RawObject,
	threadId: string,
	typeCode: number
): ThreadUpdatedEvent {
	const name = reader.optionalString(payload, "name");
	const parentId = reader.optionalId(payload, "parent_id") ?? reader.optionalId(payload, "parent_channel_id");
	const archived = readThreadMetadata(reader, payload);

	return {
		kind: DiscordEventKind.threadUpdated,
		guildId,
		threadId,
		threadType: channelTypeNameFor(typeCode),
		...(name === undefined ? {} : { name }),
		...(parentId === undefined ? {} : { parentChannelId: parentId }),
		...(archived === undefined ? {} : { archived })
	};
}
