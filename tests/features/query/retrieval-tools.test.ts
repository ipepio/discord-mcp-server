import { describe, expect, it, vi } from "vitest";
import { QueryAccessPolicy } from "../../../src/features/query/queries/query-access.policy.js";
import type { QueryChannel } from "../../../src/features/query/queries/query-access.policy.js";
import { SearchCandidatesQuery } from "../../../src/features/query/queries/search-candidates.query.js";
import { SearchMessagesQuery } from "../../../src/features/query/queries/search-messages.query.js";
import { ListChannelsQuery } from "../../../src/features/query/queries/list-channels.query.js";
import { GetChannelHistoryQuery } from "../../../src/features/query/queries/get-channel-history.query.js";
import { GetThreadMessagesQuery } from "../../../src/features/query/queries/get-thread-messages.query.js";
import { GetMessageContextQuery } from "../../../src/features/query/queries/get-message-context.query.js";
import type { StoredMessage } from "../../../src/features/query/models/domain/message.js";
import type { AppLogger } from "../../../src/shared/logging/logger.interface.js";
import { parseToolInput } from "../../../src/features/query/models/dtos/tool-schema.dto.js";

const logger: AppLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => logger };
export const message: StoredMessage = {
	messageId: "100",
	guildId: "1",
	channelId: "10",
	authorId: "7",
	authorDisplayName: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	editedAt: null,
	messageType: "default",
	replyToMessageId: null,
	content: "hello",
	contentLength: 5,
	attachments: []
};
export const visible: QueryChannel = {
	channelId: "10",
	channelType: "guild-text",
	isThread: false,
	parentChannelId: null,
	name: "general",
	position: 0,
	canReadMessageHistory: true
};
export function toolsFixture(
	channels: readonly QueryChannel[] = [visible],
	rows: readonly StoredMessage[] = [message]
) {
	const access = new QueryAccessPolicy(
		{ execute: async () => ({ guildId: "1", status: "current" }) },
		{ execute: async ({ userId }) => ({ guildId: "1", channels: userId === "7" ? channels : [] }) }
	);
	const page = vi.fn(async (input: { accessibleChannelIds: readonly string[]; channelId: string }) =>
		rows.filter((row) => input.accessibleChannelIds.includes(row.channelId) && row.channelId === input.channelId)
	);
	const candidates = vi.fn(
		async (input: { accessibleChannelIds: readonly string[]; messageIds: readonly string[] }) =>
			rows.filter(
				(row) => input.accessibleChannelIds.includes(row.channelId) && input.messageIds.includes(row.messageId)
			)
	);
	const window = vi.fn(async (input: { accessibleChannelIds: readonly string[]; messageId: string }) =>
		rows.filter((row) => input.accessibleChannelIds.includes(row.channelId) && row.messageId === input.messageId)
	);
	const repository = { readPage: page, readCandidates: candidates, readWindow: window };
	const hybrid = new SearchCandidatesQuery(
		{
			execute: async (input) => ({
				candidates: rows
					.filter((row) => input.accessibleChannelIds.includes(row.channelId))
					.map((row, i) => ({
						messageId: row.messageId,
						channelId: row.channelId,
						parentChannelId: null,
						createdAt: row.createdAt,
						rank: 1 - i / 100
					})),
				retrieval: "hybrid"
			})
		},
		logger
	);
	return {
		tools: {
			list_channels: new ListChannelsQuery(
				access,
				// R12's bot-access axis: this fixture's bot views every channel the suite declares, so the
				// intersection is the visibility set these cases are about.
				{
					execute: async () => ({
						channels: channels.map((channel) => ({ channelId: channel.channelId })),
						botCannotViewChannelIds: [],
						botMembershipRegistered: true
					})
				},
				"99"
			),
			get_channel_history: new GetChannelHistoryQuery(access, repository),
			get_thread_messages: new GetThreadMessagesQuery(access, repository),
			get_message_context: new GetMessageContextQuery(access, repository),
			search_messages: new SearchMessagesQuery(access, hybrid, repository)
		},
		repository
	};
}

