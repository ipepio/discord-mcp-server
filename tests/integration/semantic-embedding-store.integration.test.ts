import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";
import { PostgresEmbeddingStoreRepository } from "../../src/features/semantic-index/repositories/postgres-embedding-store.repository.js";

import { EmbedPendingMessagesCommand } from "../../src/features/semantic-index/commands/embed-pending-messages.command.js";
import { StructuredLogger } from "../../src/shared/logging/structured-logger.js";

const vector = Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0));

describe.skipIf(!HAS_TEST_DATABASE)("semantic embedding store: isolated pgvector", () => {
	let database: IsolatedTestDatabase;
	let store: PostgresEmbeddingStoreRepository;
	beforeAll(async () => {
		database = await openIsolatedTestDatabase("semantic_store");
		store = new PostgresEmbeddingStoreRepository(database.executor);
	});
	afterAll(async () => {
		if (database) await database.close();
	});

	it("stores guarded per-message/model vectors and excludes stale, foreign-model, deleted and inaccessible rows", async () => {
		await database.pool.query(`INSERT INTO message
			(message_id, guild_id, channel_id, author_id, message_type, content, created_instant)
			VALUES (100, 1, 10, 2, 'default', 'searchable text', now()),
			(101, 1, 11, 2, 'default', 'secret text', now()),
			(102, 1, 10, 2, 'default', '', now())`);
		const pending = await store.fetchNextUnembedded("test-model", 64);
		expect(pending.map((row) => row.messageId)).toEqual(["100", "101"]);
		expect(
			await store.upsertBatch(
				"test-model",
				pending.map((row) => ({ ...row, embedding: vector }))
			)
		).toBe(2);
		expect(await store.fetchNextUnembedded("test-model", 64)).toEqual([]);
		const search = (model: string, accessibleChannelIds: readonly string[]) =>
			store.nearest({
				model,
				accessibleChannelIds,
				embedding: vector,
				limit: 10
			});
		expect((await search("test-model", ["10"])).map((row) => row.messageId)).toEqual(["100"]);
		expect(await search("foreign-model", ["10", "11"])).toEqual([]);
		expect(await search("test-model", [])).toEqual([]);
		await database.pool.query("UPDATE message SET content = 'edited text' WHERE message_id = 100");
		expect(await search("test-model", ["10"])).toEqual([]);
		expect(
			await store.upsertBatch(
				"test-model",
				pending.map((row) => ({ ...row, embedding: vector }))
			)
		).toBe(1);
		expect((await store.fetchNextUnembedded("test-model", 64)).map((row) => row.messageId)).toEqual(["100"]);
		await database.pool.query("UPDATE message SET content = NULL, deleted_at = now() WHERE message_id = 101");
		expect(await search("test-model", ["11"])).toEqual([]);
		const remaining = await database.pool.query("SELECT message_id FROM message_embeddings");
		expect(remaining.rows).toEqual([]); // Both edits and tombstones physically remove vectors.
		expect(await store.deleteByMessageIds(["100", "101"])).toBe(0);
		expect(await store.deleteByMessageIds(["100", "101"])).toBe(0);
	});

	it("guards an in-flight embedding against a concurrent stored edit or tombstone", async () => {
		await database.resetMessageStore();
		await database.pool.query(`INSERT INTO message
			(message_id, guild_id, channel_id, author_id, message_type, content, created_instant)
			VALUES (300, 1, 10, 2, 'default', 'original', now())`);
		const original = await store.fetchNextUnembedded("test-model", 1);
		await database.pool.query("UPDATE message SET content = 'new version' WHERE message_id = 300");
		expect(
			await store.upsertBatch(
				"test-model",
				original.map((row) => ({ ...row, embedding: vector }))
			)
		).toBe(0);
		const edited = await store.fetchNextUnembedded("test-model", 1);
		expect(
			await store.upsertBatch(
				"test-model",
				edited.map((row) => ({ ...row, embedding: vector }))
			)
		).toBe(1);
		// A no-op guarded ingestion update must not invalidate a current vector.
		await database.pool.query("UPDATE message SET content = content WHERE message_id = 300");
		expect(await store.fetchNextUnembedded("test-model", 1)).toEqual([]);
		await database.pool.query("UPDATE message SET content = NULL, deleted_at = now() WHERE message_id = 300");
		expect(
			await store.upsertBatch(
				"test-model",
				edited.map((row) => ({ ...row, embedding: vector }))
			)
		).toBe(0);
		expect((await database.pool.query("SELECT message_id FROM message_embeddings")).rows).toEqual([]);
	});

	it("FTS remains reachable during outage, and a fresh worker catches up after restart", async () => {
		await database.resetMessageStore();
		await database.pool.query(`INSERT INTO message
			(message_id, guild_id, channel_id, author_id, message_type, content, created_instant)
			SELECT n, 1, 10, 2, 'default', 'catchup message', now() FROM generate_series(200, 269) n`);
		let outage = true;
		const provider = {
			model: "test-model",
			embed: async (texts: readonly string[]) => {
				if (outage) throw new Error("private provider error");
				return texts.map(() => vector);
			}
		};
		const logger = new StructuredLogger("error", () => {});
		expect((await new EmbedPendingMessagesCommand(store, provider, logger).execute()).paused).toBe(true);
		const fts = await database.pool.query<{ count: string }>(`SELECT count(*) FROM message
			WHERE to_tsvector('simple', content) @@ plainto_tsquery('simple', 'catchup')`);
		expect(fts.rows[0]?.count).toBe("70");
		outage = false;
		const resumed = new EmbedPendingMessagesCommand(store, provider, logger);
		expect((await resumed.execute()).stored).toBe(64);
		expect((await resumed.execute()).stored).toBe(6);
		expect((await resumed.execute()).examined).toBe(0);
	});
});
