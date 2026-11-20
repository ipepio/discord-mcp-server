import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresMessageReadRepository } from "../../src/features/query/repositories/postgres-message-read.repository.js";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";
import { botViewsChannels, queryToolFixture } from "./query-tool-fixture.js";

describe.skipIf(!HAS_TEST_DATABASE)("query message reads", () => {
	let db: IsolatedTestDatabase;
	let repository: PostgresMessageReadRepository;
	const scope = { guildId: "1", accessibleChannelIds: ["10"] };
	beforeAll(async () => {
		db = await openIsolatedTestDatabase("query_reads");
		repository = new PostgresMessageReadRepository(db.executor);
	});
	afterAll(async () => {
		await db?.close();
	});
	beforeEach(async () => {
		await db.resetMessageStore();
		await db.pool
			.query(`INSERT INTO message (message_id,guild_id,channel_id,author_id,message_type,content,created_instant,deleted_at)
 VALUES (100,1,10,7,'default','one','2026-01-01',NULL),
 (101,1,10,7,'default',NULL,'2026-01-02','2026-01-03'),
 (102,1,10,7,'default','two','2026-01-03',NULL),
 (103,1,20,7,'default','private or deleted channel','2026-01-04',NULL)`);
	});
	it("tombstone-never-returned: all five tools with real message repositories", async () => {
		const tools = queryToolFixture(
			repository,
			{
				execute: async () => ({
					guildId: "1",
					channels: [
						{
							channelId: "10",
							channelType: "public-thread",
							isThread: true,
							parentChannelId: "9",
							name: "live thread",
							position: 0,
							canReadMessageHistory: true
						}
					]
				})
			},
			{
				execute: async () => ({
					retrieval: "full-text-only",
					candidates: ["100", "101", "102", "103"].map((messageId, i) => ({
						messageId,
						channelId: "10",
						parentChannelId: "9",
						createdAt: "2026-01-01T00:00:00Z",
						rank: 1 - i / 100
					}))
				})
			},
			botViewsChannels(["10"])
		);
		const input = {
			pageSize: 20,
			windowSize: 20,
			userId: "7",
			channelId: "10",
			threadId: "10",
			messageId: "100",
			query: "one"
		};
		// R13: the two traversal tools are recent-first; the two tools R13 leaves alone keep ascending/rank order.
		for (const tool of [tools.search_messages, tools.get_message_context]) {
			const result = await tool.execute(input);
			expect(result.data.map((row) => ("messageId" in row ? row.messageId : ""))).toEqual(["100", "102"]);
		}
		for (const tool of [tools.get_channel_history, tools.get_thread_messages]) {
			const result = await tool.execute(input);
			expect(result.data.map((row) => ("messageId" in row ? row.messageId : ""))).toEqual(["102", "100"]);
		}
		expect((await tools.list_channels.execute(input)).data).toHaveLength(1);
		for (const messageId of ["101", "103", "999"])
			expect(await tools.get_message_context.execute({ ...input, messageId })).toEqual({ data: [] });
	});
	it("pagination-keyset-stability", async () => {
		const first = await repository.readPage({ ...scope, channelId: "10", pageSize: 1 });
		// R13: recent-first, so the newest stored message leads and the one-row probe rides along.
		expect(first.map((row) => row.messageId)).toEqual(["102", "100"]);
		await db.pool.query(
			`INSERT INTO message (message_id,guild_id,channel_id,author_id,message_type,content,created_instant) VALUES (104,1,10,7,'default','new','2026-01-05')`
		);
		// A row created after the cursor's key never shifts the older page that cursor describes.
		const next = await repository.readPage({
			...scope,
			channelId: "10",
			pageSize: 2,
			before: { createdAt: "2026-01-03T00:00:00.000Z", messageId: "102" }
		});
		expect(next.map((row) => row.messageId)).toEqual(["100"]);
		expect(
			(await repository.readPage({ ...scope, channelId: "10", pageSize: 1 })).map((row) => row.messageId)
		).toEqual(["104", "102"]);
	});
	it("tombstone-never-returned: every repository operation also excludes deleted containers", async () => {
		expect(await repository.readPage({ ...scope, channelId: "20", pageSize: 20 })).toEqual([]);
		expect(
			(await repository.readCandidates({ ...scope, messageIds: ["100", "101", "102", "103"], pageSize: 20 })).map(
				(row) => row.messageId
			)
		).toEqual(["100", "102"]);
		expect(
			(await repository.readWindow({ ...scope, messageId: "100", windowSize: 5 })).map((row) => row.messageId)
		).toEqual(["100", "102"]);
		for (const messageId of ["101", "103", "999"])
			expect(await repository.readWindow({ ...scope, messageId, windowSize: 5 })).toEqual([]);
	});
});
