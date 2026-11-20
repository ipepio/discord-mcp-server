import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";
import { RetrieveHybridCandidatesQuery } from "../../src/features/semantic-index/queries/retrieve-hybrid-candidates.query.js";
import { PostgresEmbeddingStoreRepository } from "../../src/features/semantic-index/repositories/postgres-embedding-store.repository.js";
import { PostgresFullTextCandidatesRepository } from "../../src/features/semantic-index/repositories/postgres-full-text-candidates.repository.js";
import { PostgresMessageReadRepository } from "../../src/features/query/repositories/postgres-message-read.repository.js";
import type { HybridRetrieval } from "../../src/features/query/index.js";
import { botViewsChannels, queryToolFixture } from "./query-tool-fixture.js";
const vector = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0));

describe.skipIf(!HAS_TEST_DATABASE)("query with the real hybrid producer", () => {
	let db: IsolatedTestDatabase;
	beforeAll(async () => {
		db = await openIsolatedTestDatabase("query_real_hybrid");
		await db.pool
			.query(`INSERT INTO message (message_id,guild_id,channel_id,author_id,message_type,content,created_instant) VALUES
		(100,1,10,7,'default','hello','2026-01-01'), (101,1,10,8,'default','hello','2026-01-02'),
		(102,1,20,7,'default','hello','2026-01-02'), (103,1,10,7,'default','hello','2026-01-03')`);
		const store = new PostgresEmbeddingStoreRepository(db.executor);
		const pending = await store.fetchNextUnembedded("test-model", 64);
		await store.upsertBatch(
			"test-model",
			pending.map((row) => ({ ...row, embedding: vector }))
		);
	});
	afterAll(async () => {
		await db?.close();
	});
	it("filters both SQL branches before ranking and paginates through the public query", async () => {
		const store = new PostgresEmbeddingStoreRepository(db.executor);
		const fts = new PostgresFullTextCandidatesRepository(db.executor);
		const filters = { channelIds: ["10"], authorId: "7", from: new Date("2026-01-02"), to: new Date("2026-01-04") };
		expect((await fts.search("hello", ["10", "20"], 64, filters)).map((row) => row.messageId)).toEqual(["103"]);
		expect(
			(
				await store.nearest({
					model: "test-model",
					embedding: vector,
					accessibleChannelIds: ["10", "20"],
					limit: 64,
					...filters
				})
			).map((row) => row.messageId)
		).toEqual(["103"]);
		// This assignment is also the compile-time proof that the producer satisfies query's public seam.
		const retrieval: HybridRetrieval = new RetrieveHybridCandidatesQuery(fts, store, {
			model: "test-model",
			embed: async () => [vector]
		});
		const tools = queryToolFixture(
			new PostgresMessageReadRepository(db.executor),
			{
				execute: async () => ({
					guildId: "1",
					channels: [
						{
							channelId: "10",
							channelType: "guild-text",
							isThread: false,
							parentChannelId: null,
							name: "live",
							position: 0,
							canReadMessageHistory: true
						}
					]
				})
			},
			retrieval,
			botViewsChannels(["10"])
		);
		const input = { userId: "7", query: "hello", authorId: "7", pageSize: 1, windowSize: 20 };
		const first = await tools.search_messages.execute(input);
		expect(first.data).toEqual([expect.objectContaining({ messageId: "100" })]);
		const second = await tools.search_messages.execute({ ...input, cursor: first.pagination!.nextCursor! });
		expect(second.data).toEqual([expect.objectContaining({ messageId: "103" })]);
		expect(second.pagination?.hasNext).toBe(false);
	});
});
