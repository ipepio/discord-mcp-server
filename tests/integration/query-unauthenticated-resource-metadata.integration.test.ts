/**
 * R16/R17: the product surface an agent meets on `/mcp`. The protected-resource metadata document is
 * readable without a credential and names the authorization server (docs/features/query.md R16), and an
 * unauthenticated request answers `401` with the exact RFC 6750 challenge of its outcome class
 * (docs/features/authorization.md R17) before any dispatch.
 *
 * The guard is the authorization feature's; this suite verifies the mounted surface end to end, with the
 * real session store on an isolated PostgreSQL database and the real MCP controller behind the guard.
 */
import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OAuthController } from "../../src/features/authorization/controllers/oauth.controller.js";
import { AUTHORIZATION_PUBLIC_BASE_URL_TOKEN } from "../../src/features/authorization/controllers/mcp-authentication.guard.js";
import { BeginLoginCommand } from "../../src/features/authorization/commands/begin-login.command.js";
import { RegisterClientCommand } from "../../src/features/authorization/commands/register-client.command.js";
import { AuthenticateSessionQuery } from "../../src/features/authorization/queries/authenticate-session.query.js";
import { GetAuthorizationServerMetadataQuery } from "../../src/features/authorization/queries/get-authorization-server-metadata.query.js";
import { RequireCurrentMembershipQuery } from "../../src/features/authorization/queries/require-current-membership.query.js";
import { PostgresAuthorizationStoreRepository } from "../../src/features/authorization/repositories/postgres-authorization-store.repository.js";
import { McpController } from "../../src/features/query/controllers/mcp.controller.js";
import { QueryToolsAdapter } from "../../src/features/query/mcp/query-tools.adapter.js";
import { QUERY_TOOLS_ADAPTER_TOKEN } from "../../src/features/query/query.tokens.js";
import { APP_LOGGER_TOKEN } from "../../src/shared/logging/logging.tokens.js";
import { StructuredLogger } from "../../src/shared/logging/structured-logger.js";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";

const PUBLIC_BASE_URL = "https://hub.example";
const RESOURCE_METADATA = `${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource`;
const CHALLENGE = `Bearer resource_metadata="${RESOURCE_METADATA}"`;
const EXPIRED_DESCRIPTION = "The access token has expired.";
const INVALID_DESCRIPTION = "The access token is invalid.";
const UNAVAILABLE_DESCRIPTION = "Authentication is temporarily unavailable.";
const tokenHash = (value: string): string => createHash("sha256").update(value).digest("hex");

