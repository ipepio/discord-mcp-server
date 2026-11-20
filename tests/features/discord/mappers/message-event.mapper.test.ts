import { describe, expect, it } from "vitest";
import { DiscordEventKind } from "../../../../src/features/discord/models/domain/discord-event-kind.enum.js";
import type {
	MessageBulkDeletedEvent,
	MessageCreatedEvent,
	MessageDeletedEvent,
	MessageUpdatedEvent
} from "../../../../src/features/discord/models/domain/normalized-discord-event.js";
import { expectRejected, GUILD_ID, normalizeOne } from "../fakes/normalize.js";

/**
 * R3 — MESSAGE_* normalization, field by field, including the distinction between a field Discord
 * omitted and a field it sent empty. Content is part of the event because ingestion stores it; the
 * transport never logs it (R11).
 */

const MESSAGE_PAYLOAD = {
	id: "500",
	channel_id: "400",
	guild_id: GUILD_ID,
	author: { id: "300", username: "someone", bot: false },
	content: "hello there",
	timestamp: "2026-11-05T10:00:00.000Z",
	edited_timestamp: "2026-11-05T10:05:00.000Z",
	type: 19,
	message_reference: { message_id: "499", channel_id: "400", guild_id: GUILD_ID },
	attachments: [
		{ id: "600", filename: "plan.png", content_type: "image/png", size: 1234, url: "https://cdn.example/plan.png" }
	]
};

describe("R3 — message-created", () => {
	it("maps every field a consumer needs from a full payload", () => {
		expect(normalizeOne("MESSAGE_CREATE", MESSAGE_PAYLOAD)).toEqual<MessageCreatedEvent>({
			kind: DiscordEventKind.messageCreated,
			guildId: GUILD_ID,
			messageId: "500",
			channelId: "400",
			authorId: "300",
			authorUsername: "someone",
			authorIsBot: false,
			content: "hello there",
			createdInstant: new Date("2026-11-05T10:00:00.000Z"),
			editedInstant: new Date("2026-11-05T10:05:00.000Z"),
			messageType: "reply",
			replyReference: { messageId: "499", channelId: "400", guildId: GUILD_ID },
			attachments: [
				{
					attachmentId: "600",
					filename: "plan.png",
					url: "https://cdn.example/plan.png",
					sizeBytes: 1234,
					contentType: "image/png"
				}
			]
		});
	});

	it("keeps an absent edit timestamp, an absent reply and an absent attachment list absent", () => {
		const event = normalizeOne("MESSAGE_CREATE", {
			id: "501",
			channel_id: "400",
			guild_id: GUILD_ID,
			author: { id: "300" },
			content: "",
			timestamp: "2026-11-05T10:00:00.000Z",
			type: 0
		});

		expect(event).toEqual<MessageCreatedEvent>({
			kind: DiscordEventKind.messageCreated,
			guildId: GUILD_ID,
			messageId: "501",
			channelId: "400",
			authorId: "300",
			content: "",
			createdInstant: new Date("2026-11-05T10:00:00.000Z"),
			messageType: "default"
		});
		expect(Object.hasOwn(event, "editedInstant")).toBe(false);
		expect(Object.hasOwn(event, "attachments")).toBe(false);
		expect(Object.hasOwn(event, "replyReference")).toBe(false);
		expect(Object.hasOwn(event, "authorUsername")).toBe(false);
	});

	it("distinguishes an empty attachment list from no attachment field at all", () => {
		const event = normalizeOne<MessageCreatedEvent>("MESSAGE_CREATE", { ...MESSAGE_PAYLOAD, attachments: [] });

		expect(event.attachments).toEqual([]);
		expect(Object.hasOwn(event, "attachments")).toBe(true);
	});

	it("keeps a null edited timestamp absent rather than inventing one", () => {
		const event = normalizeOne("MESSAGE_CREATE", { ...MESSAGE_PAYLOAD, edited_timestamp: null });

		expect(Object.hasOwn(event, "editedInstant")).toBe(false);
	});

	it("names a webhook author and its provenance", () => {
		const event = normalizeOne<MessageCreatedEvent>("MESSAGE_CREATE", {
			...MESSAGE_PAYLOAD,
			author: { id: "300", username: "hooks", bot: true, webhook_id: "700" }
		});

		expect(event.authorIsBot).toBe(true);
		expect(event.webhookId).toBe("700");
	});

	it.each([
		["default", 0],
		["reply", 19],
		["chat-input-command", 20],
		["auto-moderation-action", 24],
		["poll-result", 46]
	])("maps the message type code %s", (name, code) => {
		expect(
			normalizeOne<MessageCreatedEvent>("MESSAGE_CREATE", { ...MESSAGE_PAYLOAD, type: code }).messageType
		).toBe(name);
	});

	it("maps an unrecognized message type code to unknown instead of guessing", () => {
		expect(normalizeOne<MessageCreatedEvent>("MESSAGE_CREATE", { ...MESSAGE_PAYLOAD, type: 999 }).messageType).toBe(
			"unknown"
		);
	});

	it("rejects a payload without a channel id", () => {
		expectRejected("MESSAGE_CREATE", { ...MESSAGE_PAYLOAD, channel_id: undefined }, "channel_id");
	});

	it("rejects a malformed message id and reports the field path", () => {
		expectRejected("MESSAGE_CREATE", { ...MESSAGE_PAYLOAD, id: "0" }, "id");
	});

	it("rejects a timestamp that is not parseable", () => {
		expectRejected("MESSAGE_CREATE", { ...MESSAGE_PAYLOAD, timestamp: "yesterday" }, "timestamp");
	});

	it("rejects an attachment entry without a url, naming its index", () => {
		expectRejected(
			"MESSAGE_CREATE",
			{
				...MESSAGE_PAYLOAD,
				attachments: [
					{ id: "600", filename: "plan.png", size: 1, url: "https://x" },
					{ id: "601", filename: "b", size: 2 }
				]
			},
			"attachments[1].url"
		);
	});

	it("rejects a reply reference without a referenced message id", () => {
		expectRejected(
			"MESSAGE_CREATE",
			{ ...MESSAGE_PAYLOAD, message_reference: { channel_id: "400" } },
			"message_reference.message_id"
		);
	});
});

