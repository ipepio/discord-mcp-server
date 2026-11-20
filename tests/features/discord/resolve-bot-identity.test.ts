import { describe, expect, it } from "vitest";
import { resolveBotIdentity } from "../../../src/features/discord/index.js";
import { FakeDiscordRestTransport, restOk, restClientError } from "./fakes/fake-discord-rest-transport.js";
const env = { DISCORD_BOT_TOKEN: "fixture-token", DISCORD_GUILD_ID: "1" };
describe("learned bot identity", () => {
	it("reads users/@me through the existing bounded REST seam", async () => {
		const transport = new FakeDiscordRestTransport().reply("/users/@me", restOk({ id: "123" }));
		expect(await resolveBotIdentity(env, transport)).toBe("123");
		expect(transport.requests).toHaveLength(1);
		expect(transport.requests[0]).toMatchObject({
			path: "/users/@me",
			operation: "discord-rest.bot-identity",
			timeoutMs: expect.any(Number)
		});
		expect(transport.timeouts[0]).toBeGreaterThan(0);
	});
	it.each([{}, { id: "bad" }, { id: 123 }, { id: "0" }, { id: "9999999999999999999999" }])(
		"rejects malformed identity %j",
		async (payload) => {
			const transport = new FakeDiscordRestTransport().reply("/users/@me", restOk(payload));
			await expect(resolveBotIdentity(env, transport)).rejects.toMatchObject({ name: "DiscordRestFailureError" });
		}
	);
	it("does not retry a rejected credential or expose the credential in failures", async () => {
		const transport = new FakeDiscordRestTransport().reply("/users/@me", restClientError(401));
		await expect(resolveBotIdentity(env, transport)).rejects.not.toThrow(env.DISCORD_BOT_TOKEN);
		expect(transport.requests).toHaveLength(1);
	});
});