describe.skipIf(!HAS_TEST_DATABASE)("unauthenticated-resource-metadata — mounted MCP surface", () => {
	let database: IsolatedTestDatabase;
	let store: PostgresAuthorizationStoreRepository;
	let app: INestApplication;
	let url: string;
	// One registry status the whole suite shares: R10 makes a non-current registry a retryable refusal.
	let registryStatus: "current" | "stale" = "current";
	const tool = vi.fn(async () => ({ data: [] }));
	const metadata = vi.fn(async () => ({
		serverInfo: { name: "hub", version: "0", description: "hub" },
		instructions: "hub",
		capabilities: { tools: { listChanged: false } }
	}));

	beforeAll(async () => {
		database = await openIsolatedTestDatabase("query_unauthenticated");
		store = new PostgresAuthorizationStoreRepository(database.pool);
		await database.assertIsolation();
		await store.insertClient({
			clientId: "client",
			redirectUris: ["https://client.example/cb"],
			createdAt: new Date()
		});
		const gate = new RequireCurrentMembershipQuery({
			status: { execute: async () => ({ status: registryStatus }) },
			membership: { execute: async () => ({ status: "present" }) }
		});
		const adapter = new QueryToolsAdapter(
			{
				search_messages: { execute: tool },
				list_channels: { execute: tool },
				get_channel_history: { execute: tool },
				get_thread_messages: { execute: tool },
				get_message_context: { execute: tool },
				get_recent_activity: { execute: tool },
				get_hub_status: { execute: tool }
			},
			{ execute: metadata }
		);
		const module = await Test.createTestingModule({
			controllers: [McpController, OAuthController],
			providers: [
				{ provide: QUERY_TOOLS_ADAPTER_TOKEN, useValue: adapter },
				{ provide: AuthenticateSessionQuery, useValue: new AuthenticateSessionQuery({ store, gate }) },
				{ provide: AUTHORIZATION_PUBLIC_BASE_URL_TOKEN, useValue: PUBLIC_BASE_URL },
				{ provide: APP_LOGGER_TOKEN, useValue: new StructuredLogger("error", () => undefined) },
				{
					provide: GetAuthorizationServerMetadataQuery,
					useValue: new GetAuthorizationServerMetadataQuery(PUBLIC_BASE_URL)
				},
				{ provide: RegisterClientCommand, useValue: { execute: vi.fn() } },
				{ provide: BeginLoginCommand, useValue: { execute: vi.fn() } }
			]
		}).compile();
		app = module.createNestApplication({ logger: false });
		await app.listen(0, "127.0.0.1");
		url = await app.getUrl();
	}, 60_000);

	afterAll(async () => {
		await app?.close();
		await database?.close();
	});

	const call = (authorization?: string) =>
		fetch(`${url}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(authorization === undefined ? {} : { authorization })
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "list_channels", arguments: {} }
			})
		});

	const expectRefused = async (
		authorization: string | undefined,
		expected: { readonly error: string; readonly description: string } | undefined
	) => {
		tool.mockClear();
		metadata.mockClear();
		const response = await call(authorization);
		expect(response.status).toBe(401);
		// R17: every class names the protected-resource document; only (b)/(c)/(d) add an error member.
		expect(response.headers.get("www-authenticate")).toBe(
			expected === undefined
				? CHALLENGE
				: `${CHALLENGE}, error="${expected.error}", error_description="${expected.description}"`
		);
		// Only the technical class is retryable: replaying (a), (b) or (c) cannot succeed.
		expect(response.headers.get("retry-after")).toBe(expected?.error === "temporarily_unavailable" ? "5" : null);
		// The body is the RFC 6750 §3.1 object in every class, and nothing else.
		const body: unknown = await response.json();
		expect(body).toEqual(
			expected === undefined ? {} : { error: expected.error, error_description: expected.description }
		);
		expect(body).not.toHaveProperty("result");
		expect(JSON.stringify(body)).not.toContain("jsonrpc");
		// No stored-data fact leaves the guard: no session id, User id, client id or token material.
		expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|123456789/);
		expect(tool).not.toHaveBeenCalled();
		expect(metadata).not.toHaveBeenCalled();
	};

	it("unauthorized-missing-token — no credential means start the flow, not a token problem", async () => {
		await expectRefused(undefined, undefined);
	});

	it("unauthorized-invalid-token — a malformed credential names the invalid class", async () => {
		await expectRefused("Bearer not-a-token", { error: "invalid_token", description: INVALID_DESCRIPTION });
		await expectRefused("Basic secret", { error: "invalid_token", description: INVALID_DESCRIPTION });
	});

	it("unauthorized-expired-token — an expired session names renewal, not invalidity", async () => {
		registryStatus = "current";
		const token = "e".repeat(43);
		await store.insertSession({
			sessionId: randomUUID(),
			tokenHash: tokenHash(token),
			userId: "123456789",
			clientId: "client",
			issuedAt: new Date(Date.now() - 120_000),
			expiresAt: new Date(Date.now() - 60_000),
			revokedAt: null
		});
		await expectRefused(`Bearer ${token}`, { error: "invalid_token", description: EXPIRED_DESCRIPTION });
	});

	it("unauthorized-revoked-token — a revoked session is invalid, and renewing does not help", async () => {
		registryStatus = "current";
		const token = "r".repeat(43);
		await store.insertSession({
			sessionId: randomUUID(),
			tokenHash: tokenHash(token),
			userId: "123456789",
			clientId: "client",
			issuedAt: new Date(Date.now() - 60_000),
			expiresAt: new Date(Date.now() + 60_000),
			revokedAt: new Date()
		});
		await expectRefused(`Bearer ${token}`, { error: "invalid_token", description: INVALID_DESCRIPTION });
	});

	it("unauthorized-temporarily-unavailable — a non-current registry is the only retryable class", async () => {
		const token = "t".repeat(43);
		await store.insertSession({
			sessionId: randomUUID(),
			tokenHash: tokenHash(token),
			userId: "123456789",
			clientId: "client",
			issuedAt: new Date(),
			expiresAt: new Date(Date.now() + 60_000),
			revokedAt: null
		});
		registryStatus = "stale";
		try {
			await expectRefused(`Bearer ${token}`, {
				error: "temporarily_unavailable",
				description: UNAVAILABLE_DESCRIPTION
			});
		} finally {
			registryStatus = "current";
		}
	});

	it("serves the protected-resource metadata without a credential, naming the authorization server", async () => {
		const response = await fetch(`${url}/.well-known/oauth-protected-resource`);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			resource: `${PUBLIC_BASE_URL}/mcp`,
			authorization_servers: [PUBLIC_BASE_URL]
		});
		expect(tool).not.toHaveBeenCalled();
	});
});
