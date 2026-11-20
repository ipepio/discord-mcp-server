import type { ToolInput } from "../models/domain/tool-input.js";
import type { ToolResult } from "../models/domain/tool-result.js";
import type { MessageReadRepository } from "../repositories/message-read.repository.js";
import type { QueryAccessPolicy } from "./query-access.policy.js";
import { decodeCursor, encodeCursor } from "./query-cursor.js";
import { messageResults, readMessages } from "./message-results.js";
import { QueryError } from "../models/domain/query.errors.js";

import { QueryPayloadPolicy, messageCursorKey } from "./query-payload.policy.js";

export class GetThreadMessagesQuery {
	public constructor(
		private readonly access: QueryAccessPolicy,
		private readonly messages: MessageReadRepository,
		private readonly payload = new QueryPayloadPolicy()
	) {}
	public async execute(input: ToolInput & { readonly userId: string }): Promise<ToolResult> {
		if (!input.threadId) throw new QueryError("invalid_input", "Invalid field: threadId");
		const before = decodeCursor("get_thread_messages", input);
		const access = await this.access.resolve(input.userId, "content");
		const thread = access.channels.find(
			(channel) => channel.channelId === input.threadId && channel.isThread && channel.parentChannelId
		);
		const rows = thread
			? await readMessages(() =>
					this.messages.readPage({
						guildId: access.guildId,
						accessibleChannelIds: access.accessibleChannelIds,
						channelId: thread.channelId,
						pageSize: input.pageSize,
						...(before?.createdAt && before.messageId
							? { before: { createdAt: before.createdAt, messageId: before.messageId } }
							: {})
					})
				)
			: [];
		const data = messageResults(rows.slice(0, input.pageSize), access);
		const last = data.at(-1);
		const hasNext = rows.length > data.length;
		return this.payload.bound(
			"get_thread_messages",
			input,
			{
				data,
				pagination: {
					pageSize: input.pageSize,
					hasNext,
					nextCursor:
						hasNext && last
							? encodeCursor("get_thread_messages", input, {
									createdAt: last.createdAt,
									messageId: last.messageId
								})
							: null
				},
				...(data.length && thread?.parentChannelId
					? { threadId: thread.channelId, parentChannelId: thread.parentChannelId }
					: {})
			},
			messageCursorKey
		);
	}
}
