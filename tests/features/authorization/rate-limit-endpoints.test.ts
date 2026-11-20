import "reflect-metadata";
import { Controller, Module, Post, Res } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthorizationModule } from "../../../src/features/authorization/index.js";
import { AUTHORIZATION_STORE_TOKEN } from "../../../src/features/authorization/authorization.tokens.js";
import { DISCORD_CONFIG_TOKEN, DISCORD_EVENT_STREAM_TOKEN } from "../../../src/features/discord/index.js";
import {
	GUILD_STATE_GUILD_IDENTITY_QUERY_TOKEN,
	GUILD_STATE_MEMBERSHIP_STATUS_QUERY_TOKEN,
	GUILD_STATE_STATUS_QUERY_TOKEN
} from "../../../src/features/guild-state/index.js";
import { AUTHORIZATION_RATE_LIMIT_DEFAULTS } from "../../../src/shared/config/authorization-config.js";
import { APP_CONFIG_TOKEN } from "../../../src/shared/config/config.tokens.js";
import { APP_LOGGER_TOKEN } from "../../../src/shared/logging/logging.tokens.js";
import { StructuredLogger } from "../../../src/shared/logging/structured-logger.js";
import { PG_POOL_TOKEN } from "../../../src/shared/persistence/persistence.tokens.js";
import { authorizationStoreFixture } from "./authorization-store.fixture.js";

/** Sibling feature contracts the authorization module consumes; no connection or query is started. */
@Module({
	providers: [
		{ provide: DISCORD_CONFIG_TOKEN, useValue: { botToken: "fixture", guildId: "1", intents: [] } },
		{
			provide: DISCORD_EVENT_STREAM_TOKEN,
			useValue: { subscribe: () => ({ unsubscribe: () => undefined }) }
		},
		{ provide: GUILD_STATE_STATUS_QUERY_TOKEN, useValue: { execute: async () => ({ status: "current" }) } },
		{
			provide: GUILD_STATE_GUILD_IDENTITY_QUERY_TOKEN,
			useValue: { execute: async () => ({ status: "not-registered", guildId: "1" }) }
		},
		{
			provide: GUILD_STATE_MEMBERSHIP_STATUS_QUERY_TOKEN,
			useValue: { execute: async () => ({ status: "present" }) }
		}
	],
	exports: [
		DISCORD_CONFIG_TOKEN,
		DISCORD_EVENT_STREAM_TOKEN,
		GUILD_STATE_STATUS_QUERY_TOKEN,
		GUILD_STATE_GUILD_IDENTITY_QUERY_TOKEN,
		GUILD_STATE_MEMBERSHIP_STATUS_QUERY_TOKEN
	]
})
class AuthorizationStubsModule {}

interface ProbeResponse {
	readonly status: (code: number) => ProbeResponse;
	readonly json: (body: unknown) => void;
}

/** Stands in for the query feature's `/mcp` controller: the middleware is registered by path. */
@Controller()
class McpProbeController {
	@Post("mcp")
	public mcp(@Res() response: ProbeResponse): void {
		response.status(204).json({});
	}
}

const pool = {
	query: async <Row>() => ({ rows: [] as Row[] }),
	connect: async () => ({ query: async <Row>() => ({ rows: [] as Row[] }), release: () => undefined }),
	end: async () => undefined
};

