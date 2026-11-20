import { DiscordEventKind } from "../domain/discord-event-kind.enum.js";
import type {
	GuildUpdatedEvent,
	MemberAddedEvent,
	MemberRemovedEvent,
	MemberUpdatedEvent,
	RoleCreatedEvent,
	RoleDeletedEvent,
	RoleUpdatedEvent,
	ThreadMemberAddedEvent,
	ThreadMemberRemovedEvent
} from "../domain/normalized-discord-event.js";
import type { RawObject } from "./raw-payload.reader.js";
import { RawPayloadReader } from "./raw-payload.reader.js";

/**
 * Guild, role, member and thread-membership raw payloads to normalized events (spec R3). The payloads
 * arrive in Discord's wire shape (`role` nested, `after`/`before` for member updates), and each mapper
 * returns exactly the application fields consumers named — the role set whole, never merged, so
 * guild-state can replace stored state on replay (guild-state R9).
 */

export function mapGuildUpdate(rawEventName: string, guildId: string, payload: RawObject): GuildUpdatedEvent {
	const reader = new RawPayloadReader(rawEventName);
	const guildName = reader.optionalString(payload, "name");
	const ownerId = reader.optionalId(payload, "owner_id");
	const memberCount =
		reader.optionalNumber(payload, "approximate_member_count") ?? reader.optionalNumber(payload, "member_count");

	return {
		kind: DiscordEventKind.guildUpdated,
		guildId,
		...(guildName === undefined ? {} : { guildName }),
		...(ownerId === undefined ? {} : { ownerId }),
		...(memberCount === undefined ? {} : { memberCount })
	};
}

function readRole(
	reader: RawPayloadReader,
	payload: RawObject
): { roleId: string; roleName?: string; permissionsBitfield?: string } {
	const role = reader.requireObject(payload, "role", "role");
	const roleId = reader.requireId(role, "id", "role.id");
	const roleName = reader.optionalString(role, "name", "role.name");
	const permissionsBitfield = reader.optionalString(role, "permissions", "role.permissions");

	return {
		roleId,
		...(roleName === undefined ? {} : { roleName }),
		...(permissionsBitfield === undefined ? {} : { permissionsBitfield })
	};
}

export function mapRoleCreate(rawEventName: string, guildId: string, payload: RawObject): RoleCreatedEvent {
	const reader = new RawPayloadReader(rawEventName);
	const role = readRole(reader, payload);

	return { kind: DiscordEventKind.roleCreated, guildId, ...role };
}

export function mapRoleUpdate(rawEventName: string, guildId: string, payload: RawObject): RoleUpdatedEvent {
	const reader = new RawPayloadReader(rawEventName);
	const role = readRole(reader, payload);

	return { kind: DiscordEventKind.roleUpdated, guildId, ...role };
}

export function mapRoleDelete(rawEventName: string, guildId: string, payload: RawObject): RoleDeletedEvent {
	const reader = new RawPayloadReader(rawEventName);

	return { kind: DiscordEventKind.roleDeleted, guildId, roleId: reader.requireId(payload, "role_id") };
}

/** The member object of a `GUILD_MEMBER_*` payload: id, the whole role set, and the optional facts. */
function readMember(
	reader: RawPayloadReader,
	member: RawObject,
	prefix: string
): { userId: string; roleIds: readonly string[]; nickname?: string; joinedInstant?: Date; isPending?: boolean } {
	const user = reader.requireObject(member, "user", `${prefix}user`);
	const userId = reader.requireId(user, "id", `${prefix}user.id`);
	const roleIds = reader.idList(member, "roles", `${prefix}roles`);
	const nickname = reader.optionalString(member, "nick", `${prefix}nick`);
	const joinedInstant = reader.optionalInstant(member, "joined_at", `${prefix}joined_at`);
	const isPending = reader.optionalBoolean(member, "pending", `${prefix}pending`);

	return {
		userId,
		roleIds,
		...(nickname === undefined ? {} : { nickname }),
		...(joinedInstant === undefined ? {} : { joinedInstant }),
		...(isPending === undefined ? {} : { isPending })
	};
}

export function mapMemberAdd(rawEventName: string, guildId: string, payload: RawObject): MemberAddedEvent {
	const reader = new RawPayloadReader(rawEventName);
	const member = readMember(reader, payload, "");

	return { kind: DiscordEventKind.memberAdded, guildId, ...member };
}

/**
 * GUILD_MEMBER_UPDATE carries `before` and `after`; the event names the new state, because consumers
 * replace the whole resource and the comparison they need is Discord's own timestamp, not our order
 * (guild-state R10, ingestion R8).
 */
export function mapMemberUpdate(rawEventName: string, guildId: string, payload: RawObject): MemberUpdatedEvent {
	const reader = new RawPayloadReader(rawEventName);
	const after = reader.requireObject(payload, "after", "after");
	const member = readMember(reader, after, "after.");

	return { kind: DiscordEventKind.memberUpdated, guildId, ...member };
}

export function mapMemberRemove(rawEventName: string, guildId: string, payload: RawObject): MemberRemovedEvent {
	const reader = new RawPayloadReader(rawEventName);
	const user = reader.requireObject(payload, "user", "user");

	return { kind: DiscordEventKind.memberRemoved, guildId, userId: reader.requireId(user, "id", "user.id") };
}

/**
 * THREAD_MEMBERS_UPDATE is a delta, so one raw payload becomes zero or several membership events.
 * `THREAD_MEMBER_LIST_SYNC` is deliberately not mapped: a whole-list snapshot is not a set of
 * "added" facts, and inventing those facts would be exactly the nearest-known-kind error R3 forbids.
 * It stays visible through the unknown-kind counter, and guild-state repairs it by resync.
 */
export function mapThreadMembersUpdate(
	rawEventName: string,
	guildId: string,
	payload: RawObject
): readonly (ThreadMemberAddedEvent | ThreadMemberRemovedEvent)[] {
	const reader = new RawPayloadReader(rawEventName);
	const threadId = reader.requireId(payload, "id");
	const events: (ThreadMemberAddedEvent | ThreadMemberRemovedEvent)[] = [];

	const added = reader.optionalArray(payload, "added_members", "added_members");
	if (added !== undefined) {
		for (const [index, entry] of added.entries()) {
			const path = `added_members[${index}]`;
			const member = reader.elementAsObject(entry, path);
			// The member id is the User id for this resource; `user_id` is preferred when present.
			const userId =
				reader.optionalId(member, "user_id", `${path}.user_id`) ?? reader.requireId(member, "id", `${path}.id`);
			events.push({ kind: DiscordEventKind.threadMemberAdded, guildId, threadId, userId });
		}
	}

	const removed = reader.optionalArray(payload, "removed_member_ids", "removed_member_ids");
	if (removed !== undefined) {
		for (const userId of reader.idEntryList(removed, "removed_member_ids")) {
			events.push({ kind: DiscordEventKind.threadMemberRemoved, guildId, threadId, userId });
		}
	}

	return events;
}
