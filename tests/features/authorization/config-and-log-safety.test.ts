import { describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../../../src/shared/config/config.factory.js";
import { loadAuthorizationConfig } from "../../../src/shared/config/authorization-config.js";
import { AuthorizationAuditGateway } from "../../../src/features/authorization/gateways/authorization-audit.gateway.js";
import { StructuredLogger } from "../../../src/shared/logging/structured-logger.js";
import { OAuthController } from "../../../src/features/authorization/controllers/oauth.controller.js";
import { LoginController } from "../../../src/features/authorization/controllers/login.controller.js";
import { RegisterClientCommand } from "../../../src/features/authorization/commands/register-client.command.js";
import { BeginLoginCommand } from "../../../src/features/authorization/commands/begin-login.command.js";
import { CompleteLoginCommand } from "../../../src/features/authorization/commands/complete-login.command.js";
import { ExchangeAuthorizationCodeCommand } from "../../../src/features/authorization/commands/exchange-authorization-code.command.js";
import { RotateRefreshTokenCommand } from "../../../src/features/authorization/commands/rotate-refresh-token.command.js";
import { RequireCurrentMembershipQuery } from "../../../src/features/authorization/queries/require-current-membership.query.js";
import { GetAuthorizationServerMetadataQuery } from "../../../src/features/authorization/queries/get-authorization-server-metadata.query.js";
import { authorizationStoreFixture } from "./authorization-store.fixture.js";

const env = {
	DATABASE_URL: "postgres://unused@localhost/unused",
	DISCORD_CLIENT_ID: "fixture-id",
	DISCORD_CLIENT_SECRET: "fixture-client-secret",
	PUBLIC_BASE_URL: "https://hub.example",
	SESSION_TTL_SECONDS: "300"
};

describe("startup authorization configuration", () => {
	it("validates once, freezes settings and uses one normalized issuer source", () => {
		const config = loadAppConfig(env);
		expect(Object.isFrozen(config.authorization)).toBe(true);
		expect(config.authorization).toMatchObject({ publicBaseUrl: "https://hub.example", sessionTtlSeconds: 300 });
	});
	it.each(["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "PUBLIC_BASE_URL", "SESSION_TTL_SECONDS"])(
		"rejects missing %s before any network or listener activity",
		(name) => {
			const network = vi.fn();
			const listener = vi.fn();
			expect(() => {
				loadAppConfig({ ...env, [name]: "" });
				listener();
				network();
			}).toThrow(name);
			expect(network).not.toHaveBeenCalled();
			expect(listener).not.toHaveBeenCalled();
		}
	);
	it.each(["299", "86401", "1.5", "Infinity", "300seconds", "3e2", "-300"])("rejects invalid TTL %s", (ttl) => {
		expect(() => loadAuthorizationConfig({ ...env, SESSION_TTL_SECONDS: ttl })).toThrow("SESSION_TTL_SECONDS");
	});
	it.each([
		"https://user:secret@hub.example",
		"http://hub.example",
		"https://hub.example/path",
		"https://hub.example?secret=x",
		"not-a-url"
	])("rejects invalid issuer without leaking its value", (base) => {
		expect(() => loadAuthorizationConfig({ ...env, PUBLIC_BASE_URL: base })).toThrow(
			"Invalid configuration: PUBLIC_BASE_URL"
		);
	});
	it("permits HTTP loopback only under explicit local-development configuration", () => {
		expect(() => loadAuthorizationConfig({ ...env, PUBLIC_BASE_URL: "http://127.0.0.1:3000" })).toThrow(
			"PUBLIC_BASE_URL"
		);
		expect(
			loadAuthorizationConfig({
				...env,
				PUBLIC_BASE_URL: "http://127.0.0.1:3000",
				AUTHORIZATION_LOCAL_DEVELOPMENT: "true"
			}).publicBaseUrl
		).toBe("http://127.0.0.1:3000");
	});
});

describe("authorization log and error safety", () => {
	it("excludes secret fixtures from emitted logs and every error response", async () => {
		const secrets = [
			"fixture-session-token",
			"fixture-discord-token",
			"fixture-authorization-code",
			"fixture-state",
			"fixture-client-secret",
			"fixture-pkce-verifier",
			"fixture-token-hash"
		];
		const lines: string[] = [];
		const logger = new StructuredLogger("debug", (line) => lines.push(line));
		const audit = new AuthorizationAuditGateway(logger);
		audit.record({ code: "login_completed", clientId: "registered-client", userId: "123" });
		const store = authorizationStoreFixture();
		store.findClient.mockRejectedValue(new Error(secrets.join(" ")));
		const gate = new RequireCurrentMembershipQuery({
			status: { execute: async () => ({ status: "current" }) },
			membership: { execute: async () => ({ status: "present" }) }
		});
		const oauth = new OAuthController(
			new GetAuthorizationServerMetadataQuery("https://hub.example"),
			new RegisterClientCommand(store),
			new BeginLoginCommand({ store, publicBaseUrl: "https://hub.example", discordClientId: "id" }),
			logger
		);
		const login = new LoginController(
			new CompleteLoginCommand({
				store,
				gate,
				gateway: {
					resolveUserId: async () => {
						throw new Error(secrets.join(" "));
					}
				},
				audit
			}),
			new ExchangeAuthorizationCodeCommand({ store, gate, sessionTtlSeconds: 300, audit }),
			new RotateRefreshTokenCommand({ store, gate, sessionTtlSeconds: 300, audit }),
			logger
		);
		const responses: unknown[] = [];
		const response = {
			status() {
				return this;
			},
			setHeader() {},
			json(value: unknown) {
				responses.push(value);
			},
			redirect() {
				throw new Error("unexpected redirect");
			}
		};
		await oauth.authorize({ client_id: secrets[0], state: secrets[3] }, response);
		store.consumePendingRequest.mockResolvedValueOnce({
			discordState: "stored-state",
			clientId: "registered-client",
			redirectUri: "https://client.example/cb",
			clientState: "client-state",
			codeChallenge: "a".repeat(43),
			expiresAt: new Date(Date.now() + 60000)
		});
		await login.callback({ state: secrets[3], code: secrets[2] }, response);
		await login.token({ grant_type: "authorization_code", code: secrets[2], code_verifier: secrets[5] }, response);
		const output = JSON.stringify({ lines, responses });
		for (const secret of secrets) expect(output).not.toContain(secret);
		expect(responses[0]).toMatchObject({ error: "server_error", correlationId: expect.any(String) });
		expect(lines.join(" ")).toContain("authorization protocol failure");
		expect(responses[1]).toMatchObject({ error: "temporarily_unavailable" });
		expect(output).not.toContain("stack");
		expect(output).not.toContain("SQL");
	});
	it("a broken audit sink is counted and never fails the login outcome", () => {
		const logger = new StructuredLogger("debug", () => {
			throw new Error("sink failed");
		});
		const audit = new AuthorizationAuditGateway(logger);
		expect(() =>
			audit.record({ code: "session_issued", clientId: "client", userId: "123", sessionId: "session" })
		).not.toThrow();
		expect(audit.anomalyCount()).toBe(1);
	});
});