describe("five retrieval use cases", () => {
	it("list channel pagination ends in a numeric snowflake tie-breaker", async () => {
		const { tools } = toolsFixture([
			{ ...visible, channelId: "100" },
			{ ...visible, channelId: "20" }
		]);
		const input = { ...parseToolInput("list_channels", { pageSize: 1 }), userId: "7" };
		const first = await tools.list_channels.execute(input);
		expect(first.data.map((row) => row.channelId)).toEqual(["20"]);
		const cursor = first.pagination?.nextCursor;
		if (!cursor) throw new Error("missing cursor");
		const second = await tools.list_channels.execute({ ...input, cursor });
		expect(second.data.map((row) => row.channelId)).toEqual(["100"]);
		expect(second.pagination).toEqual({ pageSize: 1, hasNext: false, nextCursor: null });
	});
	it("list_channels is registry-only, visibility includes history-denied channels", async () => {
		const { tools, repository } = toolsFixture([{ ...visible, canReadMessageHistory: false }]);
		const input = { ...parseToolInput("list_channels", {}), userId: "7" };
		expect((await tools.list_channels.execute(input)).data).toEqual([
			{ channelId: "10", name: "general", kind: "channel", parentChannelId: null, position: 0 }
		]);
		expect((await tools.get_channel_history.execute({ ...input, channelId: "10" })).data).toEqual([]);
		expect(repository.readPage).not.toHaveBeenCalled();
	});
	it("history and search return complete provenance; channelId may be a thread", async () => {
		const thread = { ...visible, isThread: true, parentChannelId: "9" };
		const { tools } = toolsFixture([thread]);
		const input = { ...parseToolInput("get_channel_history", { channelId: "10" }), userId: "7" };
		const expected = { ...message, channelName: "general", parentChannelId: "9", truncated: false };
		expect((await tools.get_channel_history.execute(input)).data).toEqual([expected]);
		expect((await tools.search_messages.execute({ ...input, query: "hello" })).data).toEqual([expected]);
		expect(await tools.get_thread_messages.execute({ ...input, threadId: "10" })).toMatchObject({
			data: [expected],
			threadId: "10",
			parentChannelId: "9"
		});
	});
	it("context echoes only a visible anchor; no cursor", async () => {
		const { tools } = toolsFixture();
		expect(
			await tools.get_message_context.execute({ pageSize: 20, windowSize: 20, userId: "7", messageId: "100" })
		).toMatchObject({ anchorMessageId: "100" });
		expect(
			await tools.get_message_context.execute({ pageSize: 20, windowSize: 20, userId: "7", messageId: "999" })
		).toEqual({ data: [] });
	});
	it("identity-from-session: identical arguments yield each user's own accessible rows", async () => {
		const { tools } = toolsFixture();
		const input = parseToolInput("get_channel_history", { channelId: "10" });
		expect((await tools.get_channel_history.execute({ ...input, userId: "7" })).data).toHaveLength(1);
		expect((await tools.get_channel_history.execute({ ...input, userId: "8" })).data).toEqual([]);
	});
	it("acl-no-existence-signal: inaccessible vs fabricated IDs across all object tools", async () => {
		const { tools } = toolsFixture();
		const common = { pageSize: 20, windowSize: 20, userId: "8" };
		for (const [tool, field] of [
			[tools.get_channel_history, "channelId"],
			[tools.get_thread_messages, "threadId"],
			[tools.get_message_context, "messageId"]
		] as const) {
			expect(await tool.execute({ ...common, [field]: "10" })).toEqual(
				await tool.execute({ ...common, [field]: "999" })
			);
		}
		expect(await tools.search_messages.execute({ ...common, query: "hello", channelId: "10" })).toEqual(
			await tools.search_messages.execute({ ...common, query: "hello", channelId: "999" })
		);
	});
});
