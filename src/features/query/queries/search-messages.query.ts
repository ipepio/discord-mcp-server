import type { ToolInput } from "../models/domain/tool-input.js";
import type { ToolResult } from "../models/domain/tool-result.js";
import type { MessageReadRepository } from "../repositories/message-read.repository.js";
import type { QueryAccessPolicy } from "./query-access.policy.js";
import type { SearchCandidatesQuery } from "./search-candidates.query.js";
import { decodeCursor, encodeCursor } from "./query-cursor.js";
import { messageResults, readMessages } from "./message-results.js";

import { QueryPayloadPolicy } from "./query-payload.policy.js";
import { QueryError } from "../models/domain/query.errors.js";

export class SearchMessagesQuery {
	public constructor(
		private readonly access: QueryAccessPolicy,
		private readonly search: SearchCandidatesQuery,
		private readonly messages: MessageReadRepository,
		private readonly payload = new QueryPayloadPolicy()
	) {}
	public async execute(input: ToolInput & { readonly userId: string }): Promise<ToolResult> {
		const after = decodeCursor("search_messages", input);
		const access = await this.access.resolve(input.userId, "content");
		const found = await this.search.execute(input, access, after);
		const rows = await readMessages(() =>
			this.messages.readCandidates({
				guildId: access.guildId,
				accessibleChannelIds: access.accessibleChannelIds,
				messageIds: found.candidates.map((row) => row.messageId),
				pageSize: input.pageSize
			})
		);
		const byId = new Map(rows.map((row) => [row.messageId, row]));
		const ordered = found.candidates.flatMap((candidate) => {
			const row = byId.get(candidate.messageId);
			return row &&
				(!input.channelId || row.channelId === input.channelId) &&
				(!input.authorId || row.authorId === input.authorId) &&
				(!input.from || Date.parse(row.createdAt) >= Date.parse(input.from)) &&
				(!input.to || Date.parse(row.createdAt) <= Date.parse(input.to))
				? [row]
				: [];
		});
		const data = messageResults(ordered.slice(0, input.pageSize), access);
		const last = data.at(-1);
		const hasNext = ordered.length > data.length;
		const rank = found.candidates.find((row) => row.messageId === last?.messageId)?.rank;
		return this.payload.bound(
			"search_messages",
			input,
			{
				data,
				retrieval: found.retrieval,
				pagination: {
					pageSize: input.pageSize,
					hasNext,
					nextCursor:
						hasNext && last && rank !== undefined
							? encodeCursor("search_messages", input, { rank, messageId: last.messageId })
							: null
				}
			},
			(row) => {
				if (!("messageId" in row)) throw new QueryError("internal_error", "Invalid search page");
				const rank = found.candidates.find((candidate) => candidate.messageId === row.messageId)?.rank;
				if (rank === undefined) throw new QueryError("internal_error", "Invalid search key");
				return { rank, messageId: row.messageId };
			}
		);
	}
}
