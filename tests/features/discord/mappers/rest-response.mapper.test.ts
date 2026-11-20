import { describe, expect, it } from "vitest";
import { mapMessageRecords } from "../../../../src/features/discord/models/mappers/discord-rest-response.mapper.js";
import { DiscordRestOperation } from "../../../../src/features/discord/models/domain/discord-rest-operation.enum.js";

/**
 * The 2026-11-13 production import deferred 43 channels with
 * `stopReason: rest-payload-invalid`, `fieldPath: messages[N].message_reference.message_id`: Discord
 * omits `message_id` inside `message_reference` when the referenced message no longer exists, and the
 * mapper required it, so a whole history page became invalid and the channel could never be imported.
 *
 * These tests pin the page-level consequence, not just the field: a page that contains such a message
 * must map, with that message carrying no reply reference.
 */
const CHANNEL_ID = "885083666462679040";

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "100000000000000001",
		channel_id: CHANNEL_ID,
		author: { id: "200000000000000002", username: "someone" },
		content: "hola",
		timestamp: "2026-11-13T09:00:00.000Z",
		type: 0,
		...overrides
	};
}

describe("REST message page mapping", () => {
	it("maps a page whose message carries message_reference without message_id", () => {
		const records = mapMessageRecords(DiscordRestOperation.messageHistory, CHANNEL_ID, [
			message({
				id: "100000000000000002",
				message_reference: { channel_id: CHANNEL_ID, guild_id: "885076913381576714" }
			})
		]);

		expect(records).toHaveLength(1);
		// A reference with nothing to point at is "no reply we can record", not an invalid page.
		expect(records[0]?.replyReference).toBeUndefined();
		expect(records[0]?.content).toBe("hola");
	});

	it("keeps a resolvable message_reference intact", () => {
		const records = mapMessageRecords(DiscordRestOperation.messageHistory, CHANNEL_ID, [
			message({
				message_reference: {
					message_id: "100000000000000009",
					channel_id: CHANNEL_ID,
					guild_id: "885076913381576714"
				}
			})
		]);

		expect(records[0]?.replyReference).toEqual({
			messageId: "100000000000000009",
			channelId: CHANNEL_ID,
			guildId: "885076913381576714"
		});
	});

	it("still rejects a page whose message carries a malformed id", () => {
		expect(() =>
			mapMessageRecords(DiscordRestOperation.messageHistory, CHANNEL_ID, [message({ id: "not-a-snowflake" })])
		).toThrow();
	});
});
