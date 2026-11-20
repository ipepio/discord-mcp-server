import { describe, expect, it } from "vitest";
import { InvalidMessageBatchError } from "../../../src/features/ingestion/models/domain/ingestion-store.errors.js";
import {
	DEFAULT_MESSAGE_WRITE_BATCH_SIZE,
	MAX_MESSAGE_WRITE_BATCH_SIZE,
	resolveWriteBatchSize,
	splitWriteBatch
} from "../../../src/features/ingestion/repositories/message-write-batch.js";

/**
 * The bound every message-store batch write declares before it executes (docs/architecture/persistence.md:
 * "Batch writes must declare a page or key bound before execution"). A backfill page is small and a bulk
 * deletion is capped by Discord, but the repository is not allowed to assume either: the numbers below are
 * what a bulk import of a year of history costs in statements, and what a deployment may raise.
 */

describe("message-store write batch bounds", () => {
	it("keeps the default batch and the ceiling as declared data", () => {
		expect(DEFAULT_MESSAGE_WRITE_BATCH_SIZE).toBe(200);
		expect(MAX_MESSAGE_WRITE_BATCH_SIZE).toBe(1_000);
	});

	it("clamps a raised batch to the ceiling instead of building a million-element array parameter", () => {
		expect(resolveWriteBatchSize(50)).toBe(50);
		expect(resolveWriteBatchSize(MAX_MESSAGE_WRITE_BATCH_SIZE)).toBe(MAX_MESSAGE_WRITE_BATCH_SIZE);
		expect(resolveWriteBatchSize(100_000)).toBe(MAX_MESSAGE_WRITE_BATCH_SIZE);
	});

	it("refuses a bound that is not a positive whole number", () => {
		for (const configured of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => resolveWriteBatchSize(configured)).toThrow(InvalidMessageBatchError);
		}
	});

	it("splits rows into fixed-size groups in input order", () => {
		const rows = Array.from({ length: 45 }, (_unused, index) => index);
		const groups = splitWriteBatch(rows, 20);
		expect(groups.map((group) => group.length)).toEqual([20, 20, 5]);
		expect(groups[2]?.[0]).toBe(40);
	});

	it("produces no group for no rows, so an empty import opens no transaction", () => {
		expect(splitWriteBatch([], 20)).toEqual([]);
		expect(splitWriteBatch([1], 20)).toHaveLength(1);
	});

	it("refuses to split with a broken bound rather than defaulting to something unplanned", () => {
		expect(() => splitWriteBatch([1, 2, 3], 0)).toThrow(InvalidMessageBatchError);
	});
});
