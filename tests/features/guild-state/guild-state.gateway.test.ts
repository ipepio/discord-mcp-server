import { describe, expect, it } from "vitest";
import type { DiscordGuildStateRestOperations, DiscordRestOperations } from "../../../src/features/discord/index.js";
import { DiscordGuildStateGateway } from "../../../src/features/guild-state/gateways/discord-guild-state.gateway.js";
import type { GuildStateGateway } from "../../../src/features/guild-state/gateways/guild-state-gateway.interface.js";
import { FakeGuildStateGateway } from "./fakes/fake-guild-state-gateway.js";

/**
 * The `GuildStateGateway` contract and the one thing its implementation is allowed to do.
 *
 * docs/features/guild-state.md puts the guild-state REST reads "behind a narrow `GuildStateGateway` contract
 * owned here"; docs/features/discord.md answers from the other side, saying its exported `DiscordRestOperations`
 * "satisfies it structurally" with the import direction type-only and one-way. That arrangement is only half a
 * claim until something checks the shapes against each other, and `tsc` cannot check it on its own because no
 * production file ever puts the two names in one assignment. The assignability assertions below do, so a drift
 * in either feature's reads fails a build rather than surfacing as a broken bootstrap at runtime.
 *
 * The delegation tests then assert the implementation adds nothing: no retry, no pagination loop, no invented
 * bound, no fallback result. Timeouts, bounded retries with backoff, page bounds and payload validation are the
 * discord adapter's own promises (docs/features/discord.md R7) — a second copy here would mean two budgets
 * against one rate-limit window, and a swallowed failure would turn a pending part into a quiet one.
 *
 * Note what is NOT imported here: the discord feature's gateway files. Everything this test needs is on that
 * feature's public surface, which is the rule the composition follows too (docs/architecture/structure.md).
 */

const GUILD_ID = "160000000000000001";
const THREAD_ID = "160000000000000203";

/** Every read the contract names, in the order R2 lists the parts. */
const CONTRACT_READS = ["readGuildSnapshot", "readRoles", "readChannels", "readMemberRoster", "readThreadMembers"];

describe("GuildStateGateway contract (Contracts, R2)", () => {
	it("is satisfied structurally by the discord feature's exported REST operations", () => {
		// Compile-time assertions: each exported read contract must be usable where a `GuildStateGateway` is.
		const full: GuildStateGateway = undefined as unknown as DiscordRestOperations;
		const guildStateSubset: GuildStateGateway = undefined as unknown as DiscordGuildStateRestOperations;
		// Reaching this line at all is the check; the runtime assertions keep the test honest about its subject.
		expect(full).toBeUndefined();
		expect(guildStateSubset).toBeUndefined();
	});

	it("names reads only, so no caller can reach a Discord write through this contract (R8)", () => {
		const methods = Object.entries(new FakeGuildStateGateway({}, GUILD_ID))
			.filter(([, value]) => typeof value === "function")
			.map(([name]) => name)
			.sort();

		expect(methods).toEqual([...CONTRACT_READS].sort());
		for (const name of methods) {
			expect(name.startsWith("read")).toBe(true);
		}
	});

	it("takes no guild id anywhere, so the configured Guild is not a per-call choice (R1)", () => {
		// The two reads that accept anything at all accept a bound and a thread id — never a guild id.
		const rosterRead: Parameters<GuildStateGateway["readMemberRoster"]>[0] = { maxPages: 2, maxMembers: 10 };
		const threadRead: Parameters<GuildStateGateway["readThreadMembers"]>[0] = { threadId: THREAD_ID, after: "1" };
		expect(Object.keys(rosterRead ?? {}).sort()).toEqual(["maxMembers", "maxPages"]);
		expect(Object.keys(threadRead).sort()).toEqual(["after", "threadId"]);
	});
});

