import { describe, expect, it, vi } from "vitest";
import { QueryAccessPolicy } from "../../../src/features/query/queries/query-access.policy.js";

export const channel = {
	channelId: "10",
	channelType: "guild-text",
	isThread: false,
	parentChannelId: null,
	name: "visible",
	position: 0,
	canReadMessageHistory: false
} as const;
describe("query permission gates", () => {
	it("acl-content-vs-visibility uses the registry's batched effective evaluation", async () => {
		const registry = { execute: vi.fn(async () => ({ guildId: "1", channels: [channel] })) };
		const access = new QueryAccessPolicy({ execute: async () => ({ guildId: "1", status: "current" }) }, registry);
		expect((await access.resolve("7", "visibility")).accessibleChannelIds).toEqual(["10"]);
		expect((await access.resolve("7", "content")).accessibleChannelIds).toEqual([]);
		expect(registry.execute).toHaveBeenNthCalledWith(1, { userId: "7" });
	});
	it("technical evaluation failures are not empty pages", async () => {
		const access = new QueryAccessPolicy(
			{ execute: async () => ({ guildId: "1", status: "current" }) },
			{
				execute: async () => {
					throw new Error("db");
				}
			}
		);
		await expect(access.resolve("7", "content")).rejects.toMatchObject({ code: "internal_error" });
	});
	it.each(["stale", "incomplete", "unavailable"] as const)("registry-not-current-refusal: %s", async (status) => {
		const registry = { execute: vi.fn() };
		const access = new QueryAccessPolicy({ execute: async () => ({ guildId: "1", status }) }, registry);
		await expect(access.resolve("7", "visibility")).rejects.toMatchObject({ code: "state_unavailable" });
		expect(registry.execute).not.toHaveBeenCalled();
	});
});
