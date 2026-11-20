import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";
import { PostgresEmbeddingStoreRepository } from "../../src/features/semantic-index/repositories/postgres-embedding-store.repository.js";
import { PostgresFullTextCandidatesRepository } from "../../src/features/semantic-index/repositories/postgres-full-text-candidates.repository.js";
import { RetrieveHybridCandidatesQuery } from "../../src/features/semantic-index/queries/retrieve-hybrid-candidates.query.js";

const vector = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));

describe.skipIf(!HAS_TEST_DATABASE)("hybrid retrieval ACL invariants: real pgvector", () => {
	let database: IsolatedTestDatabase;
	let store: PostgresEmbeddingStoreRepository;
	let fts: PostgresFullTextCandidatesRepository;
	beforeAll(async () => {
		database = await openIsolatedTestDatabase("semantic_hybrid");
		store = new PostgresEmbeddingStoreRepository(database.executor);
		fts = new PostgresFullTextCandidatesRepository(database.executor);
		await database.pool.query(`INSERT INTO message
			(message_id, guild_id, channel_id, author_id, message_type, content, created_instant)
			VALUES (100, 1, 10, 2, 'default', 'hello accessible', now()),
			(101, 1, 11, 2, 'default', 'hello secret', now()),
			(102, 1, 10, 2, 'default', 'hello unembedded', now()),
			(103, 1, 12, 2, 'default', 'hello private thread', now())`);
		const pending = await store.fetchNextUnembedded("pinned-model", 64);
		await store.upsertBatch(
			"pinned-model",
			pending.filter((row) => row.messageId !== "102").map((row) => ({ ...row, embedding: vector }))
		);
	});
	afterAll(async () => {
		if (database) await database.close();
	});

	it("I1/I2: both branches enforce live ACL sets before fusion and contain no permission-baked vectors", async () => {
		expect((await fts.search("hello", ["10"], 64)).map((row) => row.messageId)).toEqual(["100", "102"]);
		expect(
			(
				await store.nearest({
					model: "pinned-model",
					embedding: vector,
					accessibleChannelIds: ["10"],
					limit: 64
				})
			).map((row) => row.messageId)
		).toEqual(["100"]);
		const provider = { model: "pinned-model", embed: async () => [vector] };
		const query = new RetrieveHybridCandidatesQuery(fts, store, provider);
		expect(
			(await query.execute({ text: "hello", accessibleChannelIds: ["10"], limit: 64 })).candidates.map(
				(row) => row.messageId
			)
		).toEqual(["100", "102"]);
		// Revocation/grant changes only the query-time set, never an embedding or index.
		expect(
			(await query.execute({ text: "hello", accessibleChannelIds: ["11"], limit: 64 })).candidates.map(
				(row) => row.messageId
			)
		).toEqual(["101"]);
		expect((await query.execute({ text: "hello", accessibleChannelIds: [], limit: 64 })).candidates).toEqual([]);
	});

	it("I3: vector storage is per-message only, fixed-dimension and contains no ACL or derived artifacts", async () => {
		const columns = await database.pool.query<{ column_name: string }>(`SELECT column_name
			FROM information_schema.columns WHERE table_name = 'message_embeddings' ORDER BY ordinal_position`);
		expect(columns.rows.map((row) => row.column_name)).toEqual([
			"message_id",
			"model",
			"content_revision",
			"embedding"
		]);
		const type = await database.pool.query<{ type: string }>(`SELECT format_type(atttypid, atttypmod) AS type
			FROM pg_attribute WHERE attrelid = 'message_embeddings'::regclass AND attname = 'embedding'`);
		expect(type.rows[0]?.type).toBe("vector(1536)");
		const constraints = await database.pool.query<{
			definition: string;
		}>(`SELECT pg_get_constraintdef(oid) AS definition
			FROM pg_constraint WHERE conrelid = 'message_embeddings'::regclass`);
		expect(constraints.rows.some((row) => row.definition.includes("PRIMARY KEY (message_id, model)"))).toBe(true);
		expect(constraints.rows.some((row) => row.definition.includes("REFERENCES message(message_id)"))).toBe(true);
		const indexes = await database.pool.query<{ indexdef: string }>(
			"SELECT indexdef FROM pg_indexes WHERE tablename = 'message_embeddings'"
		);
		expect(indexes.rows.some((row) => row.indexdef.includes("USING hnsw"))).toBe(true);
	});

	it("FTS defaults to Spanish and supports an explicitly selected dictionary", async () => {
		await database.pool.query(`INSERT INTO message
			(message_id, guild_id, channel_id, author_id, message_type, content, created_instant)
			VALUES (104, 1, 20, 2, 'default', 'perros', now())`);
		expect((await fts.search("perro", ["20"], 10)).map((row) => row.messageId)).toEqual(["104"]);
		expect(
			await new PostgresFullTextCandidatesRepository(database.executor, "simple").search("perro", ["20"], 10)
		).toEqual([]);
	});

	it("I4: every over-fetch choice still filters private channels AND threads", async () => {
		for (const factor of [1, 2, 4]) {
			const query = new RetrieveHybridCandidatesQuery(
				fts,
				store,
				{ model: "pinned-model", embed: async () => [vector] },
				factor
			);
			const result = await query.execute({ text: "hello", accessibleChannelIds: ["10"], limit: 1 });
			expect(result.candidates).toHaveLength(1);
			expect(result.candidates[0]?.channelId).toBe("10");
		}
	});

	it("R6: foreign-model rows never join the configured vector branch", async () => {
		expect(
			await store.nearest({
				model: "foreign-model",
				embedding: vector,
				accessibleChannelIds: ["10", "11", "12"],
				limit: 64
			})
		).toEqual([]);
	});

	it("R4: query-time tombstone exclusion is independent of physical vector cleanup", async () => {
		await database.pool.query("UPDATE message SET content = NULL, deleted_at = now() WHERE message_id = 100");
		// Deliberately emulate delayed cleanup: a vector exists for a tombstoned row.
		await database.pool.query("INSERT INTO message_embeddings VALUES (100, 'pinned-model', 'stale', $1::vector)", [
			JSON.stringify(vector)
		]);
		expect(
			await store.nearest({ model: "pinned-model", embedding: vector, accessibleChannelIds: ["10"], limit: 64 })
		).toEqual([]);
		expect((await fts.search("hello", ["10"], 64)).map((row) => row.messageId)).toEqual(["102"]);
	});
});
