import { describe, expect, it, vi } from "vitest";
import { DiscordEventKind } from "../../../src/features/discord/index.js";
import { RevokeUserSessionsCommand } from "../../../src/features/authorization/commands/revoke-user-sessions.command.js";
import { MembershipEndSubscription } from "../../../src/features/authorization/gateways/membership-end-subscription.gateway.js";
import { StructuredLogger } from "../../../src/shared/logging/structured-logger.js";
import { FakeDiscordEventConsumer } from "../guild-state/fakes/fake-discord-event-consumer.js";
import { authorizationStoreFixture } from "./authorization-store.fixture.js";

function fixture() {
	const store = authorizationStoreFixture();
	const lines: string[] = [];
	const logger = new StructuredLogger("debug", (line) => lines.push(line));
	const revoke = new RevokeUserSessionsCommand({ store, logger });
	const events = new FakeDiscordEventConsumer();
	const subscription = new MembershipEndSubscription({ events, revoke, guildId: "1" });
	subscription.onModuleInit();
	return { store, lines, revoke, events, subscription };
}

describe("membership-end session revocation", () => {
	it("revoked-after-membership-end: a normalized removal performs one user-wide write", async () => {
		const f = fixture();
		f.store.revokeUserSessions.mockResolvedValue(2);
		await f.events.deliver({ kind: DiscordEventKind.memberRemoved, guildId: "1", userId: "123" });
		expect(f.store.revokeUserSessions).toHaveBeenCalledTimes(1);
		expect(f.store.revokeUserSessions).toHaveBeenCalledWith("123", expect.any(Date));
		expect(f.lines.join("")).toContain("sessions_revoked");
	});
	it("the removal sweeps the refresh family with the session", async () => {
		const f = fixture();
		f.store.revokeUserSessions.mockResolvedValue(1);
		f.store.revokeUserRefreshTokens.mockResolvedValue(3);
		await f.events.deliver({ kind: DiscordEventKind.memberRemoved, guildId: "1", userId: "123" });
		expect(f.store.revokeUserRefreshTokens).toHaveBeenCalledWith("123", expect.any(Date));
		const line = f.lines
			.map((entry) => JSON.parse(entry) as Record<string, unknown>)
			.find((entry) => (entry["fields"] as Record<string, unknown>)["code"] === "sessions_revoked");
		expect(line?.["fields"]).toMatchObject({ userId: "123", count: 1, refreshCount: 3 });
	});
	it("a user whose sessions are gone but whose family survives is still a revocation", async () => {
		const f = fixture();
		f.store.revokeUserRefreshTokens.mockResolvedValue(1);
		await f.revoke.execute("123");
		expect(f.lines.join("")).toContain("sessions_revoked");
		expect(f.lines.join("")).not.toContain("revocation_noop");
	});
	it("a failing family sweep is counted and never reported as success", async () => {
		const f = fixture();
		f.store.revokeUserRefreshTokens.mockRejectedValue(new Error("private SQL and secret"));
		await expect(f.revoke.execute("123")).rejects.toThrow("Session revocation failed.");
		expect(f.revoke.anomalyCount()).toBe(1);
		const output = f.lines.join("");
		expect(output).toContain("revocation_failed");
		expect(output).not.toContain("private SQL");
	});
	it("duplicates and users without sessions are counted no-ops", async () => {
		const f = fixture();
		for (let i = 0; i < 2; i++)
			await f.events.deliver({ kind: DiscordEventKind.memberRemoved, guildId: "1", userId: "123" });
		expect(f.store.revokeUserSessions).toHaveBeenCalledTimes(2);
		expect(f.lines.join("")).toContain("revocation_noop");
	});
	it("role, overwrite and private-thread changes bind no revocation handler", () => {
		const f = fixture();
		expect(f.events.boundKinds).toEqual([DiscordEventKind.memberRemoved]);
		for (const kind of [
			DiscordEventKind.roleDeleted,
			DiscordEventKind.channelUpdated,
			DiscordEventKind.threadMemberRemoved
		])
			expect(f.events.handlerCountFor(kind)).toBe(0);
	});
	it("foreign Guild events perform no write and lifecycle does not double-subscribe", async () => {
		const f = fixture();
		f.subscription.onModuleInit();
		expect(f.events.handlerCountFor(DiscordEventKind.memberRemoved)).toBe(1);
		await f.events.deliver({ kind: DiscordEventKind.memberRemoved, guildId: "2", userId: "123" });
		expect(f.store.revokeUserSessions).not.toHaveBeenCalled();
		f.subscription.onModuleDestroy();
		expect(f.events.boundKinds).toEqual([]);
	});
	it("failing writes are counted and safely logged, never swallowed", async () => {
		const f = fixture();
		f.store.revokeUserSessions.mockRejectedValue(new Error("private SQL and secret"));
		await expect(
			f.events.deliver({ kind: DiscordEventKind.memberRemoved, guildId: "1", userId: "123" })
		).rejects.toThrow("Session revocation failed.");
		expect(f.revoke.anomalyCount()).toBe(1);
		expect(f.lines.join("")).toContain("revocation_failed");
		expect(f.lines.join("")).not.toContain("private SQL");
	});
	it("per-session revocation remains independent at the repository seam", async () => {
		const f = fixture();
		const call = vi.fn(async () => f.store.revokeSession("one", new Date()));
		await call();
		expect(f.store.revokeUserSessions).not.toHaveBeenCalled();
	});
});
