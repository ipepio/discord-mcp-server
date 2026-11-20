import { describe, expect, it, vi } from "vitest";
import { QueryToolsAdapter, QueryAuthenticationError } from "../../../src/features/query/mcp/query-tools.adapter.js";
import { QUERY_TOOL_SCHEMAS } from "../../../src/features/query/models/dtos/tool-schema.dto.js";
import { QueryError } from "../../../src/features/query/models/domain/query.errors.js";
import { QUERY_TOOL_NAMES } from "../../../src/features/query/models/domain/tool-input.js";
import { GetServerMetadataQuery } from "../../../src/features/query/queries/get-server-metadata.query.js";
import type { AppLogger } from "../../../src/shared/logging/logger.interface.js";
const identity = { userId: "7", sessionId: "resolved-session", expiresAt: new Date("2099-01-01") };
const logger: AppLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => logger };
function fixture() {
	const execute = vi.fn(async () => ({ data: [], pagination: { pageSize: 20, hasNext: false, nextCursor: null } }));
	const adapter = new QueryToolsAdapter(
		{
			list_channels: { execute },
			search_messages: { execute },
			get_channel_history: { execute },
			get_thread_messages: { execute },
			get_message_context: { execute },
			get_recent_activity: { execute },
			get_hub_status: { execute }
		},
		{
			execute: async () => ({
				serverInfo: { name: "Guild fixture", version: "1", description: "Guild fixture" },
				instructions: "Guild fixture",
				capabilities: { tools: { listChanged: false } }
			})
		}
	);
	return { adapter, execute };
}
describe("MCP tool adapter", () => {
	it.each(["2024-11-05", "2025-03-26", "2025-06-18", "unknown"])(
		"initialize negotiates %s and identifies the Guild",
		async (protocolVersion) => {
			const { adapter } = fixture();
			expect(
				await adapter.handle(
					{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion } },
					identity
				)
			).toMatchObject({
				result: {
					protocolVersion: protocolVersion === "unknown" ? "2025-06-18" : protocolVersion,
					serverInfo: { name: "Guild fixture" },
					instructions: "Guild fixture",
					capabilities: { tools: { listChanged: false } }
				}
			});
		}
	);
	it("initialized notification is silent; malformed initialize and unknown methods are errors", async () => {
		const { adapter } = fixture();
		expect(await adapter.handle({ jsonrpc: "2.0", method: "notifications/initialized" }, identity)).toBeUndefined();
		expect(await adapter.handle({ jsonrpc: "2.0", id: 1, method: "initialize" }, identity)).toMatchObject({
			error: { code: -32602 }
		});
		expect(await adapter.handle({ jsonrpc: "2.0", id: 1, method: "unknown" }, identity)).toMatchObject({
			error: { code: -32601 }
		});
	});
	it("body userId cannot change the evaluated identity, even after an attempted override", async () => {
		const { adapter, execute } = fixture();
		await adapter.handle(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "list_channels", arguments: { userId: "999" } }
			},
			identity
		);
		expect(execute).not.toHaveBeenCalled();
		await adapter.handle(
			{ jsonrpc: "2.0", id: 2, userId: "999", method: "tools/call", params: { name: "list_channels" } },
			identity
		);
		expect(execute).toHaveBeenCalledWith(expect.objectContaining({ userId: "7" }));
	});
	it("tools/list emits exactly the schemas used by validation and no extra tool", async () => {
		const { adapter, execute } = fixture();
		expect(await adapter.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, identity)).toEqual({
			jsonrpc: "2.0",
			id: 1,
			result: { tools: QUERY_TOOL_SCHEMAS }
		});
		expect(execute).not.toHaveBeenCalled();
	});
	it.each(["discord_user_id", "userId", "asUser", "token", "constructor", "toString", "__proto__"])(
		"impersonation-argument-rejected: %s before every read",
		async (field) => {
			const { adapter, execute } = fixture();
			for (const name of QUERY_TOOL_NAMES) {
				const response = await adapter.handle(
					{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { [field]: "999" } } },
					identity
				);
				expect(response).toMatchObject({
					result: {
						isError: true,
						structuredContent: {
							data: [],
							error: { code: "invalid_input", message: `Unsupported field: ${field}` }
						}
					}
				});
			}
			expect(execute).not.toHaveBeenCalled();
		}
	);
	it("resolved principal is passed per invocation; identity is never taken from envelope", async () => {
		const { adapter, execute } = fixture();
		for (const userId of ["7", "8"])
			await adapter.handle(
				{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_channels", arguments: {} } },
				{ ...identity, userId }
			);
		expect(execute).toHaveBeenNthCalledWith(1, { userId: "7", pageSize: 20, windowSize: 20 });
		expect(execute).toHaveBeenNthCalledWith(2, { userId: "8", pageSize: 20, windowSize: 20 });
		await expect(adapter.handle({}, { ...identity, userId: "" })).rejects.toBeInstanceOf(QueryAuthenticationError);
	});
	it("protocol errors are separate from stable tool errors", async () => {
		const { adapter, execute } = fixture();
		expect(
			await adapter.handle(
				{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_message" } },
				identity
			)
		).toMatchObject({ error: { code: -32602 } });
		execute.mockRejectedValueOnce(new QueryError("state_unavailable", "Registry stale; retry later"));
		expect(
			await adapter.handle(
				{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_channels" } },
				identity
			)
		).toMatchObject({
			result: {
				isError: true,
				structuredContent: { data: [], error: { code: "state_unavailable", retryable: true } }
			}
		});
	});
});
describe("metadata-identifies-guild", () => {
	it("names each guild and reflects a rename at the next connection", async () => {
		let guildName = "Guild A";
		const query = new GetServerMetadataQuery(
			{ execute: async () => ({ status: "current", guildId: "1" }) },
			{ execute: async () => ({ status: "registered", guild: { guildId: "1", guildName } }) },
			logger
		);
		expect((await query.execute()).serverInfo.name).toContain("Guild A");
		guildName = "Guild B";
		expect((await query.execute()).instructions).toContain("Guild B");
	});
	it.each(["incomplete", "unavailable"] as const)(
		"%s connection succeeds with unidentified wording",
		async (status) => {
			const identityQuery = { execute: vi.fn() };
			const query = new GetServerMetadataQuery(
				{ execute: async () => ({ status, guildId: "1" }) },
				identityQuery,
				logger
			);
			expect((await query.execute()).serverInfo.name).toContain("Guild not yet identified");
			expect(identityQuery.execute).not.toHaveBeenCalled();
		}
	);
	it("identity read failure falls back without leaking failure details", async () => {
		const query = new GetServerMetadataQuery(
			{ execute: async () => ({ status: "current", guildId: "1" }) },
			{
				execute: async () => {
					throw new Error("secret SQL");
				}
			},
			logger
		);
		expect((await query.execute()).instructions).toContain("Guild not yet identified");
		expect(logger.error).toHaveBeenCalledWith("query guild identity unavailable", { guildId: "1" });
	});
});
