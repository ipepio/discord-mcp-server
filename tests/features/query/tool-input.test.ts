import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseToolInput, QUERY_TOOL_SCHEMAS } from "../../../src/features/query/models/dtos/tool-schema.dto.js";
import { decodeCursor, encodeCursor } from "../../../src/features/query/queries/query-cursor.js";

describe("closed query tool schemas", () => {
	it.each(["discord_user_id", "userId", "asUser", "token", "permissions"])(
		"impersonation-argument-rejected: %s",
		(field) => {
			for (const tool of QUERY_TOOL_SCHEMAS)
				expect(() => parseToolInput(tool.name, { [field]: "7" })).toThrow(`Unsupported field: ${field}`);
		}
	);
	it("all seven schemas are closed and defaults are shared with discovery", () => {
		expect(QUERY_TOOL_SCHEMAS).toHaveLength(7);
		for (const tool of QUERY_TOOL_SCHEMAS) expect(tool.inputSchema.additionalProperties).toBe(false);
		expect(parseToolInput("list_channels", {})).toEqual({ pageSize: 20, windowSize: 20 });
	});
	// R15 (docs/features/query.md "Required tool descriptions"): the published text is contract, not prose.
	it.each([
		[
			"search_messages",
			"Find messages by topic across the channels this person can read and the hub actually mirrors. " +
				"Best match first. Use it to locate a discussion, then get_message_context to read around a hit. " +
				"Read only."
		],
		[
			"list_channels",
			"List the channels and threads this person can read AND the hub actually mirrors. Only channels " +
				"from this list can return messages; a channel that is missing is missing for a reason this tool " +
				"will not reveal. A short list is this hub's mirror scope, not a pagination defect — get_hub_status " +
				"reports how many entries that is. Read only."
		],
		[
			"get_channel_history",
			"Read one channel or thread newest first, paging back in time with the cursor. Pass from/to for an " +
				"explicit range. Read only."
		],
		["get_thread_messages", "Read one thread newest first, paging back in time with the cursor. Read only."],
		["get_message_context", "Read a bounded window of messages around one message, oldest to newest. Read only."],
		[
			"get_recent_activity",
			"Get what is new in one call: recent messages grouped by channel, with per-channel counts and cursors. " +
				"Defaults to the last 24 hours, or starts after this person's own last message. " +
				"If the person named neither a channel/category nor a time window, ask them before calling. Read only."
		],
		[
			"get_hub_status",
			"Report this hub's status in one call: the Guild it serves, whether its registry state is current, " +
				"and how many channels and threads the hub mirrors for this person. A short list_channels page is " +
				"the mirror scope, not a pagination defect. Read only."
		]
	])("publishes R15's required description for %s verbatim", (name, required) => {
		const tool = QUERY_TOOL_SCHEMAS.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`missing ${name} schema`);
		expect(tool.description).toBe(required);
	});
	it("get_hub_status takes the empty closed object and nothing else", () => {
		const hubStatus = QUERY_TOOL_SCHEMAS.find((tool) => tool.name === "get_hub_status");
		if (!hubStatus) throw new Error("missing get_hub_status schema");
		// R17: an empty closed object — no identity, no filter, no page — and a status object as the answer,
		// with no `data` array and no pagination (the fourth documented envelope).
		expect(hubStatus.inputSchema).toEqual({
			type: "object",
			additionalProperties: false,
			required: [],
			properties: {}
		});
		expect(hubStatus.outputSchema.anyOf[0]?.required).toEqual(["guild", "registry", "mirror"]);
		expect(hubStatus.outputSchema.required).toBeUndefined();
		expect(Object.keys(hubStatus.outputSchema.properties).sort()).toEqual([
			"data",
			"error",
			"guild",
			"mirror",
			"registry"
		]);
		for (const field of ["channelId", "query", "pageSize", "cursor", "userId"])
			expect(() => parseToolInput("get_hub_status", { [field]: "7" })).toThrow(`Unsupported field: ${field}`);
	});
	it("the digest offers one window per call", () => {
		const activity = QUERY_TOOL_SCHEMAS.find((tool) => tool.name === "get_recent_activity");
		if (!activity) throw new Error("missing digest schema");
		expect(activity.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false
		});
		expect(parseToolInput("get_recent_activity", { sinceByMyLastMessage: true })).toMatchObject({
			sinceByMyLastMessage: true,
			pageSize: 20
		});
		expect(() =>
			parseToolInput("get_recent_activity", { since: "2026-01-01T00:00:00Z", sinceByMyLastMessage: true })
		).toThrow("since");
		expect(() => parseToolInput("get_recent_activity", { sinceByMyLastMessage: "true" })).toThrow(
			"sinceByMyLastMessage"
		);
	});
	it.each([
		{ channelId: "0" },
		{ channelId: "9223372036854775808" },
		{ channelId: "1", pageSize: 101 },
		{ channelId: "1", pageSize: 1.1 },
		{ channelId: "1", from: "yesterday" },
		{ channelId: "1", from: "2026-02-01T00:00:00Z", to: "2026-01-01T00:00:00Z" }
	])("rejects malformed arguments %j", (input) => {
		expect(() => parseToolInput("get_channel_history", input)).toThrow();
	});
	it("empty or omitted query is invalid", () => {
		for (const input of [{}, { query: "" }]) expect(() => parseToolInput("search_messages", input)).toThrow();
	});
	it("pagination-cursor-binding", () => {
		const input = parseToolInput("get_channel_history", { channelId: "10" });
		const cursor = encodeCursor("get_channel_history", input, {
			createdAt: "2026-01-01T00:00:00Z",
			messageId: "100"
		});
		expect(decodeCursor("get_channel_history", { ...input, cursor })).toEqual({
			createdAt: "2026-01-01T00:00:00Z",
			messageId: "100"
		});
		expect(() => decodeCursor("get_thread_messages", { ...input, cursor })).toThrow("cursor");
		expect(() => decodeCursor("get_channel_history", { ...input, channelId: "11", cursor })).toThrow("cursor");
		for (const bad of ["?", cursor + "!", Buffer.from("{}").toString("base64url")])
			expect(() => decodeCursor("get_channel_history", { ...input, cursor: bad })).toThrow("cursor");
	});
	it("pre-flip cursor envelopes stay valid for the tools R13 leaves alone", () => {
		/** The ascending contract's envelope: `{ version, tool, binding, key }`, binding = tool + filter set. */
		function legacy(tool: string, filter: readonly (string | null)[], key: Record<string, unknown>): string {
			const binding = createHash("sha256")
				.update(JSON.stringify([tool, ...filter]))
				.digest("hex");
			return Buffer.from(JSON.stringify({ version: 1, tool, binding, key })).toString("base64url");
		}
		const input = { pageSize: 20, windowSize: 20 };
		// list_channels and search_messages keep the old envelope shape: their cursors are unchanged by R13.
		expect(
			decodeCursor("list_channels", {
				...input,
				cursor: legacy("list_channels", [null, null, null, null, null, null], {
					channelId: "10",
					position: 2
				})
			})
		).toEqual({ channelId: "10", position: 2 });
		expect(
			decodeCursor("search_messages", {
				...input,
				query: "deploy",
				cursor: legacy("search_messages", ["deploy", null, null, null, null, null], {
					messageId: "100",
					rank: 0.5
				})
			})
		).toEqual({ messageId: "100", rank: 0.5 });
		// The encoder still emits that exact shape for them, so no client-visible change leaked out of the flip.
		const emitted: unknown = JSON.parse(
			Buffer.from(
				encodeCursor("list_channels", { ...input }, { channelId: "10", position: 2 }),
				"base64url"
			).toString("utf8")
		);
		expect(Object.keys(emitted as object).sort()).toEqual(["binding", "key", "tool", "version"]);
		// The two traversal tools now carry the direction token O5 resolves; a pre-flip envelope lacks it.
		expect(() =>
			decodeCursor("get_channel_history", {
				...input,
				channelId: "10",
				cursor: legacy("get_channel_history", [null, "10", null, null, null, null], {
					createdAt: "2026-01-01T00:00:00Z",
					messageId: "100"
				})
			})
		).toThrow("cursor");
	});
});
