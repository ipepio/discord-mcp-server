import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryToolsAdapter } from "../../src/features/query/mcp/query-tools.adapter.js";
import { PostgresMessageReadRepository } from "../../src/features/query/repositories/postgres-message-read.repository.js";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";
import { botViewsChannels, queryToolFixture } from "./query-tool-fixture.js";
import type { QueryToolName } from "../../src/features/query/models/domain/tool-input.js";
import type { GuildRegistryStatus } from "../../src/features/guild-state/index.js";

const calls: readonly [QueryToolName, Record<string, unknown>][] = [
	["list_channels", {}],
	["search_messages", { query: "one" }],
	["get_channel_history", { channelId: "10" }],
	["get_thread_messages", { threadId: "10" }],
	["get_message_context", { messageId: "100" }],
	// R14: an explicit lower bound keeps the digest's window deterministic, so this sweep proves the
	// digest's own read paths and not the 24-hour default's clock.
	["get_recent_activity", { since: "2026-01-01T00:00:00Z" }],
	// R17: the seventh tool takes no argument and reads no message table; it is inside the impersonation,
	// tombstone and read-only sweeps (whose predicates it must satisfy) and outside `registry-not-current-refusal`
	// (it reports a non-current status instead of refusing).
	["get_hub_status", {}]
];
/** R11 gates the six tools that answer with data; R17's status tool is the documented exception. */
const gatedCalls = calls.filter(([name]) => name !== "get_hub_status");
const identity = { userId: "7", sessionId: "guard-resolved", expiresAt: new Date("2099-01-01") };
describe.skipIf(!HAS_TEST_DATABASE)("query named security proofs (isolated PostgreSQL, contractual doubles)", () => {
	let db: IsolatedTestDatabase;
	let repository: PostgresMessageReadRepository;
	let status: GuildRegistryStatus | "throw" = "current";
	const registry = {
		execute: vi.fn(async ({ userId }: { userId: string }) => ({
			guildId: "1",
			channels:
				userId === "7"
					? [
							{
								channelId: "10",
								channelType: "public-thread" as const,
								isThread: true,
								parentChannelId: "9",
								name: "live",
								position: 0,
								canReadMessageHistory: true
							}
						]
					: []
		}))
	};
	let adapter: QueryToolsAdapter;
	function call(name: QueryToolName, args: Record<string, unknown>, userId = "7") {
		return adapter.handle(
			{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
			{ ...identity, userId }
		);
	}
	beforeAll(async () => {
		db = await openIsolatedTestDatabase("query_security");
	});
	afterAll(async () => {
		await db?.close();
	});
	beforeEach(async () => {
		status = "current";
		registry.execute.mockClear();
		await db.resetMessageStore();
		await db.pool
			.query(`INSERT INTO message (message_id,guild_id,channel_id,author_id,message_type,content,created_instant,deleted_at) VALUES
 (100,1,10,7,'default','one','2026-01-01',NULL), (101,1,10,7,'default',NULL,'2026-01-02','2026-01-03'),
 (102,1,10,7,'default','two','2026-01-03',NULL), (103,1,20,7,'default','private','2026-01-04',NULL),
 (104,1,30,7,'default','deleted parent thread','2026-01-05',NULL)`);
		repository = new PostgresMessageReadRepository(db.executor);
		adapter = new QueryToolsAdapter(
			queryToolFixture(
				repository,
				registry,
				{
					execute: async (input) => ({
						retrieval: "hybrid",
						candidates: ["100", "101", "102", "103", "104"]
							.map((messageId, i) => ({
								messageId,
								channelId: i > 2 ? "20" : "10",
								parentChannelId: "9",
								createdAt: "2026-01-01T00:00:00Z",
								rank: 1 - i / 100
							}))
							.filter((row) => input.accessibleChannelIds.includes(row.channelId))
					})
				},
				botViewsChannels(["10"]),
				{
					execute: async () => {
						if (status === "throw") throw new Error("status db");
						return { guildId: "1", status };
					}
				}
			)
		);
	});
	it("impersonation-argument-rejected", async () => {
		const read = vi.spyOn(repository, "readPage");
		const window = vi.spyOn(repository, "readWindow");
		const candidates = vi.spyOn(repository, "readCandidates");
		const activityPage = vi.spyOn(repository, "readActivityPage");
		const activityCount = vi.spyOn(repository, "countWindowMessages");
		const activityAnchor = vi.spyOn(repository, "readMyLastMessageAt");
		for (const [name, args] of calls)
			expect(await call(name, { ...args, discord_user_id: "8" })).toMatchObject({
				result: { isError: true, structuredContent: { data: [], error: { code: "invalid_input" } } }
			});
		expect(registry.execute).not.toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
		expect(window).not.toHaveBeenCalled();
		expect(candidates).not.toHaveBeenCalled();
		expect(activityPage).not.toHaveBeenCalled();
		expect(activityCount).not.toHaveBeenCalled();
		expect(activityAnchor).not.toHaveBeenCalled();
	});
	it("acl-no-existence-signal", async () => {
		for (const [name, field, existing] of [
			["search_messages", "channelId", "20"],
			["get_channel_history", "channelId", "20"],
			["get_thread_messages", "threadId", "30"],
			["get_message_context", "messageId", "103"]
		] as const) {
			const args = name === "search_messages" ? { query: "one" } : {};
			expect(await call(name, { ...args, [field]: existing })).toEqual(
				await call(name, { ...args, [field]: "999" })
			);
		}
		expect(await call("list_channels", {}, "8")).toEqual(await call("list_channels", {}, "9"));
		// R17: the seventh tool takes part in this sweep as a count, never as a listing — the same hub
		// answers 1 for the Requester who can view #10 and 0 for a User who can view nothing (R2's
		// evaluation), and it never mentions a container, so it cannot confirm one either.
		expect(await call("get_hub_status", {}, "7")).toMatchObject({
			result: { structuredContent: { mirror: { visibleAndMirroredChannelCount: 1 } } }
		});
		expect(await call("get_hub_status", {}, "8")).toMatchObject({
			result: { structuredContent: { mirror: { visibleAndMirroredChannelCount: 0 } } }
		});
		// R14's digest answers a container the Requester cannot read exactly as it answers one that never
		// existed: same empty digest, same reported window.
		expect(await call("get_recent_activity", { channelId: "20", since: "2026-01-01T00:00:00Z" })).toEqual(
			await call("get_recent_activity", { channelId: "999", since: "2026-01-01T00:00:00Z" })
		);
	});
	it("acl-before-fusion", async () => {
		// R17's status tool is outside this sweep by construction: it has no retrieval path and no container
		// field, so there is no candidate list to filter. Its own R2/R3 evidence is `query-hub-status`.
		const execute = vi.fn(async (input: { accessibleChannelIds: readonly string[] }) => {
			expect(input.accessibleChannelIds).toEqual(["10"]);
			return {
				retrieval: "hybrid" as const,
				candidates: [
					{
						messageId: "103",
						channelId: "20",
						parentChannelId: null,
						createdAt: "2026-01-01T00:00:00Z",
						rank: 99
					}
				]
			};
		});
		adapter = new QueryToolsAdapter(queryToolFixture(repository, registry, { execute }, botViewsChannels(["10"])));
		expect(await call("search_messages", { query: "private" })).toMatchObject({
			result: { structuredContent: { data: [] } }
		});
		expect(execute).toHaveBeenCalledTimes(1);
	});
	it("tombstone-never-returned", async () => {
		for (const [name, args] of calls) {
			const result = JSON.stringify(await call(name, args));
			for (const hidden of ["101", "103", "104", "private", "deleted parent thread"])
				expect(result).not.toContain(hidden);
		}
		for (const messageId of ["101", "103", "104"])
			expect(await call("get_message_context", { messageId })).toMatchObject({
				result: { isError: false, structuredContent: { data: [] } }
			});
	});
	it("pagination-keyset-stability", async () => {
		const first = await repository.readPage({
			guildId: "1",
			accessibleChannelIds: ["10"],
			channelId: "10",
			pageSize: 1
		});
		// R13: recent-first, so the newest accessible message leads the channel.
		expect(first.map((row) => row.messageId)).toEqual(["102", "100"]);
		await db.pool.query(
			`INSERT INTO message (message_id,guild_id,channel_id,author_id,message_type,content,created_instant) VALUES (105,1,10,7,'default','new','2026-01-06')`
		);
		// Backward continuation from #102 never reaches the newer row, and a fresh read now starts there.
		expect(
			(
				await repository.readPage({
					guildId: "1",
					accessibleChannelIds: ["10"],
					channelId: "10",
					pageSize: 2,
					before: { messageId: "102", createdAt: "2026-01-03T00:00:00Z" }
				})
			).map((row) => row.messageId)
		).toEqual(["100"]);
		expect(
			(
				await repository.readPage({
					guildId: "1",
					accessibleChannelIds: ["10"],
					channelId: "10",
					pageSize: 1
				})
			).map((row) => row.messageId)
		).toEqual(["105", "102"]);
	});
	it("registry-not-current-refusal", async () => {
		const read = vi.spyOn(repository, "readPage");
		const window = vi.spyOn(repository, "readWindow");
		const candidates = vi.spyOn(repository, "readCandidates");
		const activityPage = vi.spyOn(repository, "readActivityPage");
		const activityCount = vi.spyOn(repository, "countWindowMessages");
		const activityAnchor = vi.spyOn(repository, "readMyLastMessageAt");
		for (const value of ["stale", "incomplete", "unavailable", "throw"] as const) {
			status = value;
			for (const [name, args] of gatedCalls)
				expect(await call(name, args)).toMatchObject({
					result: {
						isError: true,
						structuredContent: { data: [], error: { code: "state_unavailable", retryable: true } }
					}
				});
			// R17: the seventh tool is outside this refusal sweep. A non-current status is its answer, so it
			// reports the status with O12's null count (never `state_unavailable`); only an unreadable status
			// is a failure, and then it is `internal_error` because it cannot report a status it failed to read.
			expect(await call("get_hub_status", {})).toMatchObject(
				value === "throw"
					? { result: { isError: true, structuredContent: { error: { code: "internal_error" } } } }
					: {
							result: {
								isError: false,
								structuredContent: {
									registry: { status: value },
									mirror: { visibleAndMirroredChannelCount: null }
								}
							}
						}
			);
		}
		expect(registry.execute).not.toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
		expect(window).not.toHaveBeenCalled();
		expect(candidates).not.toHaveBeenCalled();
		expect(activityPage).not.toHaveBeenCalled();
		expect(activityCount).not.toHaveBeenCalled();
		expect(activityAnchor).not.toHaveBeenCalled();
		status = "current";
		expect(await call("get_channel_history", { channelId: "10" })).toMatchObject({ result: { isError: false } });
	});
	it("read-only: all seven tools twice leave stored rows and contractual registry state identical", async () => {
		const snapshot = async () =>
			(
				await db.pool.query(
					`SELECT md5(string_agg(row_to_json(m)::text, '' ORDER BY message_id)) AS hash, count(*)::integer AS count FROM message m`
				)
			).rows;
		const before = await snapshot();
		const registryBefore = await registry.execute({ userId: "7" });
		for (let i = 0; i < 2; i++) for (const [name, args] of calls) await call(name, args);
		expect(await snapshot()).toEqual(before);
		expect(await registry.execute({ userId: "7" })).toEqual(registryBefore);
	});
});
