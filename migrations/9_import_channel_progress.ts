import type { MigrationBuilder } from "node-pg-migrate";

export const shorthands = undefined;

/**
 * T1 of `odd/tasks/ingestion-catchup.md` (docs/features/ingestion.md R14): the durable import ledger, the table
 * that turns "what is still outstanding" from a fact about a process into a fact about the installation.
 *
 * Before this table the ledger lived in memory (`src/features/ingestion/models/domain/import-progress.ts` said
 * so in as many words: "This is a contract, not a store"), so a restart lost every cursor and re-read pages the
 * store already held — 166 866 messages counted unchanged against 6 stored in the 2026-11-13 run. One row per
 * `(guild_id, channel_id)` is the whole of a channel's resumable state: where its next page picks up, whether
 * anything is left to do, why the last attempt stopped, the cumulative counts, and when the catch-up may ask
 * again.
 *
 * Shape decisions, and why each is a column rather than a separate table:
 *
 * - **`status` is one text column, checked.** The vocabulary is R14's own and it is small
 *   (`complete`, `partial`, `deferred`, `skipped`, plus `in-progress` and `untouched`, which the table admits so
 *   it round-trips the domain type exactly and can hold a channel it knows about but has not walked). The CHECK
 *   is what stops the column becoming a free-text status a reader has to interpret; nothing in this feature
 *   writes `in-progress` or `untouched` today.
 * - **`cursor_before_id` is a `bigint` cursor**, the Discord message id the next page is asked before, exactly
 *   as the in-memory ledger holds it. `NULL` means "start at the channel's newest message": a sentinel id would
 *   be a second, unstated cursor rule.
 * - **The counters are `bigint` and cumulative across attempts**, because they are counts of rows, not a report
 *   of one run, and a count that only ever existed in a log line cannot be totalled after a restart.
 * - **`last_stop_reason` and `last_failure_reason` are the walk's own vocabulary**, kept as text rather than
 *   as an enum type: migrations are append-only and this feature already validates the values in
 *   `history-walk-rules.ts`. They are what lets an operator tell a skip from a deferral from a completion
 *   without reading logs.
 * - **`attempts` counts consecutive deferrals**, which is what the backoff exponent needs (see
 *   `models/domain/catch-up-backoff.ts`); it resets to zero on every outcome that is not a deferral.
 * - **`next_attempt_at` is the only selection predicate the catch-up adds.** `NULL` means "eligible now", which
 *   is why a completed row (`complete`) and a skipped one (no delay) are both expressed without a second flag.
 *
 * No foreign key to `guild` or `channel`, for the reason migration 2 states: a registry row may be deleted
 * (guild-state R6) while its import state must survive, and every statement here is guild-scoped by its own
 * `WHERE guild_id = $1`. Additive and append-only: `down` drops this table and nothing else.
 */
export const up = (pgm: MigrationBuilder): void => {
	pgm.sql(`
		CREATE TABLE import_channel_progress (
			guild_id bigint NOT NULL,
			channel_id bigint NOT NULL,
			status text NOT NULL,
			cursor_before_id bigint,
			pages_read bigint NOT NULL DEFAULT 0,
			messages_stored bigint NOT NULL DEFAULT 0,
			messages_unchanged bigint NOT NULL DEFAULT 0,
			messages_outside_window bigint NOT NULL DEFAULT 0,
			attachments_written bigint NOT NULL DEFAULT 0,
			attempts integer NOT NULL DEFAULT 0,
			last_stop_reason text,
			last_failure_reason text,
			next_attempt_at timestamptz,
			updated_at timestamptz NOT NULL,
			PRIMARY KEY (guild_id, channel_id),
			CONSTRAINT import_channel_progress_ids_are_positive CHECK (guild_id > 0 AND channel_id > 0),
			CONSTRAINT import_channel_progress_cursor_is_positive
				CHECK (cursor_before_id IS NULL OR cursor_before_id > 0),
			CONSTRAINT import_channel_progress_status_is_known CHECK (
				status IN ('in-progress', 'partial', 'deferred', 'skipped', 'complete', 'untouched')
			),
			CONSTRAINT import_channel_progress_attempts_is_never_negative CHECK (attempts >= 0),
			CONSTRAINT import_channel_progress_counts_are_never_negative CHECK (
				pages_read >= 0
				AND messages_stored >= 0
				AND messages_unchanged >= 0
				AND messages_outside_window >= 0
				AND attachments_written >= 0
			)
		)
	`);
	// The catch-up's only read: one guild's rows that are not complete and are due now, oldest due first.
	pgm.sql(
		"CREATE INDEX import_channel_progress_outstanding_index ON import_channel_progress (guild_id, status, next_attempt_at)"
	);
};

export const down = (pgm: MigrationBuilder): void => {
	pgm.sql("DROP TABLE import_channel_progress;");
};
