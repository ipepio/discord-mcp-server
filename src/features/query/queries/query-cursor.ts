import { createHash } from "node:crypto";
import type { CursorKey, QueryToolName, ToolInput } from "../models/domain/tool-input.js";
import { QueryError } from "../models/domain/query.errors.js";

function binding(tool: QueryToolName, input: ToolInput): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				tool,
				input.query ?? null,
				input.channelId ?? null,
				input.threadId ?? null,
				input.authorId ?? null,
				input.from ?? null,
				input.to ?? null,
				// R14/O8: a digest cursor stays bound to its tool, its group's `channelId` (above) and the window
				// selection the client restated. The extra fields are added only for the digest, so every other
				// tool's binding — and every cursor already in a client's hands — is unchanged.
				...(tool === "get_recent_activity" ? [input.since ?? null, input.sinceByMyLastMessage === true] : [])
			])
		)
		.digest("hex");
}
/**
 * R13/O5: the two traversal tools and R14's per-group digest cursor page backward, and this token says so
 * inside the self-describing envelope. A cursor minted before the direction flip carries no token, so it
 * fails validation as `invalid_input` instead of silently continuing into the opposite half of the channel.
 * The token is a server-side constant — never client input — so it cannot widen access, and the filter
 * binding above is unchanged.
 */
function backwardDirection(tool: QueryToolName): "backward" | undefined {
	return tool === "get_channel_history" || tool === "get_thread_messages" || tool === "get_recent_activity"
		? "backward"
		: undefined;
}
export function encodeCursor(tool: QueryToolName, input: ToolInput, key: CursorKey): string {
	const direction = backwardDirection(tool);
	const payload = JSON.stringify({
		version: 1,
		tool,
		binding: binding(tool, input),
		key,
		...(direction ? { direction } : {})
	});
	return Buffer.from(payload).toString("base64url");
}
export function decodeCursor(tool: QueryToolName, input: ToolInput): CursorKey | undefined {
	if (!input.cursor) return undefined;
	try {
		if (input.cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error();
		const parsed: unknown = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
		const direction = backwardDirection(tool);
		if (
			!record(parsed) ||
			Object.keys(parsed).sort().join() !==
				(direction ? "binding,direction,key,tool,version" : "binding,key,tool,version") ||
			parsed["version"] !== 1 ||
			parsed["tool"] !== tool ||
			parsed["binding"] !== binding(tool, input) ||
			(direction !== undefined && parsed["direction"] !== direction)
		)
			throw new Error();
		const key = parsed["key"];
		if (!record(key)) throw new Error();
		const snowflake = (value: unknown): value is string =>
			typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
		if (tool === "list_channels") {
			if (
				Object.keys(key).sort().join() !== "channelId,position" ||
				!snowflake(key["channelId"]) ||
				typeof key["position"] !== "number" ||
				!Number.isSafeInteger(key["position"])
			)
				throw new Error();
			return { channelId: key["channelId"], position: key["position"] };
		}
		if (tool === "search_messages") {
			if (
				Object.keys(key).sort().join() !== "messageId,rank" ||
				!snowflake(key["messageId"]) ||
				typeof key["rank"] !== "number" ||
				!Number.isFinite(key["rank"])
			)
				throw new Error();
			return { messageId: key["messageId"], rank: key["rank"] };
		}
		if (
			Object.keys(key).sort().join() !== "createdAt,messageId" ||
			!snowflake(key["messageId"]) ||
			typeof key["createdAt"] !== "string" ||
			!Number.isFinite(Date.parse(key["createdAt"]))
		)
			throw new Error();
		return { messageId: key["messageId"], createdAt: key["createdAt"] };
	} catch {
		throw new QueryError("invalid_input", "Invalid field: cursor");
	}
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
