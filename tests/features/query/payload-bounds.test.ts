import { describe, expect, it } from "vitest";
import { QueryPayloadPolicy, messageCursorKey } from "../../../src/features/query/queries/query-payload.policy.js";
import { decodeCursor } from "../../../src/features/query/queries/query-cursor.js";
import { loadQueryConfig } from "../../../src/shared/config/query-config.factory.js";
import type { MessageResult } from "../../../src/features/query/models/domain/tool-result.js";
const message: MessageResult = {
	messageId: "100",
	guildId: "1",
	channelId: "10",
	channelName: "general",
	parentChannelId: null,
	authorId: "7",
	authorDisplayName: null,
	createdAt: "2026-01-01T00:00:00Z",
	editedAt: null,
	messageType: "default",
	replyToMessageId: null,
	content: "😀".repeat(40000),
	contentLength: 40000,
	attachments: [
		{ attachmentId: "5", filename: "file", contentType: null, sizeBytes: 50, url: "https://example.invalid/file" }
	],
	truncated: false
};
const input = { pageSize: 20, windowSize: 20, channelId: "10" };
describe("payload-bounds", () => {
	it("truncates content head explicitly preserving stored length and every attachment", () => {
		const result = new QueryPayloadPolicy().bound(
			"get_channel_history",
			input,
			{ data: [message], pagination: { pageSize: 20, hasNext: false, nextCursor: null } },
			messageCursorKey
		);
		expect(result.data[0]).toEqual({ ...message, content: "😀".repeat(4000), truncated: true });
		const tiny = new QueryPayloadPolicy({ maxMessageChars: 4000, maxResponseBytes: 2048 }).bound(
			"get_message_context",
			input,
			{ data: [message], anchorMessageId: "100" },
			messageCursorKey
		);
		expect(Buffer.byteLength(JSON.stringify(tiny)) + 1024).toBeLessThanOrEqual(2048);
		expect(tiny.data[0]).toMatchObject({ truncated: true, contentLength: 40000, attachments: message.attachments });
	});
	it("shortens a page and resumes after the LAST RETURNED key", () => {
		const limits = { maxMessageChars: 4000, maxResponseBytes: 20000 };
		const result = new QueryPayloadPolicy(limits).bound(
			"get_channel_history",
			input,
			{
				data: [message, { ...message, messageId: "101" }],
				pagination: { pageSize: 20, hasNext: false, nextCursor: null }
			},
			messageCursorKey
		);
		expect(result.data).toHaveLength(1);
		expect(result.pagination?.hasNext).toBe(true);
		const cursor = result.pagination?.nextCursor;
		if (!cursor) throw new Error("missing cursor");
		expect(decodeCursor("get_channel_history", { ...input, cursor })).toMatchObject({ messageId: "100" });
		expect(Buffer.byteLength(JSON.stringify(result)) + 1024).toBeLessThanOrEqual(limits.maxResponseBytes);
	});
	it("context shortening is explicit and keeps the anchor", () => {
		const result = new QueryPayloadPolicy({ maxMessageChars: 4000, maxResponseBytes: 20000 }).bound(
			"get_message_context",
			input,
			{ data: [{ ...message, messageId: "99" }, message], anchorMessageId: "100" },
			messageCursorKey
		);
		expect(result).toMatchObject({ anchorMessageId: "100", windowTruncated: true });
		expect(result.data).toHaveLength(1);
		expect(result.data[0]).toMatchObject({ messageId: "100" });
	});
	it("unrepresentable attachment metadata fails atomically instead of silently dropping fields", () => {
		expect(() =>
			new QueryPayloadPolicy({ maxMessageChars: 1, maxResponseBytes: 2048 }).bound(
				"get_message_context",
				input,
				{ data: [{ ...message, channelName: "x".repeat(5000) }], anchorMessageId: "100" },
				messageCursorKey
			)
		).toThrow("bounded response");
	});
	it("payload configuration is validated at composition", () => {
		expect(loadQueryConfig({})).toEqual({ maxMessageChars: 4000, maxResponseBytes: 262144 });
		expect(loadQueryConfig({ QUERY_MAX_MESSAGE_CHARS: "8000", QUERY_MAX_RESPONSE_BYTES: "524288" })).toEqual({
			maxMessageChars: 8000,
			maxResponseBytes: 524288
		});
		for (const value of ["0", "-1", "NaN", "1.5", "", "999999999999999999999"])
			expect(() => loadQueryConfig({ QUERY_MAX_MESSAGE_CHARS: value })).toThrow();
	});
});