describe("DiscordGuildStateGateway delegation (Contracts)", () => {
	it("hands each read straight to the injected REST operations, with its argument intact", async () => {
		const rest = new FakeDiscordRest(GUILD_ID);
		const gateway = new DiscordGuildStateGateway({ rest });

		await gateway.readGuildSnapshot();
		await gateway.readRoles();
		await gateway.readChannels();
		await gateway.readMemberRoster({ maxPages: 4, maxMembers: 10 });
		await gateway.readThreadMembers({ threadId: THREAD_ID, after: "1", limit: 50 });

		expect(rest.calls).toEqual([
			"readGuildSnapshot",
			"readRoles",
			"readChannels",
			"readMemberRoster maxPages=4 maxMembers=10",
			`readThreadMembers ${THREAD_ID} after=1 limit=50`
		]);
	});

	it("returns exactly what the adapter returned, without post-processing or a fallback shape", async () => {
		const gateway = new DiscordGuildStateGateway({ rest: new FakeDiscordRest(GUILD_ID) });

		await expect(gateway.readRoles()).resolves.toEqual([
			{ guildId: GUILD_ID, roleId: "1", name: "r", permissionsBitfield: "1024", position: 0 }
		]);
		await expect(gateway.readMemberRoster()).resolves.toMatchObject({
			guildId: GUILD_ID,
			pages: 1,
			complete: true
		});
		await expect(gateway.readGuildSnapshot()).resolves.toEqual({ guildId: GUILD_ID, name: "delegated" });
	});

	it("passes a failure straight through: no retry, no swallow, no empty result invented (R2, R7)", async () => {
		const rest = new FakeDiscordRest(GUILD_ID);
		rest.failNext = new Error("discord-rest guild-snapshot failed");
		const gateway = new DiscordGuildStateGateway({ rest });

		await expect(gateway.readGuildSnapshot()).rejects.toThrow("discord-rest guild-snapshot failed");
		// One call, then the failure: a gateway-level retry would double the adapter's own bounded budget.
		expect(rest.calls).toEqual(["readGuildSnapshot"]);
	});

	it("answers a roster read with the pages the adapter reported, complete or not (R2: a partial roster says so)", async () => {
		const rest = new FakeDiscordRest(GUILD_ID);
		const gateway = new DiscordGuildStateGateway({ rest });

		const roster = await gateway.readMemberRoster({ maxPages: 1 });

		expect(roster).toMatchObject({ complete: false, pages: 1, truncatedBy: "page-limit" });
	});
});

/** The REST seam double: each call is recorded as a string, so an argument drift shows up in one `toEqual`. */
class FakeDiscordRest implements DiscordRestOperations {
	public readonly calls: string[] = [];

	public failNext: Error | undefined;

	public constructor(private readonly guildId: string) {}

	public readonly readGuildSnapshot = async () => {
		this.record("readGuildSnapshot");
		return { guildId: this.guildId, name: "delegated" };
	};

	public readonly readRoles = async () => {
		this.record("readRoles");
		return [{ guildId: this.guildId, roleId: "1", name: "r", permissionsBitfield: "1024", position: 0 }];
	};

	public readonly readChannels = async () => {
		this.record("readChannels");
		return [];
	};

	public readonly readMemberRoster = async (read?: Parameters<DiscordRestOperations["readMemberRoster"]>[0]) => {
		this.record(`readMemberRoster maxPages=${String(read?.maxPages)} maxMembers=${String(read?.maxMembers)}`);
		return read?.maxPages === undefined
			? { guildId: this.guildId, members: [], pages: 1, complete: true }
			: { guildId: this.guildId, members: [], pages: 1, complete: false, truncatedBy: "page-limit" as const };
	};

	public readonly readThreadMembers = async (read: Parameters<DiscordRestOperations["readThreadMembers"]>[0]) => {
		this.record(`readThreadMembers ${read.threadId} after=${String(read.after)} limit=${String(read.limit)}`);
		return { threadId: read.threadId, members: [], requestedLimit: 100, hasMore: false };
	};

	public readonly readMessageHistoryPage = async (
		read: Parameters<DiscordRestOperations["readMessageHistoryPage"]>[0]
	) => {
		this.record(`readMessageHistoryPage ${read.channelId}`);
		return { channelId: read.channelId, messages: [], requestedLimit: 100, hasMore: false };
	};

	public readonly readMessage = async (read: Parameters<DiscordRestOperations["readMessage"]>[0]) => {
		this.record(`readMessage ${read.channelId} ${read.messageId}`);
		return {
			messageId: read.messageId,
			channelId: read.channelId,
			authorId: "1",
			content: "reconciled text",
			createdInstant: new Date("2026-01-01T00:00:00.000Z"),
			messageType: "default" as const
		};
	};

	private record(name: string): void {
		this.calls.push(name);
		if (this.failNext !== undefined) {
			const failure = this.failNext;
			this.failNext = undefined;
			throw failure;
		}
	}
}
