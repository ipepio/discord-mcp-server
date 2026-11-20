import type { CursorKey, QueryToolName, ToolInput } from "../models/domain/tool-input.js";
import type { ActivityGroup, ActivityWindow, MessageResult, ToolResult } from "../models/domain/tool-result.js";
import type { MessageKey } from "../models/domain/message.js";
import { QueryError } from "../models/domain/query.errors.js";
import { encodeCursor } from "./query-cursor.js";

/**
 * The highest snowflake value, used only as a *position* in the digest's total order: an emptied group's
 * cursor must resume at that group's newest message, and `(instant, MAX)` is strictly greater than every row
 * at or before the same instant, so no message is skipped or repeated when the continuation runs (R4, R14).
 */
const POSITION_AFTER_ROW = "9223372036854775807";

/** One container of the digest before the byte cap trims it: the published facts plus the key it resumes from. */
export interface DigestGroupDraft {
	readonly channelId: string;
	readonly channelName: string;
	readonly parentChannelId: string | null;
	readonly messageCount: number;
	readonly messages: readonly MessageResult[];
	/** Position of the group's newest message inside the window; `messages[0]` unless it was trimmed away. */
	readonly newest: MessageKey;
}

export interface QueryPayloadLimits {
	readonly maxMessageChars: number;
	readonly maxResponseBytes: number;
}
export class QueryPayloadPolicy {
	public constructor(
		private readonly limits: QueryPayloadLimits = { maxMessageChars: 4000, maxResponseBytes: 262144 }
	) {}
	public bound(
		tool: QueryToolName,
		input: ToolInput,
		result: ToolResult,
		key: (row: ToolResult["data"][number]) => CursorKey
	): ToolResult {
		let bounded: ToolResult = {
			...result,
			data: result.data.map((row) => {
				if (!("content" in row)) return row;
				const content = Array.from(row.content).slice(0, this.limits.maxMessageChars).join("");
				return { ...row, content, truncated: content !== row.content };
			})
		};
		// Reserve protocol framing and fixed text content; the adapter publishes data only in structuredContent.
		while (Buffer.byteLength(JSON.stringify(bounded), "utf8") + 1024 > this.limits.maxResponseBytes) {
			if (bounded.data.length <= 1) {
				const only = bounded.data[0];
				if (only && "content" in only && only.content.length > 0) {
					const characters = Array.from(only.content);
					bounded = {
						...bounded,
						data: [
							{
								...only,
								content: characters.slice(0, Math.floor(characters.length / 2)).join(""),
								truncated: true
							}
						]
					};
					continue;
				}
				throw new QueryError("internal_error", "Could not build bounded response");
			}
			if (tool === "get_message_context") {
				const data = [...bounded.data];
				const anchorIndex = data.findIndex(
					(row) => "messageId" in row && row.messageId === bounded.anchorMessageId
				);
				if (anchorIndex > (data.length - 1) / 2) data.shift();
				else data.pop();
				bounded = { ...bounded, data, windowTruncated: true };
			} else {
				const data = bounded.data.slice(0, -1);
				const last = data.at(-1);
				if (!last) throw new QueryError("internal_error", "Could not build bounded response");
				bounded = {
					...bounded,
					data,
					pagination: {
						pageSize: input.pageSize,
						hasNext: true,
						nextCursor: encodeCursor(tool, input, key(last))
					}
				};
			}
		}
		return bounded;
	}
	/**
	 * R14's grouping under R10's byte cap. The envelope is `{ data: activityGroup[], window }` with a cursor per
	 * group, so the shortening rule is the digest's own: whole messages are dropped from the least recently
	 * active group's oldest end, and a group trimmed to nothing stays present with its `messageCount`,
	 * `hasNext: true` and a usable `nextCursor` — never silently dropped, so the agent still learns there is
	 * activity and can ask for it. Nothing that fits is trimmed, and an envelope that cannot fit even after every
	 * message is gone is `internal_error` rather than a silently truncated answer.
	 */
	public boundDigest(input: ToolInput, window: ActivityWindow, drafts: readonly DigestGroupDraft[]): ToolResult {
		let groups = drafts.map((draft) => this.digestGroup(input, draft, draft.messages));
		const assemble = (): ToolResult => ({ data: groups, window });
		while (Buffer.byteLength(JSON.stringify(assemble()), "utf8") + 1024 > this.limits.maxResponseBytes) {
			const index = groups.findLastIndex((group) => group.messages.length > 0);
			const draft = drafts[index];
			const group = groups[index];
			if (index < 0 || !draft || !group)
				throw new QueryError("internal_error", "Could not build bounded response");
			const kept = group.messages.slice(0, -1);
			const next = [...groups];
			next[index] = this.digestGroup(input, draft, kept);
			groups = next;
		}
		return assemble();
	}
	/**
	 * One group with the facts the envelope promises: `hasNext` is exactly `messageCount > returnedCount`, so a
	 * trimmed or paged group reports that more is reachable, and `nextCursor` is present exactly then.
	 */
	private digestGroup(input: ToolInput, draft: DigestGroupDraft, messages: readonly MessageResult[]): ActivityGroup {
		const bounded = messages.map((message) => {
			const content = Array.from(message.content).slice(0, this.limits.maxMessageChars).join("");
			return { ...message, content, truncated: content !== message.content };
		});
		const returnedCount = bounded.length;
		const hasNext = draft.messageCount > returnedCount;
		const last = bounded.at(-1);
		// O8: the cursor stays bound to this tool, this group's `channelId` and the window the client restated.
		const groupInput: ToolInput = { ...input, channelId: draft.channelId };
		return {
			channelId: draft.channelId,
			channelName: draft.channelName,
			parentChannelId: draft.parentChannelId,
			messageCount: draft.messageCount,
			returnedCount,
			messages: bounded,
			pagination: {
				pageSize: input.pageSize,
				hasNext,
				nextCursor: hasNext
					? encodeCursor(
							"get_recent_activity",
							groupInput,
							last
								? { createdAt: last.createdAt, messageId: last.messageId }
								: { createdAt: draft.newest.createdAt, messageId: POSITION_AFTER_ROW }
						)
					: null
			}
		};
	}
}
export function messageCursorKey(row: ToolResult["data"][number]): CursorKey {
	if (!("messageId" in row)) throw new QueryError("internal_error", "Invalid message page");
	const message: MessageResult = row;
	return { createdAt: message.createdAt, messageId: message.messageId };
}
