import { describe, expect, it, vi } from "vitest";
import { HttpDiscordOAuthGateway } from "../../../src/features/authorization/gateways/discord-oauth.gateway.js";

const tokenPayload = () =>
	new Response(
		JSON.stringify({
			access_token: "fixture-discord-access-token",
			refresh_token: "fixture-refresh-token",
			token_type: "Bearer",
			scope: "identify"
		})
	);
const gatewayFor = (fetch: typeof globalThis.fetch) =>
	new HttpDiscordOAuthGateway({
		fetch,
		clientId: "fixture-client",
		clientSecret: "fixture-client-secret",
		redirectUri: "https://hub.example/oauth/discord/callback"
	});

describe("Discord OAuth HTTPS boundary", () => {
	it("retries replay-safe identity fetch on 5xx but never repeats the exchange", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(tokenPayload())
			.mockResolvedValueOnce(new Response("private upstream body", { status: 503 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ id: "123" })));
		expect(await gatewayFor(fetch).resolveUserId("fixture-code")).toBe("123");
		expect(fetch.mock.calls.map((call) => call[0])).toEqual([
			"https://discord.com/api/oauth2/token",
			"https://discord.com/api/users/@me",
			"https://discord.com/api/users/@me"
		]);
		expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
	});
	it.each([{}, { id: "0" }, { id: 123 }, { id: "9223372036854775808" }, { id: "secret-user-name" }])(
		"validates identity payloads before returning %j",
		async (identity) => {
			const fetch = vi
				.fn<typeof globalThis.fetch>()
				.mockResolvedValueOnce(tokenPayload())
				.mockResolvedValueOnce(new Response(JSON.stringify(identity)));
			await expect(gatewayFor(fetch).resolveUserId("fixture-code")).rejects.toMatchObject({
				code: "invalid_identity",
				message: "Discord identity verification failed."
			});
			expect(fetch).toHaveBeenCalledTimes(2);
		}
	);
	it("does not retry authentication errors or reveal their upstream body", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(tokenPayload())
			.mockResolvedValueOnce(new Response("fixture-discord-access-token", { status: 401 }));
		await expect(gatewayFor(fetch).resolveUserId("fixture-code")).rejects.toMatchObject({
			code: "identity_failed",
			message: "Discord identity verification failed."
		});
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it("bounds replay-safe transport retries at two attempts", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(tokenPayload())
			.mockRejectedValue(new Error("fixture-private-host"));
		await expect(gatewayFor(fetch).resolveUserId("fixture-code")).rejects.toMatchObject({
			code: "identity_failed"
		});
		expect(fetch).toHaveBeenCalledTimes(3);
	});
});
