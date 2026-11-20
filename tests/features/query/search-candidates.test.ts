import { describe, expect, it, vi } from "vitest";
import { SearchCandidatesQuery } from "../../../src/features/query/queries/search-candidates.query.js";
import type { AppLogger } from "../../../src/shared/logging/logger.interface.js";
const logger: AppLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => logger };
const access = { guildId: "1", channels: [], accessibleChannelIds: ["10"] };
const input = { query: "hello", pageSize: 20, windowSize: 20 };
describe("hybrid retrieval consumption", () => {
	it("search-pagination: descending rank and numeric ascending message ID; corpus changes do not freeze traversal", async () => {
		const make = (messageId: string, rank: number) => ({
			messageId,
			rank,
			channelId: "10",
			parentChannelId: null,
			createdAt: "2026-01-01T00:00:00Z"
		});
		const query = new SearchCandidatesQuery(
			{ execute: async () => ({ candidates: [make("20", 0.5), make("100", 0.5)], retrieval: "hybrid" }) },
			logger
		);
		expect((await query.execute(input, access)).candidates.map((row) => row.messageId)).toEqual(["20", "100"]);
		await expect(query.execute(input, access, { rank: 0.5, messageId: "20" })).rejects.toMatchObject({
			code: "internal_error"
		});
		// Re-ranking may move a previously served message below the seek key; repeated IDs are allowed
		// across changed-corpus pages, but NEVER unordered keys or a widened ACL.
		const changed = new SearchCandidatesQuery(
			{ execute: async () => ({ candidates: [make("20", 0.4)], retrieval: "hybrid" }) },
			logger
		);
		expect((await changed.execute(input, access, { rank: 0.5, messageId: "100" })).candidates).toHaveLength(1);
	});
	it.each(["hybrid", "full-text-only"] as const)(
		"search-hybrid-degradation: %s marker is page-level",
		async (retrieval) => {
			const execute = vi.fn(async () => ({
				candidates: [
					{
						messageId: "100",
						channelId: "10",
						parentChannelId: null,
						createdAt: "2026-01-01T00:00:00Z",
						rank: 0.5
					}
				],
				retrieval
			}));
			const query = new SearchCandidatesQuery({ execute }, logger);
			expect((await query.execute(input, access)).retrieval).toBe(retrieval);
			expect(execute).toHaveBeenCalledWith({
				query: "hello",
				guildId: "1",
				accessibleChannelIds: ["10"],
				limit: 21
			});
		}
	);
	it("acl-before-fusion: contract receives mandatory scoped IDs and client never sees rogue candidates", async () => {
		const execute = vi.fn(async () => ({
			candidates: [
				{
					messageId: "999",
					channelId: "20",
					parentChannelId: null,
					createdAt: "2026-01-01T00:00:00Z",
					rank: 99
				}
			],
			retrieval: "hybrid" as const
		}));
		expect((await new SearchCandidatesQuery({ execute }, logger).execute(input, access)).candidates).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { messageId: "999", channelId: "20" });
	});
	it("retrieval technical failure yields internal_error, not partial rows", async () => {
		await expect(
			new SearchCandidatesQuery(
				{
					execute: async () => {
						throw new Error("sql");
					}
				},
				logger
			).execute(input, access)
		).rejects.toMatchObject({ code: "internal_error" });
	});
});
