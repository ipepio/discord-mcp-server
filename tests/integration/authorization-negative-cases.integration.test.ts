import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresAuthorizationStoreRepository } from "../../src/features/authorization/repositories/postgres-authorization-store.repository.js";
import { CompleteLoginCommand } from "../../src/features/authorization/commands/complete-login.command.js";
import { ExchangeAuthorizationCodeCommand } from "../../src/features/authorization/commands/exchange-authorization-code.command.js";
import { RevokeUserSessionsCommand } from "../../src/features/authorization/commands/revoke-user-sessions.command.js";
import { AuthenticateSessionQuery } from "../../src/features/authorization/queries/authenticate-session.query.js";
import { RequireCurrentMembershipQuery } from "../../src/features/authorization/queries/require-current-membership.query.js";
import { McpAuthenticationGuard } from "../../src/features/authorization/controllers/mcp-authentication.guard.js";
import { MembershipEndSubscription } from "../../src/features/authorization/gateways/membership-end-subscription.gateway.js";
import { StructuredLogger } from "../../src/shared/logging/structured-logger.js";
import { DiscordEventKind } from "../../src/features/discord/index.js";
import { FakeDiscordEventConsumer } from "../features/guild-state/fakes/fake-discord-event-consumer.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");

describe.skipIf(!HAS_TEST_DATABASE)(
	"authorization named negative use cases — real PostgreSQL, no external OAuth",
	() => {
		let database: IsolatedTestDatabase;
		let store: PostgresAuthorizationStoreRepository;
		const status = vi.fn().mockResolvedValue({ status: "current" });
		const membership = vi.fn().mockResolvedValue({ status: "present" });
		const gateway = { resolveUserId: vi.fn().mockResolvedValue("123") };
		const gate = new RequireCurrentMembershipQuery({
			status: { execute: status },
			membership: { execute: membership }
		});
		const logger = new StructuredLogger("error", () => undefined);
		beforeAll(async () => {
			database = await openIsolatedTestDatabase("authorization_negatives");
			store = new PostgresAuthorizationStoreRepository(database.pool);
			await store.insertClient({
				clientId: "client",
				redirectUris: ["https://client.example/cb"],
				createdAt: new Date()
			});
		}, 60_000);
		beforeEach(async () => {
			await database.assertIsolation();
			await database.pool.query(
				"DELETE FROM hub_session; DELETE FROM oauth_authorization_code; DELETE FROM oauth_pending_request;"
			);
			status.mockReset().mockResolvedValue({ status: "current" });
			membership.mockReset().mockResolvedValue({ status: "present" });
			gateway.resolveUserId.mockReset().mockResolvedValue("123");
		});
		afterAll(async () => {
			await database?.close();
		});
		const pending = async () => {
			const state = randomUUID();
			await store.insertPendingRequest({
				discordState: state,
				clientId: "client",
				redirectUri: "https://client.example/cb",
				clientState: "client state + /",
				codeChallenge: challenge,
				expiresAt: new Date(Date.now() + 60000)
			});
			return state;
		};
		const session = async (token: string, expired = false) => {
			await store.insertSession({
				sessionId: randomUUID(),
				tokenHash: hash(token),
				userId: "123",
				clientId: "client",
				issuedAt: new Date(Date.now() - 60000),
				expiresAt: new Date(Date.now() + (expired ? -1000 : 60000)),
				revokedAt: null
			});
		};
		const sessionCount = async () =>
			(await database.pool.query<{ count: string }>("SELECT count(*) FROM hub_session")).rows[0]?.count;
		const guard = () =>
			new McpAuthenticationGuard(new AuthenticateSessionQuery({ store, gate }), "https://hub.example");
		const response = { setHeader() {} };

		it("non-member-user-denied", async () => {
			membership.mockResolvedValue({ status: "absent" });
			const complete = new CompleteLoginCommand({ store, gateway, gate });
			await expect(
				complete.execute({ state: await pending(), code: "discord-fixture-code" })
			).rejects.toMatchObject({ code: "access_denied" });
			expect(await sessionCount()).toBe("0");
		});
		it("tampered-state", async () => {
			const state = await pending();
			const complete = new CompleteLoginCommand({ store, gateway, gate });
			await expect(
				complete.execute({ state: state + "tampered", code: "discord-fixture-code" })
			).rejects.toMatchObject({ code: "invalid_grant" });
			expect(gateway.resolveUserId).not.toHaveBeenCalled();
			const result = await complete.execute({ state, code: "discord-fixture-code" });
			// The hub never takes a replacement client-state from callback input: the consumed row alone supplies it.
			expect(result.state).toBe("client state + /");
			await expect(complete.execute({ state, code: "discord-fixture-code" })).rejects.toMatchObject({
				code: "invalid_grant"
			});
			expect(await store.consumePendingRequest(state, new Date())).toBeNull();
			expect(await sessionCount()).toBe("0");
		});
		it("pkce-failure", async () => {
			const complete = new CompleteLoginCommand({ store, gateway, gate });
			const result = await complete.execute({ state: await pending(), code: "discord-fixture-code" });
			const exchange = new ExchangeAuthorizationCodeCommand({ store, gate, sessionTtlSeconds: 300 });
			const input = {
				code: result.code,
				clientId: "client",
				redirectUri: result.redirectUri,
				grantType: "authorization_code",
				codeVerifier: "wrong".repeat(10)
			};
			await expect(exchange.execute(input)).rejects.toMatchObject({ code: "invalid_grant" });
			await expect(exchange.execute({ ...input, codeVerifier: verifier })).rejects.toMatchObject({
				code: "invalid_grant"
			});
			expect(await sessionCount()).toBe("0");
		});
		it("expired-session", async () => {
			const token = "e".repeat(43);
			await session(token, true);
			await expect(
				guard().authenticateRequest({ headers: { authorization: `Bearer ${token}` } }, response)
			).rejects.toMatchObject({ status: 401 });
		});
		it("revoked-after-membership-end", async () => {
			const tokens = ["a".repeat(43), "b".repeat(43)];
			for (const token of tokens) await session(token);
			const events = new FakeDiscordEventConsumer();
			const binding = new MembershipEndSubscription({
				events,
				revoke: new RevokeUserSessionsCommand({ store, logger }),
				guildId: "1"
			});
			binding.onModuleInit();
			await events.deliver({ kind: DiscordEventKind.memberRemoved, guildId: "1", userId: "123" });
			for (const token of tokens)
				await expect(
					guard().authenticateRequest({ headers: { authorization: `Bearer ${token}` } }, response)
				).rejects.toMatchObject({ status: 401 });
			expect(events.handlerCountFor(DiscordEventKind.roleDeleted)).toBe(0);
			binding.onModuleDestroy();
		});
		it.each(["stale", "incomplete", "unavailable"])(
			"guild-state-unavailable-at-login: %s",
			async (registryStatus) => {
				status.mockResolvedValue({ status: registryStatus });
				const complete = new CompleteLoginCommand({ store, gateway, gate });
				await expect(
					complete.execute({ state: await pending(), code: "discord-fixture-code" })
				).rejects.toMatchObject({ code: "temporarily_unavailable" });
				expect(await sessionCount()).toBe("0");
				const token = "s".repeat(43);
				await session(token);
				await expect(
					guard().authenticateRequest({ headers: { authorization: `Bearer ${token}` } }, response)
				).rejects.toMatchObject({ status: 401 });
				status.mockResolvedValue({ status: "current" });
				expect(
					await guard().authenticateRequest({ headers: { authorization: `Bearer ${token}` } }, response)
				).toMatchObject({ userId: "123" });
			}
		);
	}
);
