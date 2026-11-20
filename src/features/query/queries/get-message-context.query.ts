import type { ToolInput } from "../models/domain/tool-input.js";
import type { ToolResult } from "../models/domain/tool-result.js";
import type { MessageReadRepository } from "../repositories/message-read.repository.js";
import type { QueryAccessPolicy } from "./query-access.policy.js";
import { messageResults, readMessages } from "./message-results.js";
import { QueryError } from "../models/domain/query.errors.js";

import { QueryPayloadPolicy, messageCursorKey } from "./query-payload.policy.js";

export class GetMessageContextQuery {
	public constructor(
		private readonly access: QueryAccessPolicy,
		private readonly messages: MessageReadRepository,
		private readonly payload = new QueryPayloadPolicy()
	) {}
	public async execute(input: ToolInput & { readonly userId: string }): Promise<ToolResult> {
		if (!input.messageId) throw new QueryError("invalid_input", "Invalid field: messageId");
		const access = await this.access.resolve(input.userId, "content");
		const rows = await readMessages(() =>
			this.messages.readWindow({
				guildId: access.guildId,
				accessibleChannelIds: access.accessibleChannelIds,
				messageId: input.messageId ?? "",
				windowSize: input.windowSize
			})
		);
		if (!rows.some((row) => row.messageId === input.messageId)) return { data: [] };
		return this.payload.bound(
			"get_message_context",
			input,
			{ data: messageResults(rows, access), anchorMessageId: input.messageId },
			messageCursorKey
		);
	}
}
