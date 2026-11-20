import { InvalidRegistryBatchError } from "../models/domain/guild-state-registry.errors.js";

/**
 * How a registry write stays bounded (docs/architecture/persistence.md: "Batch writes must declare a page
 * or key bound before execution"; docs/features/guild-state.md R2, R9: "bounded batch transactions").
 *
 * A caller may hand a repository a roster page of a thousand members or a Guild with ten thousand roles;
 * the repository turns it into fixed-size groups and one transaction per group. Two things follow: an
 * array parameter never carries more elements than the bound says, and replaying the same rows is a no-op
 * rather than a duplicate, because every group is an idempotent upsert.
 */

/** Rows per statement. Rows become one bound array per column, so this is an element count, not a placeholder count. */
export const DEFAULT_REGISTRY_WRITE_BATCH_SIZE = 200;

/** Ceiling a caller may raise the batch to. Larger than this is a mistake, not a tuning choice. */
export const MAX_REGISTRY_WRITE_BATCH_SIZE = 1_000;

export function resolveWriteBatchSize(configured: number): number {
	if (!Number.isInteger(configured) || configured < 1) {
		throw new InvalidRegistryBatchError("batch-size", "the batch size must be a positive whole number");
	}
	return Math.min(configured, MAX_REGISTRY_WRITE_BATCH_SIZE);
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
