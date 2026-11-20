import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryToolsAdapter } from "../../src/features/query/mcp/query-tools.adapter.js";
import { QueryPayloadPolicy } from "../../src/features/query/queries/query-payload.policy.js";
import { decodeCursor } from "../../src/features/query/queries/query-cursor.js";
import { parseToolInput } from "../../src/features/query/models/dtos/tool-schema.dto.js";
import type { QueryChannel, RegistryAccessReader } from "../../src/features/query/queries/query-access.policy.js";
import { PostgresMessageReadRepository } from "../../src/features/query/repositories/postgres-message-read.repository.js";
import type { QuerySqlExecutor } from "../../src/features/query/repositories/postgres-message-read.repository.js";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";
import { botViewsChannels, queryToolFixture } from "./query-tool-fixture.js";

/**
 * R14 evidence — `get_recent_activity` is the one-call multi-channel novelty digest: the window it decided
 * (`since` / the Requester's own last message / the 24-hour default), the R12 intersection it is scoped to,
 * and the grouped envelope with per-group counts and backward cursors that continue exactly like
 * `get_channel_history`.
 *
 * Every read is the real PostgreSQL repository against rows this suite stores and `resetMessageStore`
 * removes between cases, and `now` comes from an injected clock so a 24-hour window is asserted as a bound
 * rather than as "whatever the machine thinks today is".
 *
 * O4's outcome is visible here: the registry evidence for a category linkage stayed thin, so the digest is
 * channel-scoped and this suite asserts that `categoryId` is an unsupported field rather than guessing a
 * parent-type mapping.
 */

const GUILD_ID = "1";
const NOW = "2026-03-10T12:00:00.000Z";
const identity = { userId: "7", sessionId: "guard-resolved", expiresAt: new Date("2099-01-01") } as const;

function channel(channelId: string, name: string, canReadMessageHistory = true): QueryChannel {
	return {
		channelId,
		channelType: "guild-text",
		isThread: false,
		parentChannelId: null,
		name,
		position: Number(channelId),
		canReadMessageHistory
	};
}
const GENERAL = channel("10", "general");
const BACKEND = channel("20", "backend");
/** Requester may read it, the bot cannot view it: outside R12's intersection. */
const BOT_BLIND = channel("30", "bot-blind");
/** The bot may view it, the Requester holds no READ_MESSAGE_HISTORY: outside the content gate. */
const HISTORY_DENIED = channel("40", "history-denied", false);
/** Stored messages whose container the registry never lists: outside every axis. */
const UNREGISTERED = "35";
/** The bot views everything this suite's registry lists plus the history-denied channel. */
const BOT_VIEWS = ["10", "20", "40"];

/** `NOW` shifted by whole hours: one instants vocabulary for stores and assertions. */
function hoursBefore(hours: number, from = NOW): string {
	return new Date(Date.parse(from) - hours * 3_600_000).toISOString();
}

interface DigestGroup {
	readonly channelId: string;
	readonly channelName: string;
	readonly parentChannelId: string | null;
	readonly messageCount: number;
	readonly returnedCount: number;
	readonly messages: readonly { readonly messageId: string; readonly createdAt: string }[];
	readonly pagination: { readonly pageSize: number; readonly hasNext: boolean; readonly nextCursor: string | null };
}
interface Digest {
	readonly data: readonly DigestGroup[];
	readonly window: { readonly since: string | null; readonly anchor: string };
}

