import { describe, expect, it } from "vitest";
import {
	embeddingLiteral,
	requireEmbeddingLimit
} from "../../../src/features/semantic-index/repositories/postgres-embedding-store.repository.js";

describe("embedding store input bounds", () => {
	it("pins dimension and refuses malformed coordinates", () => {
		expect(() => embeddingLiteral([1])).toThrow();
		expect(() => embeddingLiteral(Array.from({ length: 1536 }, () => Number.NaN))).toThrow();
		expect(JSON.parse(embeddingLiteral(Array.from({ length: 1536 }, () => 1)))).toHaveLength(1536);
	});
	it("bounds every database batch", () => {
		for (const invalid of [0, -1, 65, 1.5, Number.NaN]) expect(() => requireEmbeddingLimit(invalid)).toThrow();
		expect(() => requireEmbeddingLimit(64)).not.toThrow();
	});
});
