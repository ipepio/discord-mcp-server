import { DiscordEventKind } from "../domain/discord-event-kind.enum.js";
import type { DiscordEventKind as EventKind } from "../domain/discord-event-kind.enum.js";
import type { NormalizedDiscordEvent } from "../domain/normalized-discord-event.js";
import { MalformedRawPayloadError } from "./raw-payload.errors.js";
import type { RawObject } from "./raw-payload.reader.js";
import { RawPayloadReader } from "./raw-payload.reader.js";
import {
	mapChannelCreate,
	mapChannelDelete,
	mapChannelUpdate,
	mapThreadCreate,
	mapThreadDelete,
	mapThreadUpdate
} from "./channel-thread-event.mapper.js";
import {
	mapGuildUpdate,
	mapMemberAdd,
	mapMemberRemove,
	mapMemberUpdate,
	mapRoleCreate,
	mapRoleDelete,
	mapRoleUpdate,
	mapThreadMembersUpdate
} from "./guild-resource-event.mapper.js";
import { mapMessageCreate, mapMessageDelete, mapMessageDeleteBulk, mapMessageUpdate } from "./message-event.mapper.js";
/**
 * The registry of raw Discord event names to normalized kinds (spec R3). A name outside this table is
 * counted and logged by that name: never dropped in silence, never mapped to the nearest known kind,
 * never published as an invented kind.
 *
 * `THREAD_MEMBER_LIST_SYNC` is deliberately absent. A whole member list is not a set of "added"
 * facts, so mapping it to thread-member additions would invent state; it surfaces through the
 * unknown-kind counter and guild-state repairs it by resync (R5).
 */
export interface RawEventMapping {
	/** The kind a payload of this name is expected to produce, used to count a rejected payload. */
	readonly kind: EventKind;
	readonly map: (rawEventName: string, guildId: string, payload: RawObject) => readonly NormalizedDiscordEvent[];
}

function single(event: NormalizedDiscordEvent): readonly NormalizedDiscordEvent[] {
	return [event];
}

export const RAW_EVENT_MAPPINGS: Readonly<Record<string, RawEventMapping>> = Object.freeze({
	MESSAGE_CREATE: {
		kind: DiscordEventKind.messageCreated,
		map: (rawEventName, guildId, payload) => single(mapMessageCreate(rawEventName, guildId, payload))
	},
	MESSAGE_UPDATE: {
		kind: DiscordEventKind.messageUpdated,
		map: (rawEventName, guildId, payload) => single(mapMessageUpdate(rawEventName, guildId, payload))
	},
	MESSAGE_DELETE: {
		kind: DiscordEventKind.messageDeleted,
		map: (rawEventName, guildId, payload) => single(mapMessageDelete(rawEventName, guildId, payload))
	},
	MESSAGE_DELETE_BULK: {
		kind: DiscordEventKind.messageBulkDeleted,
		map: (rawEventName, guildId, payload) => single(mapMessageDeleteBulk(rawEventName, guildId, payload))
	},
	CHANNEL_CREATE: {
		kind: DiscordEventKind.channelCreated,
		map: (rawEventName, guildId, payload) => single(mapChannelCreate(rawEventName, guildId, payload))
	},
	CHANNEL_UPDATE: {
		kind: DiscordEventKind.channelUpdated,
		map: (rawEventName, guildId, payload) => single(mapChannelUpdate(rawEventName, guildId, payload))
	},
	CHANNEL_DELETE: {
		kind: DiscordEventKind.channelDeleted,
		map: (rawEventName, guildId, payload) => single(mapChannelDelete(rawEventName, guildId, payload))
	},
	THREAD_CREATE: {
		kind: DiscordEventKind.threadCreated,
		map: (rawEventName, guildId, payload) => single(mapThreadCreate(rawEventName, guildId, payload))
	},
	THREAD_UPDATE: {
		kind: DiscordEventKind.threadUpdated,
		map: (rawEventName, guildId, payload) => single(mapThreadUpdate(rawEventName, guildId, payload))
	},
	THREAD_DELETE: {
		kind: DiscordEventKind.threadDeleted,
		map: (rawEventName, guildId, payload) => single(mapThreadDelete(rawEventName, guildId, payload))
	},
	GUILD_CREATE: {
		kind: DiscordEventKind.guildUpdated,
		map: (rawEventName, guildId, payload) => single(mapGuildUpdate(rawEventName, guildId, payload))
	},
	GUILD_UPDATE: {
		kind: DiscordEventKind.guildUpdated,
		map: (rawEventName, guildId, payload) => single(mapGuildUpdate(rawEventName, guildId, payload))
	},
	GUILD_ROLE_CREATE: {
		kind: DiscordEventKind.roleCreated,
		map: (rawEventName, guildId, payload) => single(mapRoleCreate(rawEventName, guildId, payload))
	},
	GUILD_ROLE_UPDATE: {
		kind: DiscordEventKind.roleUpdated,
		map: (rawEventName, guildId, payload) => single(mapRoleUpdate(rawEventName, guildId, payload))
	},
	GUILD_ROLE_DELETE: {
		kind: DiscordEventKind.roleDeleted,
		map: (rawEventName, guildId, payload) => single(mapRoleDelete(rawEventName, guildId, payload))
	},
	GUILD_MEMBER_ADD: {
		kind: DiscordEventKind.memberAdded,
		map: (rawEventName, guildId, payload) => single(mapMemberAdd(rawEventName, guildId, payload))
	},
	GUILD_MEMBER_UPDATE: {
		kind: DiscordEventKind.memberUpdated,
		map: (rawEventName, guildId, payload) => single(mapMemberUpdate(rawEventName, guildId, payload))
	},
	GUILD_MEMBER_REMOVE: {
		kind: DiscordEventKind.memberRemoved,
		map: (rawEventName, guildId, payload) => single(mapMemberRemove(rawEventName, guildId, payload))
	},
	THREAD_MEMBERS_UPDATE: {
		kind: DiscordEventKind.threadMemberAdded,
		map: (rawEventName, guildId, payload) => mapThreadMembersUpdate(rawEventName, guildId, payload)
	}
});

export function findRawEventMapping(rawEventName: string): RawEventMapping | undefined {
	return Object.prototype.hasOwnProperty.call(RAW_EVENT_MAPPINGS, rawEventName)
		? RAW_EVENT_MAPPINGS[rawEventName]
		: undefined;
}

/** One normalized payload per accepted raw event, or the reason the payload was rejected (R3). */
export type RawMappingResult =
	| { readonly outcome: "normalized"; readonly events: readonly NormalizedDiscordEvent[] }
	| { readonly outcome: "unknown-kind" }
	| {
			readonly outcome: "malformed";
			readonly kind: EventKind;
			readonly fieldPath: string;
			readonly reason: string;
	  };

/**
 * Maps a raw event of the configured Guild. The source filter has already run: this function never
 * looks at the Guild id, which is what keeps the filter before normalization (R2).
 */
export function mapRawEvent(rawEventName: string, payload: unknown, guildId: string): RawMappingResult {
	const mapping = findRawEventMapping(rawEventName);
	if (mapping === undefined) {
		return { outcome: "unknown-kind" };
	}

	const reader = new RawPayloadReader(rawEventName);

	try {
		return { outcome: "normalized", events: mapping.map(rawEventName, guildId, reader.root(payload)) };
	} catch (error) {
		if (error instanceof MalformedRawPayloadError) {
			return { outcome: "malformed", kind: mapping.kind, fieldPath: error.fieldPath, reason: error.reason };
		}

		throw error;
	}
}
