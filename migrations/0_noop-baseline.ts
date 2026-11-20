import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

/**
 * Version 0: the schema baseline for a fresh installation.
 *
 * It changes nothing on purpose. Its job is to give the migration history a first, replayable
 * entry so every later change appends after it (`docs/architecture/persistence.md`: migrations
 * are append-only, applied versions are immutable, corrections become a new migration).
 *
 * v1 features add their own migrations here: the `discord` feature creates its tables, the
 * `semantic-index` feature creates the vector extension and its index. Nothing in `src/` runs
 * migrations at startup; `npm run migrate` is the only path that applies them.
 */
export async function up(_pgm: MigrationBuilder): Promise<void> {}

/**
 * Rolling the baseline back restores "no migrations applied". No object exists to drop, so this
 * stays empty rather than pretending a `down` file is a recovery strategy.
 */
export async function down(_pgm: MigrationBuilder): Promise<void> {}
