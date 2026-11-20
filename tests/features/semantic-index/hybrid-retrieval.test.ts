import { describe, expect, it, vi } from "vitest";
import { RetrieveHybridCandidatesQuery } from "../../../src/features/semantic-index/queries/retrieve-hybrid-candidates.query.js";
import type { VectorCandidate } from "../../../src/features/semantic-index/repositories/embedding-store.repository.js";

function candidate(messageId: string, channelId = "10"): VectorCandidate {
	return { messageId, channelId, createdInstant: new Date(0), editedInstant: null };
}
function fixture(overFetch = 2) {
	const fullText = {
		search: vi.fn().mockResolvedValue([candidate("100"), candidate("101"), candidate("999", "99")])
	};
	const vectors = {
		nearest: vi.fn().mockResolvedValue([candidate("101"), candidate("102"), candidate("998", "99")]),
		fetchNextUnembedded: vi.fn(),
		upsertBatch: vi.fn(),
		deleteByMessageIds: vi.fn()
	};
	const provider = {
		model: "pinned-model",
		embed: vi.fn().mockResolvedValue([Array.from({ length: 1536 }, () => 1)])
	};
	return {
		fullText,
		vectors,
		provider,
		query: new RetrieveHybridCandidatesQuery(fullText, vectors, provider, overFetch)
	};
}
const request = { text: "search text", accessibleChannelIds: ["10"], limit: 3 };

describe("hybrid retrieval and RRF", () => {
	it("filters unauthorized candidates BEFORE fusion, pins model, and deduplicates by message", async () => {
		const { query, fullText, vectors } = fixture();
		const result = await query.execute(request);
		expect(result.candidates.map((row) => row.messageId)).toEqual(["101", "100", "102"]);
		expect(result.candidates[0]?.branches).toEqual(["fts", "vector"]);
		expect(result.candidates[0]?.score).toBeCloseTo(1 / 62 + 1 / 61);
		expect(fullText.search).toHaveBeenCalledWith("search text", ["10"], 64, {});
		expect(vectors.nearest).toHaveBeenCalledWith(
			expect.objectContaining({ model: "pinned-model", accessibleChannelIds: ["10"] })
		);
	});
	it("pushes the same documented filters into both branches before fusion", async () => {
		const { query, fullText, vectors } = fixture();
		const filters = { channelIds: ["10"], authorId: "7", from: new Date(0), to: new Date(1000) };
		await query.execute({ ...request, ...filters });
		expect(fullText.search).toHaveBeenCalledWith(request.text, ["10"], 64, filters);
		expect(vectors.nearest).toHaveBeenCalledWith(expect.objectContaining(filters));
	});
	it("keeps rank keys stable across page sizes and validates cursors", async () => {
		const { query } = fixture();
		const all = await query.execute(request);
		const page = await query.execute({ ...request, limit: 1 });
		const anchor = page.candidates[0]!;
		const next = await query.execute({ ...request, cursor: { score: anchor.score, messageId: anchor.messageId } });
		expect([...page.candidates, ...next.candidates]).toEqual(all.candidates);
		for (const cursor of [
			{ score: NaN, messageId: "1" },
			{ score: 0, messageId: "bad" }
		])
			await expect(query.execute({ ...request, cursor })).rejects.toThrow();
	});
	it("empty ACL denies all without embedding or repository access", async () => {
		const { query, fullText, vectors, provider } = fixture();
		expect((await query.execute({ ...request, accessibleChannelIds: [] })).candidates).toEqual([]);
		expect(fullText.search).not.toHaveBeenCalled();
		expect(vectors.nearest).not.toHaveBeenCalled();
		expect(provider.embed).not.toHaveBeenCalled();
	});
	it("over-fetch is quality-only and cannot bypass ACL (I4)", async () => {
		for (const factor of [1, 2, 4]) {
			const { query } = fixture(factor);
			expect((await query.execute(request)).candidates.every((row) => row.channelId === "10")).toBe(true);
		}
	});
	it("provider outage returns FTS candidates rather than hiding unembedded messages", async () => {
		const { query, provider, vectors } = fixture();
		provider.embed.mockRejectedValue(new Error("sensitive"));
		const result = await query.execute(request);
		expect(result.vectorAvailable).toBe(false);
		expect(result.candidates.map((row) => row.messageId)).toEqual(["100", "101"]);
		expect(vectors.nearest).not.toHaveBeenCalled();
	});
	it("rejects missing ACL and malformed requests before I/O", async () => {
		const { query, fullText } = fixture();
		for (const limit of [0, 102, Number.NaN]) await expect(query.execute({ ...request, limit })).rejects.toThrow();
		await expect(query.execute({ ...request, accessibleChannelIds: JSON.parse("null") })).rejects.toThrow();
		expect(fullText.search).not.toHaveBeenCalled();
	});
});
