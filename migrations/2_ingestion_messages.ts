import type { MigrationBuilder } from "node-pg-migrate";

/**
 * T1 of `odd/tasks/ingestion.md`: the ingestion message store (docs/features/ingestion.md R4 to R8, R11,
 * with docs/adr/0007 and docs/architecture/persistence.md).
 *
 * Shape of the store. `message` holds one row per Discord message, keyed by Discord's own message id, and
 * `message_attachment` holds the attachment metadata of one message as one row per attachment. Attachments
 * are a child table rather than a `jsonb` column because every rule that touches them is per-attachment —
 * R11's "metadata only" is a column list, the query feature filters and joins on attachment facts, and a
 * tombstone must physically drop them, which a `DELETE` proves and a `NULL` only claims. The one lifecycle
 * they do not have is their own: they are written, replaced and removed with their message, so the
 * repository that owns both tables is one contract.
 *
 * Integrity rules the schema itself enforces, not just the code above it:
 *
 * - Discord ids are `bigint` columns carried as JS strings by the application
 *   (`src/features/ingestion/models/domain/discord-identifier.ts`), so a malformed id fails at the column
 *   instead of silently widening, and the largest snowflakes survive a round trip unchanged (R9 of
 *   guild-state, the same rule here).
 * - `message_pkey` on the Discord message id is R7's idempotency key: replaying a delivery targets the same
 *   row and cannot create a second one.
 * - **A tombstone has no content.** `message_content_is_dropped_by_a_tombstone` is CHECK over two columns at
 *   once: a live row always has content, a tombstoned row never has any. That is ADR-0007's "tombstones
 *   physically drop message content" made structural — no statement can write `content` and `deleted_at`
 *   together, and none can keep content while marking a row deleted. `message_attachment` rows of a
 *   tombstoned message are deleted, not marked, which is why no attachment row can outlive its content.
 * - `message_ids_are_positive` refuses a zero or negative snowflake in any id column, the same rule the
 *   domain applies before a statement runs.
 * - `message_reply_reference_has_a_target`: a reply channel or guild is only meaningful with the message id
 *   it belongs to, so a half reference cannot be stored.
 * - `message_attachment_size_is_never_negative` and the three blank-name checks keep R11's metadata honest.
 *   They trim before comparing, so a name made of spaces is refused by the schema as well as by the domain's
 *   `requireStorableText`. That check is the stricter of the two (it trims every whitespace character, the
 *   schema's `btrim` only spaces), which is the right way round: the column is the backstop, not the gate.
 *
 * Deliberately absent, with reasons:
 *
 * - **No foreign key to `guild`, `channel` or any guild-state table.** A foreign key is a reference to
 *   another feature's internal table, which docs/architecture/structure.md and guild-state's own Contracts
 *   section forbid ("Other features never import this feature's repositories, SQL or tables"). It would
 *   also be wrong in two concrete ways: guild-state *deletes* channel rows (its R6) while ADR-0007 requires
 *   a tombstoned message row to survive, so a `channel` foreign key would make that deletion fail; and a
 *   `guild` foreign key would make `TRUNCATE guild` — which guild-state's own tests run — refuse, because
 *   Postgres will not truncate a referenced table without cascading. R1 is therefore enforced above the
 *   schema, by the commands that drop a foreign-guild event before any statement, and every statement here
 *   is guild-scoped by its own `WHERE guild_id = $n`. `message_attachment`'s foreign key is composite on
 *   `guild_id` for the same reason guild-state uses one: within this feature, a row cannot be attached to a
 *   foreign guild.
 * - **No `ON DELETE CASCADE` anywhere.** Every removal is an explicit repository statement whose counts are
 *   observable (persistence.md, R6, R14). The foreign keys are `NO ACTION`, so a cascade the repository
 *   forgot becomes a loud constraint violation rather than orphan rows.
 * - **No thread column.** Discord's message payload names exactly one container id, and for a post in a
 *   thread that id *is* the thread's (guild-state R6: a thread is a channel with a parent). The parent
 *   relationship belongs to the registry, so `channel_id` holds the container and the bulk-exclude statement
 *   takes the set of channel and thread ids the caller resolved from the registry.
 * - **No bytes, no storage reference, no downloaded-file column.** R11 forbids the content of attachments,
 *   and an integration test reads this table's column list back to prove the claim.
 *
 * Indexes serve the statements this feature actually issues: the bulk exclusion walks one guild and one
 * channel set in id order, and the point read is the primary key. Nothing speculative — the query feature
 * adds its own indexes against its own predicates.
 *
 * The DDL is written as explicit SQL rather than the helper DSL, as in migration 1: table-level CHECKs,
 * composite foreign keys and named constraints read better as the statements they become. This file contains
 * no parameters and interpolates no values; values only ever arrive through a repository's bound parameters.
 */

export const shorthands = undefined;

export const up = (pgm: MigrationBuilder): void => {
	// One row per Discord message: R4's stored facts, R5's edit timestamp, R6's tombstone.
	pgm.sql(`
		CREATE TABLE message (
			message_id bigint PRIMARY KEY,
			guild_id bigint NOT NULL,
			channel_id bigint NOT NULL,
			author_id bigint NOT NULL,
			author_username text,
			author_is_bot boolean,
			webhook_id bigint,
			message_type text NOT NULL,
			content text,
			created_instant timestamptz NOT NULL,
			edited_instant timestamptz,
			reply_message_id bigint,
			reply_channel_id bigint,
			reply_guild_id bigint,
			deleted_at timestamptz,
			CONSTRAINT message_guild_scoped_key UNIQUE (guild_id, message_id),
			CONSTRAINT message_type_is_named CHECK (btrim(message_type) <> ''),
			CONSTRAINT message_ids_are_positive
				CHECK (guild_id > 0 AND channel_id > 0 AND author_id > 0),
			CONSTRAINT message_content_is_dropped_by_a_tombstone
				CHECK ((deleted_at IS NULL AND content IS NOT NULL) OR (deleted_at IS NOT NULL AND content IS NULL)),
			CONSTRAINT message_reply_reference_has_a_target
				CHECK (reply_message_id IS NOT NULL OR (reply_channel_id IS NULL AND reply_guild_id IS NULL))
		)
	`);
	pgm.sql(
		"CREATE INDEX message_guild_channel_instant_index ON message (guild_id, channel_id, created_instant, message_id)"
	);

	// Attachment metadata only (R11): id, filename, content type, size, URL, and nothing else.
	pgm.sql(`
		CREATE TABLE message_attachment (
			message_id bigint NOT NULL,
			attachment_id bigint NOT NULL,
			guild_id bigint NOT NULL,
			filename text NOT NULL,
			url text NOT NULL,
			content_type text,
			size_bytes bigint NOT NULL,
			PRIMARY KEY (message_id, attachment_id),
			FOREIGN KEY (guild_id, message_id) REFERENCES message (guild_id, message_id),
			CONSTRAINT message_attachment_filename_is_named CHECK (btrim(filename) <> ''),
			CONSTRAINT message_attachment_url_is_named CHECK (btrim(url) <> ''),
			CONSTRAINT message_attachment_content_type_is_never_blank
				CHECK (content_type IS NULL OR btrim(content_type) <> ''),
			CONSTRAINT message_attachment_size_is_never_negative CHECK (size_bytes >= 0)
		)
	`);
};

export const down = (pgm: MigrationBuilder): void => {
	// Reverse dependency order, and nothing that was not created here.
	pgm.sql("DROP TABLE IF EXISTS message_attachment");
	pgm.sql("DROP TABLE IF EXISTS message");
};
