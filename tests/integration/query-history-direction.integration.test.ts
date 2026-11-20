import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryToolsAdapter } from "../../src/features/query/mcp/query-tools.adapter.js";
import { parseToolInput } from "../../src/features/query/models/dtos/tool-schema.dto.js";
import type { QueryToolName } from "../../src/features/query/models/domain/tool-input.js";
import { decodeCursor } from "../../src/features/query/queries/query-cursor.js";
import type { HybridRetrieval } from "../../src/features/query/queries/hybrid-retrieval.contract.js";
import type { RegistryAccessReader } from "../../src/features/query/queries/query-access.policy.js";
import { PostgresMessageReadRepository } from "../../src/features/query/repositories/postgres-message-read.repository.js";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";
import { botViewsChannels, queryToolFixture } from "./query-tool-fixture.js";

/**
 * R13 evidence — `get_channel_history` and `get_thread_messages` are recent-first (`createdAt DESC,
 * messageId DESC`) and every `nextCursor` walks backward toward the past; `from`/`to` stay inclusive bounds
 * whose newest end is returned first. O5's compatibility resolution is proven here too: a cursor minted under
 * the previous ascending contract is `invalid_input` with zero repository reads instead of silently
 * continuing into the wrong half of the channel.
 *
 * The two tools R13 leaves alone are this suite's PRESERVE cases: `get_message_context` still returns its
 * window in ascending `(createdAt, messageId)` order and `search_messages` still follows fused rank, both of
 * which a direction flip in the shared page read would silently reverse.
 *
 * Every read is the real PostgreSQL repository against rows this suite stores and `resetMessageStore`
 * removes between cases; nothing here asserts internal storage, only the page an agent receives.
 */

const GUILD_ID = "1";
const CHANNEL_ID = "10";
const THREAD_ID = "30";
const THREAD_PARENT_ID = "9";

const identity = { userId: "7", sessionId: "guard-resolved", expiresAt: new Date("2099-01-01") };

/** `2026-01-01T00:00:00Z` plus `day - 1` days: one stored message per day, so keyset order is legible. */
function at(day: number): string {
	return `2026-01-${String(day).padStart(2, "0")}T00:00:00.000Z`;
}
/** Message ids in a descending run, e.g. `descending(124, 105)` → `["124", …, "105"]`. */
function descending(first: number, last: number): readonly string[] {
	return Array.from({ length: first - last + 1 }, (_, index) => String(first - index));
}

type MessagePage = {
	readonly data: readonly { readonly messageId: string; readonly createdAt: string }[];
	readonly pagination: { readonly pageSize: number; readonly hasNext: boolean; readonly nextCursor: string | null };
};
function pageOf(result: unknown): MessagePage {
	return (result as { result: { structuredContent: MessagePage } }).result.structuredContent;
}

