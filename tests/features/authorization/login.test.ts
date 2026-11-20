import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CompleteLoginCommand } from "../../../src/features/authorization/commands/complete-login.command.js";
import { ExchangeAuthorizationCodeCommand } from "../../../src/features/authorization/commands/exchange-authorization-code.command.js";
import { HttpDiscordOAuthGateway } from "../../../src/features/authorization/gateways/discord-oauth.gateway.js";
import { RequireCurrentMembershipQuery } from "../../../src/features/authorization/queries/require-current-membership.query.js";
import { authorizationStoreFixture } from "./authorization-store.fixture.js";

const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
function fixture() {
	const store = authorizationStoreFixture();
	const status = vi.fn().mockResolvedValue({ status: "current" });
	const membership = vi.fn().mockResolvedValue({ status: "present" });
	const gate = new RequireCurrentMembershipQuery({
		status: { execute: status },
		membership: { execute: membership }
	});
	const gateway = { resolveUserId: vi.fn().mockResolvedValue("123") };
	const pending = {
		discordState: "discord-state",
		clientId: "client",
		redirectUri: "https://client.example/cb",
		clientState: "client state + / %",
		codeChallenge: challenge,
		expiresAt: new Date(Date.now() + 60000)
	};
	store.consumePendingRequest.mockResolvedValueOnce(pending);
	const complete = new CompleteLoginCommand({ store, gateway, gate });
	const exchange = new ExchangeAuthorizationCodeCommand({ store, gate, sessionTtlSeconds: 300 });
	const code = {
		codeHash: "hash",
		clientId: "client",
		redirectUri: pending.redirectUri,
		userId: "123",
		codeChallenge: challenge,
		expiresAt: pending.expiresAt
	};
	const redemption = {
		code: "hub-code",
		clientId: "client",
		redirectUri: pending.redirectUri,
		codeVerifier: verifier,
		grantType: "authorization_code"
	};
	return { store, status, membership, gateway, complete, exchange, code, redemption, pending };
}