describe.skipIf(!HAS_TEST_DATABASE)("query recent activity digest (R14, real PostgreSQL message store)", () => {
	let database: IsolatedTestDatabase;
	let repository: PostgresMessageReadRepository;
	let adapter: QueryToolsAdapter;
	let statements: string[];
	let clock = NOW;
	const registry: RegistryAccessReader = {
		execute: async () => ({
			guildId: GUILD_ID,
			channels: [GENERAL, BACKEND, BOT_BLIND, HISTORY_DENIED]
		})
	};

	beforeAll(async () => {
		database = await openIsolatedTestDatabase("query_recent_activity");
	}, 180_000);
	afterAll(async () => {
		await database?.close();
		database = undefined as unknown as IsolatedTestDatabase;
	});
	beforeEach(async () => {
		await database.resetMessageStore();
		clock = NOW;
		statements = [];
		// The statement counter is a pass-through executor: it proves the digest's statement count is
		// independent of how many containers it digests, without re-implementing any read.
		const counting: QuerySqlExecutor = {
			query: async <Row>(sql: string, values: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }> => {
				statements.push(sql);
				return database.executor.query<Row>(sql, values);
			}
		};
		repository = new PostgresMessageReadRepository(counting);
		buildAdapter({});
	});
	function buildAdapter(extras: { payload?: QueryPayloadPolicy; clock?: () => Date }): void {
		adapter = new QueryToolsAdapter(
			queryToolFixture(
				repository,
				registry,
				{ execute: async () => ({ retrieval: "hybrid", candidates: [] }) },
				botViewsChannels(BOT_VIEWS),
				undefined,
				{
					clock: extras.clock ?? (() => new Date(clock)),
					...(extras.payload ? { payload: extras.payload } : {})
				}
			)
		);
	}
	function call(args: Record<string, unknown>) {
		return adapter.handle(
			{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_recent_activity", arguments: args } },
			identity
		);
	}
	async function digest(args: Record<string, unknown>): Promise<Digest> {
		return ((await call(args)) as { result: { structuredContent: Digest } }).result.structuredContent;
	}
	async function store(
		rows: readonly {
			readonly id: string;
			readonly channelId: string;
			readonly createdAt: string;
			readonly authorId?: string;
			readonly content?: string;
			readonly deletedAt?: string;
		}[]
	): Promise<void> {
		for (const row of rows) {
			await database.pool.query(
				`INSERT INTO message (message_id,guild_id,channel_id,author_id,message_type,content,created_instant,deleted_at)
 VALUES ($1::bigint,$2::bigint,$3::bigint,$4::bigint,'default',
 CASE WHEN $7::timestamptz IS NULL THEN $5 ELSE NULL END,$6::timestamptz,$7::timestamptz)`,
				[
					row.id,
					GUILD_ID,
					row.channelId,
					row.authorId ?? "7",
					row.content ?? `content-${row.id}`,
					row.createdAt,
					row.deletedAt ?? null
				]
			);
		}
	}
	function ids(group: DigestGroup): readonly string[] {
		return group.messages.map((message) => message.messageId);
	}

	it("activity-default-24h-window: no window argument means the 24 hours before the injected now", async () => {
		clock = NOW;
		await store([
			{ id: "100", channelId: "10", createdAt: hoursBefore(25) },
			// Exactly on the inclusive lower bound: `now - 24h` belongs to the window.
			{ id: "101", channelId: "10", createdAt: hoursBefore(24) },
			{ id: "102", channelId: "10", createdAt: hoursBefore(1) },
			{ id: "200", channelId: "20", createdAt: hoursBefore(2) }
		]);

		const result = await digest({});

		expect(result.window).toEqual({ since: hoursBefore(24), anchor: "default-24h" });
		// Newest returned message first, channelId ascending as tie-breaker.
		expect(result.data.map((group) => group.channelId)).toEqual(["10", "20"]);
		const general = result.data[0];
		const backend = result.data[1];
		if (!general || !backend) throw new Error("missing group");
		expect(ids(general)).toEqual(["102", "101"]);
		expect(general).toMatchObject({
			channelName: "general",
			parentChannelId: null,
			messageCount: 2,
			returnedCount: 2
		});
		expect(general.pagination).toEqual({ pageSize: 20, hasNext: false, nextCursor: null });
		expect(ids(backend)).toEqual(["200"]);
		// Outside the window, and never a "too old" marker either: the row is simply not in the digest.
		expect(JSON.stringify(result)).not.toContain("100");
	});

	it("activity-since-window: an explicit since is the inclusive lower bound", async () => {
		await store([
			// One millisecond before the bound: outside it.
			{ id: "100", channelId: "10", createdAt: hoursBefore(3, "2026-03-10T11:59:59.999Z") },
			// Exactly on the bound: inside it.
			{ id: "101", channelId: "10", createdAt: hoursBefore(3) },
			{ id: "102", channelId: "10", createdAt: hoursBefore(1) }
		]);

		const result = await digest({ since: hoursBefore(3) });

		expect(result.window).toEqual({ since: hoursBefore(3), anchor: "since" });
		const group = result.data[0];
		if (!group) throw new Error("missing group");
		expect(ids(group)).toEqual(["102", "101"]);
		expect(group.messageCount).toBe(2);

		// One millisecond later excludes the boundary row and nothing else: the bound is inclusive of `since` alone.
		const later = await digest({ since: hoursBefore(3, "2026-03-10T12:00:00.501Z") });
		const laterGroup = later.data[0];
		if (!laterGroup) throw new Error("missing group");
		expect(ids(laterGroup)).toEqual(["102"]);
		expect(laterGroup.messageCount).toBe(1);
		expect(later.window).toEqual({ since: hoursBefore(3, "2026-03-10T12:00:00.501Z"), anchor: "since" });
	});

	it("activity-my-last-message-anchor: scoped and guild-wide, and the anchor message itself is included", async () => {
		await store([
			// The Requester's own messages: the older one in #general, the newer one in #backend.
			{ id: "300", channelId: "10", createdAt: hoursBefore(5), authorId: "7" },
			{ id: "301", channelId: "20", createdAt: hoursBefore(2), authorId: "7" },
			// Somebody else's newer messages, which the anchor must not pick up.
			{ id: "302", channelId: "10", createdAt: hoursBefore(1), authorId: "8" },
			{ id: "303", channelId: "20", createdAt: hoursBefore(1), authorId: "8" }
		]);

		const scoped = await digest({ channelId: "10", sinceByMyLastMessage: true });
		expect(scoped.window).toEqual({ since: hoursBefore(5), anchor: "my-last-message" });
		const general = scoped.data[0];
		if (!general) throw new Error("missing group");
		// Inclusive: the Requester's own last message in #general is the first row of the group.
		expect(ids(general)).toEqual(["302", "300"]);
		expect(scoped.data.map((group) => group.channelId)).toEqual(["10"]);

		const wide = await digest({ sinceByMyLastMessage: true });
		// The maximum across the mirrored set: #backend's message is newer than #general's.
		expect(wide.window).toEqual({ since: hoursBefore(2), anchor: "my-last-message" });
		expect(wide.data.map((group) => group.channelId)).toEqual(["10", "20"]);
		const wideGeneral = wide.data[0];
		const wideBackend = wide.data[1];
		if (!wideGeneral || !wideBackend) throw new Error("missing group");
		expect(ids(wideGeneral)).toEqual(["302"]);
		expect(ids(wideBackend)).toEqual(["303", "301"]);

		// O7: no stored message of this Requester means a valid empty digest, explicit about the anchor.
		const anchorless = await adapter.handle(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "get_recent_activity", arguments: { channelId: "10", sinceByMyLastMessage: true } }
			},
			{ ...identity, userId: "9" }
		);
		expect(anchorless).toMatchObject({
			result: {
				isError: false,
				structuredContent: { data: [], window: { since: null, anchor: "my-last-message" } }
			}
		});
	});

	it("activity-intersection-filtering: neither absent axis appears, not even as an empty group", async () => {
		await store([
			{ id: "100", channelId: "10", createdAt: hoursBefore(1) },
			{ id: "200", channelId: "30", createdAt: hoursBefore(1) },
			{ id: "300", channelId: "40", createdAt: hoursBefore(1) },
			{ id: "400", channelId: UNREGISTERED, createdAt: hoursBefore(1) }
		]);

		const result = await digest({});

		expect(result.data.map((group) => group.channelId)).toEqual(["10"]);
		const serialized = JSON.stringify(result);
		for (const hidden of ["30", "40", UNREGISTERED, "bot-blind", "history-denied", "200", "300", "400"])
			expect(serialized).not.toContain(hidden);
	});

	it("activity-grouped-shape: counts, per-group backward cursors, group order and bounded statements", async () => {
		// #general is the most recently active group: 12 messages, one per hour.
		await store(
			Array.from({ length: 12 }, (_, index) => ({
				id: String(100 + index),
				channelId: "10",
				createdAt: hoursBefore(12 - index)
			}))
		);
		// #backend is older activity, five messages, still inside the 24-hour default window.
		await store(
			Array.from({ length: 5 }, (_, index) => ({
				id: String(200 + index),
				channelId: "20",
				createdAt: hoursBefore(23 - index)
			}))
		);

		const first = await digest({ pageSize: 5 });
		expect(first.data.map((group) => group.channelId)).toEqual(["10", "20"]);
		const general = first.data[0];
		const backend = first.data[1];
		if (!general || !backend) throw new Error("missing group");
		expect(ids(general)).toEqual(["111", "110", "109", "108", "107"]);
		expect(general).toMatchObject({ messageCount: 12, returnedCount: 5 });
		expect(general.pagination).toMatchObject({ pageSize: 5, hasNext: true });
		expect(ids(backend)).toEqual(["204", "203", "202", "201", "200"]);
		expect(backend).toMatchObject({ messageCount: 5, returnedCount: 5 });
		expect(backend.pagination).toEqual({ pageSize: 5, hasNext: false, nextCursor: null });

		// The group cursor continues that container exactly like `get_channel_history`: strictly older rows,
		// and the count reported is the one the continuation can still reach, so `hasNext` stays exact.
		const second = await digest({ channelId: "10", pageSize: 5, cursor: general.pagination.nextCursor });
		const secondGeneral = second.data[0];
		if (!secondGeneral) throw new Error("missing group");
		expect(ids(secondGeneral)).toEqual(["106", "105", "104", "103", "102"]);
		expect(secondGeneral).toMatchObject({ messageCount: 7, returnedCount: 5 });
		expect(secondGeneral.pagination).toMatchObject({ pageSize: 5, hasNext: true });

		const third = await digest({ channelId: "10", pageSize: 5, cursor: secondGeneral.pagination.nextCursor });
		const thirdGeneral = third.data[0];
		if (!thirdGeneral) throw new Error("missing group");
		expect(ids(thirdGeneral)).toEqual(["101", "100"]);
		expect(thirdGeneral).toMatchObject({ messageCount: 2, returnedCount: 2 });
		expect(thirdGeneral.pagination).toEqual({ pageSize: 5, hasNext: false, nextCursor: null });

		const walked = [...ids(general), ...ids(secondGeneral), ...ids(thirdGeneral)];
		expect(walked).toEqual(Array.from({ length: 12 }, (_, index) => String(111 - index)));
		expect(new Set(walked).size).toBe(12);

		// The cursor is bound to this tool, this group and this window: another container is invalid_input.
		expect(await call({ channelId: "20", pageSize: 5, cursor: general.pagination.nextCursor })).toMatchObject({
			result: { isError: true, structuredContent: { data: [], error: { code: "invalid_input" } } }
		});

		// R14's bounded work: the statement count does not follow the number of digested containers.
		await database.resetMessageStore();
		await store([{ id: "500", channelId: "10", createdAt: hoursBefore(1) }]);
		statements = [];
		await digest({});
		const oneGroup = statements.length;
		await store([
			{ id: "501", channelId: "20", createdAt: hoursBefore(2) },
			// Outside the intersection: stored, and still not a group.
			{ id: "502", channelId: "30", createdAt: hoursBefore(3) }
		]);
		statements = [];
		const moreGroups = await digest({});
		expect(moreGroups.data.map((group) => group.channelId)).toEqual(["10", "20"]);
		expect(statements.length).toBe(oneGroup);
		expect(oneGroup).toBeLessThanOrEqual(3);
	});

	it("activity-grouped-shape: the byte cap empties the least recently active group and keeps it usable", async () => {
		const long = "x".repeat(4000);
		await store([
			{ id: "100", channelId: "10", createdAt: hoursBefore(1) },
			{ id: "101", channelId: "10", createdAt: hoursBefore(2) },
			{ id: "102", channelId: "10", createdAt: hoursBefore(3) },
			// Least recently active group, and the one message that cannot fit under the cap below.
			{ id: "200", channelId: "20", createdAt: hoursBefore(5), content: long }
		]);

		buildAdapter({ payload: new QueryPayloadPolicy({ maxMessageChars: 4000, maxResponseBytes: 1_000_000 }) });
		const generous = await digest({});
		const backend = generous.data[1];
		if (!backend) throw new Error("missing group");
		const backendMessageBytes = Buffer.byteLength(JSON.stringify(backend.messages), "utf8");
		// Room for the whole digest without #backend's one oversized message, plus the cursor that replaces it;
		// that message is ~4000 bytes, so it can never fit and #backend is emptied first.
		const cap = Buffer.byteLength(JSON.stringify(generous), "utf8") - backendMessageBytes + 1024 + 800;

		buildAdapter({ payload: new QueryPayloadPolicy({ maxMessageChars: 4000, maxResponseBytes: cap }) });
		const shortened = await digest({});
		// The response fits the cap, and the shortening is explicit: nothing was silently dropped.
		expect(Buffer.byteLength(JSON.stringify(shortened)) + 1024).toBeLessThanOrEqual(cap);
		expect(shortened.data.map((group) => group.channelId)).toEqual(["10", "20"]);
		const keptGeneral = shortened.data[0];
		const emptiedBackend = shortened.data[1];
		if (!keptGeneral || !emptiedBackend) throw new Error("missing group");
		expect(ids(keptGeneral)).toEqual(["100", "101", "102"]);
		expect(keptGeneral).toMatchObject({ messageCount: 3, returnedCount: 3, pagination: { hasNext: false } });
		expect(emptiedBackend).toMatchObject({ channelId: "20", messageCount: 1, returnedCount: 0 });
		expect(emptiedBackend.messages).toEqual([]);
		expect(emptiedBackend.pagination).toMatchObject({ pageSize: 20, hasNext: true });
		const cursor = emptiedBackend.pagination.nextCursor;
		if (!cursor) throw new Error("missing cursor");
		// A valid cursor: it decodes for this tool, this group and this window, and it is positioned at that
		// group's newest message rather than past it, so no message is skipped when the continuation runs.
		const key = decodeCursor("get_recent_activity", {
			...parseToolInput("get_recent_activity", { channelId: "20" }),
			cursor
		});
		expect(key?.createdAt).toBe(hoursBefore(5));
		expect(BigInt(key?.messageId ?? "0") >= 200n).toBe(true);

		// Usable: the same continuation the agent would send returns the group's message, newest first.
		buildAdapter({ payload: new QueryPayloadPolicy({ maxMessageChars: 4000, maxResponseBytes: 1_000_000 }) });
		const continued = await digest({ channelId: "20", cursor });
		const continuedBackend = continued.data[0];
		if (!continuedBackend) throw new Error("missing group");
		expect(ids(continuedBackend)).toEqual(["200"]);
	});

	it("activity-argument-conflicts: window and scope conflicts are invalid_input with zero reads", async () => {
		await store([{ id: "100", channelId: "10", createdAt: hoursBefore(1) }]);
		const read = vi.spyOn(repository, "readActivityPage");
		const count = vi.spyOn(repository, "countWindowMessages");
		const anchor = vi.spyOn(repository, "readMyLastMessageAt");

		for (const [args, field] of [
			[{ since: hoursBefore(2), sinceByMyLastMessage: true }, "since"],
			// O4: the category linkage stayed unproven, so `categoryId` is not in the contract at all and the
			// scope conflict never arises — the unsupported field is rejected before any read.
			[{ channelId: "10", categoryId: "9" }, "categoryId"],
			[{ since: "yesterday" }, "since"],
			[{ pageSize: 101 }, "pageSize"]
		] as const) {
			const response = await call(args);
			expect(response).toMatchObject({
				result: { isError: true, structuredContent: { data: [], error: { code: "invalid_input" } } }
			});
			expect(JSON.stringify(response)).toContain(field);
		}
		expect(read).not.toHaveBeenCalled();
		expect(count).not.toHaveBeenCalled();
		expect(anchor).not.toHaveBeenCalled();
	});

	it("activity-empty-scope: an unknown container is a valid empty digest, indistinguishable from a quiet one", async () => {
		await store([{ id: "200", channelId: "20", createdAt: hoursBefore(1) }]);
		clock = NOW;

		const unknown = await call({ channelId: "999" });
		const quiet = await call({ channelId: "10" });

		expect(unknown).toMatchObject({ result: { isError: false } });
		expect(((await quiet) as { result: { structuredContent: Digest } }).result.structuredContent).toEqual({
			data: [],
			window: { since: hoursBefore(24), anchor: "default-24h" }
		});
		expect((unknown as { result: { structuredContent: Digest } }).result.structuredContent).toEqual({
			data: [],
			window: { since: hoursBefore(24), anchor: "default-24h" }
		});

		// R6: a container whose only message is a tombstone is quiet too.
		await database.resetMessageStore();
		await store([{ id: "300", channelId: "10", createdAt: hoursBefore(1), deletedAt: hoursBefore(1) }]);
		expect(await digest({ channelId: "10" })).toEqual({
			data: [],
			window: { since: hoursBefore(24), anchor: "default-24h" }
		});
	});
});
