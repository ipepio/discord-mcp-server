import { InvalidMessageBatchError } from "../models/domain/ingestion-store.errors.js";

/**
 * How a message-store write stays bounded (docs/architecture/persistence.md: "Batch writes must declare a
 * page or key bound before execution"; docs/features/ingestion.md R3's backfill and R6's bulk exclusion).
 *
 * A caller may hand the repository a REST history page of a hundred messages or a deletion list of a hundred
 * ids; the repository turns it into fixed-size groups and one transaction per group. Two things follow: an
 * array parameter never carries more elements than the bound says, and replaying the same rows is a no-op
 * rather than a duplicate, because every group is an idempotent guarded upsert.
 *
 * Same numbers as the registry's, deliberately: one deployment tuning covers both features' writes.
 */

/** Rows per statement. Rows become one bound array per column, so this is an element count, not a placeholder count. */
export const DEFAULT_MESSAGE_WRITE_BATCH_SIZE = 200;

/** Ceiling a caller may raise the batch to. Larger than this is a mistake, not a tuning choice. */
export const MAX_MESSAGE_WRITE_BATCH_SIZE = 1_000;

/**
 * Rows fetched per exclusion page when a bulk sweep walks one channel's messages. A page is the bound; the
 * sweep's length is not a caller's decision, and progress is structural because every swept row stops
 * matching the page predicate (R6).
 */
export const DEFAULT_MESSAGE_EXCLUSION_PAGE_SIZE = 200;

export function resolveWriteBatchSize(configured: number): number {
	if (!Number.isInteger(configured) || configured < 1) {
		throw new InvalidMessageBatchError("batch-size", "the batch size must be a positive whole number");
	}
	return Math.min(configured, MAX_MESSAGE_WRITE_BATCH_SIZE);
}

/** Fixed-size groups, in input order. An empty input produces no groups: nothing to write, nothing to open. */
export function splitWriteBatch<Row>(rows: readonly Row[], batchSize: number): readonly (readonly Row[])[] {
	const size = resolveWriteBatchSize(batchSize);
	const batches: (readonly Row[])[] = [];
	for (let index = 0; index < rows.length; index += size) {
		batches.push(rows.slice(index, index + size));
	}
	return batches;
}