describe.skipIf(!HAS_TEST_DATABASE)("query history direction (R13, real PostgreSQL message store)", () => {
	let database: IsolatedTestDatabase;
	let repository: PostgresMessageReadRepository;
	let adapter: QueryToolsAdapter;
	const registry: RegistryAccessReader = {
		execute: async () => ({
			guildId: GUILD_ID,
			channels: [
				{
					channelId: CHANNEL_ID,
					channelType: "guild-text" as const,
					isThread: false,
					parentChannelId: null,
					name: "general",
					position: 0,
					canReadMessageHistory: true
				},
				{
					channelId: THREAD_ID,
					channelType: "public-thread" as const,
					isThread: true,
					parentChannelId: THREAD_PARENT_ID,
					name: "thread",
					position: 1,
					canReadMessageHistory: true
				}
			]
		})
	};
	const noCandidates: HybridRetrieval = { execute: async () => ({ retrieval: "hybrid", candidates: [] }) };

	beforeAll(async () => {
		database = await openIsolatedTestDatabase("query_history_direction");
		repository = new PostgresMessageReadRepository(database.executor);
	}, 180_000);
	afterAll(async () => {
		await database?.close();
		database = undefined as unknown as IsolatedTestDatabase;
	});
	beforeEach(async () => {
		await database.resetMessageStore();
		adapter = new QueryToolsAdapter(
			queryToolFixture(repository, registry, noCandidates, botViewsChannels([CHANNEL_ID, THREAD_ID]))
		);
	});

	/** One stored message per id, `created_instant` ascending with the id, `at(startDay)` for the first. */
	async function store(channelId: string, count: number, firstId: number, startDay: number): Promise<void> {
		await database.pool.query(
			`INSERT INTO message (message_id,guild_id,channel_id,author_id,message_type,content,created_instant)
 SELECT id, $1::bigint, $2::bigint, 7, 'default', 'content-' || id::text,
 $3::timestamptz + ((ordinality - 1) * interval '1 day')
 FROM UNNEST($4::bigint[]) WITH ORDINALITY AS t(id, ordinality)`,
			[GUILD_ID, channelId, at(startDay), Array.from({ length: count }, (_, index) => String(firstId + index))]
		);
	}
	function call(name: QueryToolName, args: Record<string, unknown>) {
		return adapter.handle(
			{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
			identity
		);
	}

	it("history-newest-first-default: no from/to/cursor returns the newest messages and a backward key", async () => {
		await store(CHANNEL_ID, 25, 100, 1);

		const result = pageOf(await call("get_channel_history", { channelId: CHANNEL_ID, pageSize: 20 }));

		expect(result.pagination).toMatchObject({ pageSize: 20, hasNext: true });
		expect(result.data.map((row) => row.messageId)).toEqual(descending(124, 105));
		expect(result.data[0]?.createdAt).toBe(at(25));

		const cursor = result.pagination.nextCursor;
		if (!cursor) throw new Error("missing cursor");
		// R13: the key is the LAST row returned — the newest end of the next, strictly older page.
		expect(
			decodeCursor("get_channel_history", {
				...parseToolInput("get_channel_history", { channelId: CHANNEL_ID, pageSize: 20 }),
				cursor
			})
		).toEqual({ createdAt: at(6), messageId: "105" });
		// O5's discriminator is in the envelope, so a pre-flip cursor cannot decode (R13's cursor semantics).
		const envelope: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		expect(Object.keys(envelope as object).sort()).toEqual(["binding", "direction", "key", "tool", "version"]);
		expect(envelope).toMatchObject({
			version: 1,
			tool: "get_channel_history",
			direction: "backward",
			key: { createdAt: at(6), messageId: "105" }
		});
	});

	it("history-backward-pagination: every page is strictly older, with no repeat and no skip", async () => {
		await store(CHANNEL_ID, 12, 100, 1);

		const first = pageOf(await call("get_channel_history", { channelId: CHANNEL_ID, pageSize: 5 }));
		expect(first.data.map((row) => row.messageId)).toEqual(descending(111, 107));
		expect(first.pagination.hasNext).toBe(true);

		// Concurrent inserts land newer than the traversal's first key: a backward walk must never see them.
		await database.pool.query(
			`INSERT INTO message (message_id,guild_id,channel_id,author_id,message_type,content,created_instant)
 VALUES (200,$1::bigint,$2::bigint,7,'default','concurrent one','2026-02-01'),
 (201,$1::bigint,$2::bigint,7,'default','concurrent two','2026-02-02')`,
			[GUILD_ID, CHANNEL_ID]
		);

		const second = pageOf(
			await call("get_channel_history", {
				channelId: CHANNEL_ID,
				pageSize: 5,
				cursor: first.pagination.nextCursor
			})
		);
		expect(second.data.map((row) => row.messageId)).toEqual(descending(106, 102));

		const third = pageOf(
			await call("get_channel_history", {
				channelId: CHANNEL_ID,
				pageSize: 5,
				cursor: second.pagination.nextCursor
			})
		);
		expect(third.data.map((row) => row.messageId)).toEqual(descending(101, 100));
		// Final page: no older row inside the filter set.
		expect(third.pagination).toEqual({ pageSize: 5, hasNext: false, nextCursor: null });

		const rows = [...first.data, ...second.data, ...third.data];
		expect(rows.map((row) => row.messageId)).toEqual(descending(111, 100));
		expect(new Set(rows.map((row) => row.messageId)).size).toBe(12);
		for (let index = 1; index < rows.length; index++) {
			const previous = rows[index - 1];
			const current = rows[index];
			if (!previous || !current) throw new Error("missing row");
			expect(Date.parse(current.createdAt)).toBeLessThan(Date.parse(previous.createdAt));
		}
	});

	it("history-from-to-still-respected: the range is inclusive and its newest end comes first", async () => {
		await store(CHANNEL_ID, 10, 100, 1);

		const ranged = pageOf(
			await call("get_channel_history", {
				channelId: CHANNEL_ID,
				pageSize: 20,
				from: at(3),
				to: at(7)
			})
		);
		expect(ranged.data.map((row) => row.messageId)).toEqual(descending(106, 102));
		expect(ranged.data[0]?.createdAt).toBe(at(7));
		expect(ranged.data.at(-1)?.createdAt).toBe(at(3));
		expect(ranged.pagination).toEqual({ pageSize: 20, hasNext: false, nextCursor: null });

		// The cursor keeps walking backward inside the same range, not out of it.
		const firstPage = pageOf(
			await call("get_channel_history", { channelId: CHANNEL_ID, pageSize: 2, from: at(3), to: at(7) })
		);
		expect(firstPage.data.map((row) => row.messageId)).toEqual(["106", "105"]);
		const secondPage = pageOf(
			await call("get_channel_history", {
				channelId: CHANNEL_ID,
				pageSize: 2,
				from: at(3),
				to: at(7),
				cursor: firstPage.pagination.nextCursor
			})
		);
		expect(secondPage.data.map((row) => row.messageId)).toEqual(["104", "103"]);
		const thirdPage = pageOf(
			await call("get_channel_history", {
				channelId: CHANNEL_ID,
				pageSize: 2,
				from: at(3),
				to: at(7),
				cursor: secondPage.pagination.nextCursor
			})
		);
		expect(thirdPage.data.map((row) => row.messageId)).toEqual(["102"]);
		expect(thirdPage.pagination).toEqual({ pageSize: 2, hasNext: false, nextCursor: null });

		// An empty range is a valid empty page, never an error.
		const empty = await call("get_channel_history", { channelId: CHANNEL_ID, from: at(20), to: at(25) });
		expect(empty).toMatchObject({ result: { isError: false } });
		expect(pageOf(empty)).toEqual({ data: [], pagination: { pageSize: 20, hasNext: false, nextCursor: null } });

		// `from` later than `to` stays invalid_input, rejected before any read.
		expect(await call("get_channel_history", { channelId: CHANNEL_ID, from: at(7), to: at(3) })).toMatchObject({
			result: { isError: true, structuredContent: { data: [], error: { code: "invalid_input" } } }
		});
	});

	it("thread-newest-first-default: the thread page starts at its newest message", async () => {
		await store(THREAD_ID, 8, 300, 1);

		const result = pageOf(await call("get_thread_messages", { threadId: THREAD_ID, pageSize: 5 }));

		expect(result.data.map((row) => row.messageId)).toEqual(descending(307, 303));
		expect(result.pagination).toMatchObject({ pageSize: 5, hasNext: true });
		expect(result.data[0]?.createdAt).toBe(at(8));
		expect(result).toMatchObject({ threadId: THREAD_ID, parentChannelId: THREAD_PARENT_ID });

		const cursor = result.pagination.nextCursor;
		if (!cursor) throw new Error("missing cursor");
		expect(
			decodeCursor("get_thread_messages", {
				...parseToolInput("get_thread_messages", { threadId: THREAD_ID, pageSize: 5 }),
				cursor
			})
		).toEqual({ createdAt: at(4), messageId: "303" });
		const envelope: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		expect(envelope).toMatchObject({ tool: "get_thread_messages", direction: "backward" });
	});

	it("thread-backward-pagination: the thread cursor also walks toward its first message", async () => {
		await store(THREAD_ID, 8, 300, 1);

		const first = pageOf(await call("get_thread_messages", { threadId: THREAD_ID, pageSize: 3 }));
		expect(first.data.map((row) => row.messageId)).toEqual(descending(307, 305));

		const second = pageOf(
			await call("get_thread_messages", {
				threadId: THREAD_ID,
				pageSize: 3,
				cursor: first.pagination.nextCursor
			})
		);
		expect(second.data.map((row) => row.messageId)).toEqual(descending(304, 302));

		const third = pageOf(
			await call("get_thread_messages", {
				threadId: THREAD_ID,
				pageSize: 3,
				cursor: second.pagination.nextCursor
			})
		);
		expect(third.data.map((row) => row.messageId)).toEqual(descending(301, 300));
		expect(third.pagination).toEqual({ pageSize: 3, hasNext: false, nextCursor: null });

		const rows = [...first.data, ...second.data, ...third.data];
		expect(rows.map((row) => row.messageId)).toEqual(descending(307, 300));
		for (let index = 1; index < rows.length; index++) {
			const previous = rows[index - 1];
			const current = rows[index];
			if (!previous || !current) throw new Error("missing row");
			expect(Date.parse(current.createdAt)).toBeLessThan(Date.parse(previous.createdAt));
		}
	});

	it("legacy-ascending-cursor-rejected: a pre-flip cursor is invalid_input with zero repository reads", async () => {
		await store(CHANNEL_ID, 3, 100, 1);
		const read = vi.spyOn(repository, "readPage");

		/** Exactly what the ascending contract minted: `{ version, tool, binding, key }`, binding = tool + filters. */
		function ascendingCursor(tool: QueryToolName, filter: readonly (string | null)[], messageId: string): string {
			const binding = createHash("sha256")
				.update(JSON.stringify([tool, ...filter]))
				.digest("hex");
			return Buffer.from(
				JSON.stringify({ version: 1, tool, binding, key: { createdAt: at(1), messageId } })
			).toString("base64url");
		}

		for (const [tool, filterField, filterValue] of [
			["get_channel_history", "channelId", CHANNEL_ID],
			["get_thread_messages", "threadId", THREAD_ID]
		] as const) {
			const legacy = ascendingCursor(tool, [null, filterValue, null, null, null, null], "100");
			expect(await call(tool, { [filterField]: filterValue, cursor: legacy })).toMatchObject({
				result: { isError: true, structuredContent: { data: [], error: { code: "invalid_input" } } }
			});
		}
		expect(read).not.toHaveBeenCalled();

		// The rejection is the missing direction token, not the filter set: a cursor minted now continues.
		const current = pageOf(await call("get_channel_history", { channelId: CHANNEL_ID, pageSize: 1 }));
		const next = pageOf(
			await call("get_channel_history", {
				channelId: CHANNEL_ID,
				pageSize: 1,
				cursor: current.pagination.nextCursor
			})
		);
		expect(next.data.map((row) => row.messageId)).toEqual(["101"]);
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("context-window-stays-ascending (PRESERVE): the anchor window is still chronological", async () => {
		await store(CHANNEL_ID, 9, 400, 1);

		const result = (await call("get_message_context", { messageId: "404", windowSize: 5 })) as {
			result: {
				isError: boolean;
				structuredContent: {
					anchorMessageId?: string;
					data: readonly { readonly messageId: string; readonly createdAt: string }[];
				};
			};
		};

		expect(result.result.isError).toBe(false);
		expect(result.result.structuredContent.anchorMessageId).toBe("404");
		expect(result.result.structuredContent.data.map((row) => row.messageId)).toEqual([
			"402",
			"403",
			"404",
			"405",
			"406"
		]);
		expect(result.result.structuredContent.data.map((row) => row.createdAt)).toEqual([
			at(3),
			at(4),
			at(5),
			at(6),
			at(7)
		]);
	});

	it("search-rank-order-unchanged (PRESERVE): fused rank order, never created_instant order", async () => {
		await store(CHANNEL_ID, 3, 100, 1);
		const retrieval: HybridRetrieval = {
			execute: async () => ({
				retrieval: "hybrid",
				candidates: [
					{ messageId: "102", channelId: CHANNEL_ID, parentChannelId: null, createdAt: at(3), rank: 0.9 },
					{ messageId: "100", channelId: CHANNEL_ID, parentChannelId: null, createdAt: at(1), rank: 0.8 },
					{ messageId: "101", channelId: CHANNEL_ID, parentChannelId: null, createdAt: at(2), rank: 0.7 }
				]
			})
		};
		adapter = new QueryToolsAdapter(
			queryToolFixture(repository, registry, retrieval, botViewsChannels([CHANNEL_ID, THREAD_ID]))
		);

		const result = (await call("search_messages", { query: "content", pageSize: 20 })) as {
			result: {
				isError: boolean;
				structuredContent: { data: readonly { messageId: string }[]; retrieval: string };
			};
		};

		expect(result.result.isError).toBe(false);
		expect(result.result.structuredContent.retrieval).toBe("hybrid");
		// Neither ascending (100,101,102) nor descending (102,101,100) by instant: the rank says the order.
		expect(result.result.structuredContent.data.map((row) => row.messageId)).toEqual(["102", "100", "101"]);
	});
});
