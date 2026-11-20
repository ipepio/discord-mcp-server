import { describe, expect, it } from "vitest";
import { DiscordEventKind } from "../../../../src/features/discord/models/domain/discord-event-kind.enum.js";
import type {
	ChannelCreatedEvent,
	ChannelDeletedEvent,
	ChannelUpdatedEvent,
	ThreadCreatedEvent,
	ThreadDeletedEvent,
	ThreadUpdatedEvent
} from "../../../../src/features/discord/models/domain/normalized-discord-event.js";
import { expectRejected, GUILD_ID, normalizeOne } from "../fakes/normalize.js";

/**
 * R3 — channel and thread normalization. A thread is its own resource and its own kind, whether it
 * arrived as a `THREAD_*` payload or as a thread-typed `CHANNEL_*` payload, and an overwrite set is
 * either present (possibly empty) or absent (R10 of guild-state keeps the same distinction).
 */

describe("R3 — channel-created", () => {
	it("maps a text channel with its overwrite set", () => {
		expect(
			normalizeOne("CHANNEL_CREATE", {
				id: "400",
				guild_id: GUILD_ID,
				type: 0,
				name: "backend",
				position: 3,
				permission_overwrites: [{ id: "200", type: 0, allow: "1024", deny: "0" }]
			})
		).toEqual<ChannelCreatedEvent>({
			kind: DiscordEventKind.channelCreated,
			guildId: GUILD_ID,
			channelId: "400",
			channelType: "guild-text",
			name: "backend",
			permissionOverwrites: [{ targetId: "200", targetType: "role", allowBitfield: "1024", denyBitfield: "0" }]
		});
	});

	it("maps a member overwrite as a member target", () => {
		const event = normalizeOne<ChannelCreatedEvent>("CHANNEL_CREATE", {
			id: "400",
			guild_id: GUILD_ID,
			type: 0,
			permission_overwrites: [{ id: "300", type: 1, allow: "0", deny: "1024" }]
		});

		expect(event.permissionOverwrites?.[0]?.targetType).toBe("member");
	});

	it("keeps an explicit empty overwrite set distinct from a payload without one", () => {
		const withEmpty = normalizeOne<ChannelCreatedEvent>("CHANNEL_CREATE", {
			id: "400",
			guild_id: GUILD_ID,
			type: 0,
			permission_overwrites: []
		});
		const without = normalizeOne("CHANNEL_CREATE", { id: "400", guild_id: GUILD_ID, type: 0 });

		expect(withEmpty.permissionOverwrites).toEqual([]);
		expect(Object.hasOwn(without, "permissionOverwrites")).toBe(false);
		expect(Object.hasOwn(without, "name")).toBe(false);
	});

	it("maps a category parent as an optional relation", () => {
		const event = normalizeOne<ChannelCreatedEvent>("CHANNEL_CREATE", {
			id: "400",
			guild_id: GUILD_ID,
			type: 0,
			name: "backend",
			parent_id: "350"
		});

		expect(event.parentId).toBe("350");
	});

	it("maps an unknown channel type code as unknown rather than the nearest known type", () => {
		expect(
			normalizeOne<ChannelCreatedEvent>("CHANNEL_CREATE", { id: "400", guild_id: GUILD_ID, type: 99 }).channelType
		).toBe("unknown");
	});

	it("rejects an overwrite entry with an unresolvable target type", () => {
		expectRejected(
			"CHANNEL_CREATE",
			{
				id: "400",
				guild_id: GUILD_ID,
				type: 0,
				permission_overwrites: [{ id: "200", type: 7, allow: "0", deny: "0" }]
			},
			"permission_overwrites[0]"
		);
	});

	it("rejects a channel payload without a type", () => {
		expectRejected("CHANNEL_CREATE", { id: "400", guild_id: GUILD_ID }, "type");
	});
});

