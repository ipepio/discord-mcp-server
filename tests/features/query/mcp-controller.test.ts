import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { McpController } from "../../../src/features/query/controllers/mcp.controller.js";
import { QueryToolsAdapter } from "../../../src/features/query/mcp/query-tools.adapter.js";
import { QUERY_TOOLS_ADAPTER_TOKEN } from "../../../src/features/query/query.tokens.js";
import {
	AuthenticateSessionQuery,
	AUTHORIZATION_PUBLIC_BASE_URL_TOKEN
} from "../../../src/features/authorization/index.js";
import { APP_LOGGER_TOKEN } from "../../../src/shared/logging/logging.tokens.js";

describe("authenticated MCP HTTP endpoint", () => {
	let app: INestApplication;
	let url: string;
	const execute = vi.fn(async () => ({ data: [] }));
	beforeAll(async () => {
		const adapter = new QueryToolsAdapter(
			{
				search_messages: { execute },
				list_channels: { execute },
				get_channel_history: { execute },
				get_thread_messages: { execute },
				get_message_context: { execute },
				get_recent_activity: { execute },
				get_hub_status: { execute }
			},
			{
				execute: async () => ({
					serverInfo: { name: "Guild test", version: "1", description: "Guild test" },
					instructions: "Guild test",
					capabilities: { tools: { listChanged: false } }
				})
			}
		);
		const module = await Test.createTestingModule({
			controllers: [McpController],
			providers: [
				{ provide: QUERY_TOOLS_ADAPTER_TOKEN, useValue: adapter },
				{
					provide: AuthenticateSessionQuery,
					useValue: {
						execute: async (token: string) =>
							token === "a".repeat(43)
								? {
										authenticated: true,
										principal: {
											userId: "7",
											sessionId: "resolved",
											expiresAt: new Date("2099-01-01")
										}
									}
								: { authenticated: false, retryable: false }
					}
				},
				{ provide: AUTHORIZATION_PUBLIC_BASE_URL_TOKEN, useValue: "https://hub.example" },
				{ provide: APP_LOGGER_TOKEN, useValue: {} }
			]
		}).compile();
		app = module.createNestApplication({ logger: false });
		await app.listen(0, "127.0.0.1");
		url = await app.getUrl();
	});
	afterAll(async () => {
		await app?.close();
	});
	async function post(body: unknown, authenticated = true) {
		return fetch(`${url}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(authenticated ? { authorization: `Bearer ${"a".repeat(43)}` } : {})
			},
			body: JSON.stringify(body)
		});
	}
	it.each(["initialize", "tools/list", "tools/call", "notifications/initialized"])(
		"guards %s without a token",
		async (method) => {
			const response = await post({ jsonrpc: "2.0", id: 1, method }, false);
			expect(response.status).toBe(401);
			expect(response.headers.get("www-authenticate")).toContain("oauth-protected-resource");
		}
	);
	it("initializes, lists tools, dispatches calls and preserves protocol errors", async () => {
		const initialize = await post({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18" }
		});
		expect(initialize.status).toBe(200);
		expect(await initialize.json()).toMatchObject({ result: { serverInfo: { name: "Guild test" } } });
		const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
		expect(await list.json()).toMatchObject({
			result: { tools: expect.arrayContaining([expect.objectContaining({ name: "list_channels" })]) }
		});
		const call = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_channels" } });
		expect(call.status).toBe(200);
		expect(await call.json()).toMatchObject({ result: { isError: false } });
		expect(execute).toHaveBeenCalledWith(expect.objectContaining({ userId: "7" }));
		const unknown = await post({ jsonrpc: "2.0", id: 4, method: "unknown" });
		expect(await unknown.json()).toMatchObject({ error: { code: -32601 } });
	});
	it("returns 202 with an empty body for initialized", async () => {
		const response = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
		expect(response.status).toBe(202);
		expect(await response.text()).toBe("");
	});
	it("never uses body identity", async () => {
		execute.mockClear();
		const response = await post({
			jsonrpc: "2.0",
			id: 5,
			method: "tools/call",
			params: { name: "list_channels", arguments: { userId: "999" } }
		});
		expect(response.status).toBe(400);
		expect(execute).not.toHaveBeenCalled();
	});
});