describe("O3 endpoint throttling — Nest HTTP surface", () => {
	let app: INestApplication;
	let url: string;
	const lines: string[] = [];
	const store = authorizationStoreFixture();

	beforeAll(async () => {
		const logger = new StructuredLogger("debug", (line) => lines.push(line));
		const moduleRef = await Test.createTestingModule({
			imports: [
				AuthorizationModule.forRoot({
					imports: [AuthorizationStubsModule],
					gateway: { resolveUserId: async () => "123" }
				})
			],
			controllers: [McpProbeController]
		})
			.overrideProvider(APP_CONFIG_TOKEN)
			.useValue({
				database: { url: "postgres://unused@localhost/unused" },
				http: { port: 0 },
				logging: { level: "debug" },
				authorization: {
					discordClientId: "fixture-id",
					discordClientSecret: "fixture-client-secret",
					publicBaseUrl: "https://hub.example",
					sessionTtlSeconds: 300,
					rateLimits: { ...AUTHORIZATION_RATE_LIMIT_DEFAULTS, mcpPerMinute: 2 }
				}
			})
			.overrideProvider(PG_POOL_TOKEN)
			.useValue(pool)
			.overrideProvider(APP_LOGGER_TOKEN)
			.useValue(logger)
			.overrideProvider(AUTHORIZATION_STORE_TOKEN)
			.useValue(store)
			.compile();
		app = moduleRef.createNestApplication({ logger: false });
		await app.listen(0, "127.0.0.1");
		url = await app.getUrl();
	});

	afterAll(async () => {
		await app?.close();
	});

	async function post(path: string, address: string, body: unknown, headers: Record<string, string> = {}) {
		return fetch(`${url}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-forwarded-for": address,
				...headers
			},
			body: JSON.stringify(body)
		});
	}

	it("throttles /oauth/register at the shipped default and leaves another address unaffected", async () => {
		const registration = { redirect_uris: ["https://client.example/cb"] };
		for (let attempt = 1; attempt <= 10; attempt += 1) {
			const accepted = await post("/oauth/register", "203.0.113.10", registration);
			expect(accepted.status).toBe(201);
			await accepted.text();
		}
		const blocked = await post("/oauth/register", "203.0.113.10", registration);
		expect(blocked.status).toBe(429);
		const retryAfter = Number(blocked.headers.get("retry-after"));
		expect(retryAfter).toBeGreaterThan(0);
		expect(retryAfter).toBeLessThanOrEqual(3600);
		expect(await blocked.json()).toEqual({ error: "too_many_requests" });

		const unaffected = await post("/oauth/register", "203.0.113.11", registration);
		expect(unaffected.status).toBe(201);
		await unaffected.text();
	});

	it("throttles /oauth/token guesses and never logs credential material", async () => {
		const secrets = ["fixture-authorization-code", "fixture-pkce-verifier", "fixture-session-token"];
		const guess = {
			grant_type: "authorization_code",
			client_id: "fixture-client",
			code: secrets[0],
			code_verifier: secrets[1]
		};
		for (let attempt = 1; attempt <= 30; attempt += 1) {
			const refused = await post("/oauth/token", "203.0.113.20", guess);
			expect(refused.status).toBe(400);
			await refused.text();
		}
		const blocked = await post("/oauth/token", "203.0.113.20", guess, {
			authorization: `Bearer ${secrets[2]}`
		});
		expect(blocked.status).toBe(429);
		expect(await blocked.json()).toEqual({ error: "too_many_requests" });
		expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

		const output = lines.join("\n");
		expect(output).toContain("authorization request throttled");
		expect(output).toContain('"code":"rate_limited"');
		expect(output).toContain("203.0.113.20");
		for (const secret of secrets) expect(output).not.toContain(secret);
	});

	it("bounds /mcp with its own loose bucket and its own configuration value", async () => {
		expect((await post("/mcp", "203.0.113.30", {})).status).toBe(204);
		expect((await post("/mcp", "203.0.113.30", {})).status).toBe(204);
		const blocked = await post("/mcp", "203.0.113.30", {});
		expect(blocked.status).toBe(429);
		expect(await blocked.json()).toEqual({ error: "too_many_requests" });
		// The register bucket is independent of the MCP bucket.
		const registered = await post("/oauth/register", "203.0.113.31", {
			redirect_uris: ["https://client.example/cb"]
		});
		expect(registered.status).toBe(201);
		await registered.text();
	});
});