describe("R3 — channel-updated and channel-deleted", () => {
	it("maps a rename", () => {
		expect(
			normalizeOne("CHANNEL_UPDATE", { id: "400", guild_id: GUILD_ID, type: 0, name: "frontend" })
		).toEqual<ChannelUpdatedEvent>({
			kind: DiscordEventKind.channelUpdated,
			guildId: GUILD_ID,
			channelId: "400",
			channelType: "guild-text",
			name: "frontend"
		});
	});

	it("maps a deletion with the channel type, so the consumer can cascade correctly", () => {
		expect(
			normalizeOne("CHANNEL_DELETE", { id: "400", guild_id: GUILD_ID, type: 15 })
		).toEqual<ChannelDeletedEvent>({
			kind: DiscordEventKind.channelDeleted,
			guildId: GUILD_ID,
			channelId: "400",
			channelType: "guild-forum"
		});
	});

	it("rejects a deletion payload whose id is not a snowflake", () => {
		expectRejected("CHANNEL_DELETE", { id: "", guild_id: GUILD_ID, type: 0 }, "id");
	});
});

describe("R3 — thread kinds", () => {
	it("maps THREAD_CREATE as a thread event carrying its parent and archive state", () => {
		expect(
			normalizeOne("THREAD_CREATE", {
				id: "410",
				guild_id: GUILD_ID,
				parent_id: "400",
				type: 11,
				name: "release",
				thread_metadata: { archived: false, auto_archive_duration: 1440 }
			})
		).toEqual<ThreadCreatedEvent>({
			kind: DiscordEventKind.threadCreated,
			guildId: GUILD_ID,
			threadId: "410",
			parentChannelId: "400",
			name: "release",
			archived: false,
			threadType: "public-thread"
		});
	});

	it("keeps the initial member list of a private thread when the payload carries it", () => {
		const event = normalizeOne("THREAD_CREATE", {
			id: "411",
			guild_id: GUILD_ID,
			parent_id: "400",
			type: 12,
			member_ids: ["300", "301"]
		});

		expect(event).toEqual<ThreadCreatedEvent>({
			kind: DiscordEventKind.threadCreated,
			guildId: GUILD_ID,
			threadId: "411",
			parentChannelId: "400",
			threadType: "private-thread",
			memberIds: ["300", "301"]
		});
	});

	it("treats a thread-typed CHANNEL_CREATE as the same thread kind", () => {
		const event = normalizeOne<ThreadCreatedEvent>("CHANNEL_CREATE", {
			id: "412",
			guild_id: GUILD_ID,
			type: 11,
			name: "from-channel"
		});

		expect(event.kind).toBe(DiscordEventKind.threadCreated);
		expect(event.threadType).toBe("public-thread");
	});

	it("maps THREAD_UPDATE without inventing an archive state the payload omitted", () => {
		const event = normalizeOne("THREAD_UPDATE", { id: "410", guild_id: GUILD_ID, type: 11, name: "renamed" });

		expect(event).toEqual<ThreadUpdatedEvent>({
			kind: DiscordEventKind.threadUpdated,
			guildId: GUILD_ID,
			threadId: "410",
			name: "renamed",
			threadType: "public-thread"
		});
	});

	it("maps THREAD_DELETE and its parent when the payload names one", () => {
		expect(normalizeOne("THREAD_DELETE", { id: "410", guild_id: GUILD_ID, type: 11 })).toEqual<ThreadDeletedEvent>({
			kind: DiscordEventKind.threadDeleted,
			guildId: GUILD_ID,
			threadId: "410"
		});

		expect(
			normalizeOne("CHANNEL_DELETE", { id: "410", guild_id: GUILD_ID, type: 11, parent_channel_id: "400" })
		).toEqual<ThreadDeletedEvent>({
			kind: DiscordEventKind.threadDeleted,
			guildId: GUILD_ID,
			threadId: "410",
			parentChannelId: "400"
		});
	});

	it("rejects a thread payload whose parent id is malformed", () => {
		expectRejected("THREAD_CREATE", { id: "410", guild_id: GUILD_ID, type: 11, parent_id: "none" }, "parent_id");
	});
});