describe("R3 — message-updated", () => {
	it("maps a content-bearing edit", () => {
		expect(
			normalizeOne("MESSAGE_UPDATE", {
				id: "500",
				channel_id: "400",
				guild_id: GUILD_ID,
				content: "edited text",
				edited_timestamp: "2026-11-05T10:09:00.000Z"
			})
		).toEqual<MessageUpdatedEvent>({
			kind: DiscordEventKind.messageUpdated,
			guildId: GUILD_ID,
			messageId: "500",
			channelId: "400",
			content: "edited text",
			editedInstant: new Date("2026-11-05T10:09:00.000Z")
		});
	});

	it("publishes no content for a partial update, so the consumer reconciles instead of overwriting", () => {
		const event = normalizeOne("MESSAGE_UPDATE", { id: "500", channel_id: "400", guild_id: GUILD_ID, flags: "1" });

		expect(event).toEqual<MessageUpdatedEvent>({
			kind: DiscordEventKind.messageUpdated,
			guildId: GUILD_ID,
			messageId: "500",
			channelId: "400"
		});
	});

	it("keeps an empty content distinguishable from an absent one", () => {
		const event = normalizeOne<MessageUpdatedEvent>("MESSAGE_UPDATE", {
			id: "500",
			channel_id: "400",
			guild_id: GUILD_ID,
			content: "",
			edited_timestamp: "2026-11-05T10:09:00.000Z"
		});

		expect(event.content).toBe("");
	});

	it("rejects an update without a message id", () => {
		expectRejected("MESSAGE_UPDATE", { channel_id: "400", guild_id: GUILD_ID }, "id");
	});
});

describe("R3 — message-deleted and message-bulk-deleted", () => {
	it("maps a single deletion", () => {
		expect(
			normalizeOne("MESSAGE_DELETE", { id: "500", channel_id: "400", guild_id: GUILD_ID })
		).toEqual<MessageDeletedEvent>({
			kind: DiscordEventKind.messageDeleted,
			guildId: GUILD_ID,
			messageId: "500",
			channelId: "400"
		});
	});

	it("maps a bulk deletion with its whole id list", () => {
		expect(
			normalizeOne("MESSAGE_DELETE_BULK", {
				ids: ["500", "501", "502"],
				channel_id: "400",
				guild_id: GUILD_ID
			})
		).toEqual<MessageBulkDeletedEvent>({
			kind: DiscordEventKind.messageBulkDeleted,
			guildId: GUILD_ID,
			channelId: "400",
			messageIds: ["500", "501", "502"]
		});
	});

	it("rejects a bulk deletion carrying a non-snowflake id", () => {
		expectRejected("MESSAGE_DELETE_BULK", { ids: ["500", "nope"], channel_id: "400", guild_id: GUILD_ID }, "ids");
	});

	it("rejects a bulk deletion without any id list", () => {
		expectRejected("MESSAGE_DELETE_BULK", { channel_id: "400", guild_id: GUILD_ID }, "ids");
	});
});