describe("Discord SSO and hub session issuance", () => {
	it("resolves identity server-side, echoes byte-exact client state and returns only a hub code", async () => {
		const f = fixture();
		const result = await f.complete.execute({ state: "discord-state", code: "discord-code" });
		expect(result.state).toBe(f.pending.clientState);
		expect(result.code).not.toBe("discord-code");
		expect(f.store.insertCode).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "123", codeHash: createHash("sha256").update(result.code).digest("hex") })
		);
		expect(f.store.insertSession).not.toHaveBeenCalled();
	});
	it("non-member-user-denied", async () => {
		const f = fixture();
		f.membership.mockResolvedValue({ status: "absent" });
		await expect(f.complete.execute({ state: "discord-state", code: "discord-code" })).rejects.toMatchObject({
			code: "access_denied"
		});
		expect(f.store.insertSession).not.toHaveBeenCalled();
		expect(f.store.insertCode).not.toHaveBeenCalled();
	});
	it("tampered-state: unknown Discord state and replay exchange nothing", async () => {
		const f = fixture();
		f.store.consumePendingRequest.mockReset().mockResolvedValue(null);
		await expect(f.complete.execute({ state: "tampered", code: "discord-code" })).rejects.toMatchObject({
			code: "invalid_grant"
		});
		expect(f.gateway.resolveUserId).not.toHaveBeenCalled();
	});
	it.each(["stale", "incomplete", "unavailable"])("guild-state-unavailable-at-login: %s", async (status) => {
		const f = fixture();
		f.status.mockResolvedValue({ status });
		await expect(f.complete.execute({ state: "discord-state", code: "discord-code" })).rejects.toMatchObject({
			code: "temporarily_unavailable"
		});
		expect(f.store.insertSession).not.toHaveBeenCalled();
		expect(f.store.insertCode).not.toHaveBeenCalled();
	});
	it("guild-state query exceptions are unavailable, not non-membership", async () => {
		const f = fixture();
		f.status.mockRejectedValue(new Error("private database host"));
		await expect(f.complete.execute({ state: "discord-state", code: "discord-code" })).rejects.toMatchObject({
			code: "temporarily_unavailable"
		});
	});
	it("pkce-failure: a failed verifier burns the code and persists no session", async () => {
		const f = fixture();
		f.store.consumeCode.mockResolvedValueOnce(f.code);
		await expect(f.exchange.execute({ ...f.redemption, codeVerifier: "x".repeat(43) })).rejects.toMatchObject({
			code: "invalid_grant"
		});
		await expect(f.exchange.execute(f.redemption)).rejects.toMatchObject({ code: "invalid_grant" });
		expect(f.store.insertSession).not.toHaveBeenCalled();
	});
	it("issues an opaque token pair once after PKCE, persists only their hashes, with fixed expiry", async () => {
		const f = fixture();
		f.store.consumeCode.mockResolvedValueOnce(f.code);
		const result = await f.exchange.execute(f.redemption);
		expect(result).toMatchObject({
			accessToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			refreshToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			expiresIn: 300,
			refreshExpiresIn: 30 * 24 * 60 * 60
		});
		const session = f.store.insertSession.mock.calls[0]?.[0];
		expect(session?.tokenHash).toBe(createHash("sha256").update(result.accessToken).digest("hex"));
		expect(session).not.toHaveProperty("accessToken");
		expect((session?.expiresAt.getTime() ?? 0) - (session?.issuedAt.getTime() ?? 0)).toBe(300000);
		const refresh = f.store.insertRefreshToken.mock.calls[0]?.[0];
		expect(refresh?.tokenHash).toBe(createHash("sha256").update(result.refreshToken).digest("hex"));
		expect(refresh?.sessionId).toBe(session?.sessionId);
		expect(refresh?.familyId).toMatch(/^[0-9a-f-]{36}$/);
		expect(refresh).not.toHaveProperty("refreshToken");
	});
	it("failed persistence never returns a token", async () => {
		const f = fixture();
		f.store.consumeCode.mockResolvedValueOnce(f.code);
		f.store.insertSession.mockRejectedValue(new Error("database failed"));
		await expect(f.exchange.execute(f.redemption)).rejects.toThrow("database failed");
	});
	it("gateway exchanges once over HTTPS, requests no Guild capability, and returns only the User id", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						access_token: "discord-secret",
						refresh_token: "refresh-secret",
						token_type: "Bearer",
						scope: "identify"
					})
				)
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ id: "123", username: "not stored" })));
		const gateway = new HttpDiscordOAuthGateway({
			fetch,
			clientId: "id",
			clientSecret: "secret",
			redirectUri: "https://hub.example/oauth/discord/callback"
		});
		expect(await gateway.resolveUserId("upstream-code")).toBe("123");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls[0]?.[0]).toBe("https://discord.com/api/oauth2/token");
		expect(fetch.mock.calls[1]?.[0]).toBe("https://discord.com/api/users/@me");
	});
	it("does not retry ambiguous code exchange failures or expose their detail", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("upstream-secret"));
		const gateway = new HttpDiscordOAuthGateway({
			fetch,
			clientId: "id",
			clientSecret: "secret",
			redirectUri: "https://hub.example/oauth/discord/callback"
		});
		await expect(gateway.resolveUserId("code")).rejects.toThrow("Discord identity verification failed.");
		expect(fetch).toHaveBeenCalledTimes(1);
	});
	it("rejects invalid identity payloads and upstream token scope", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(
				new Response(JSON.stringify({ access_token: "secret", scope: "guilds", token_type: "Bearer" }))
			);
		const gateway = new HttpDiscordOAuthGateway({
			fetch,
			clientId: "id",
			clientSecret: "secret",
			redirectUri: "https://hub.example/oauth/discord/callback"
		});
		await expect(gateway.resolveUserId("code")).rejects.toMatchObject({ code: "exchange_failed" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
