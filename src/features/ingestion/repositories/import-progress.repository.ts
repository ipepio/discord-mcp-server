import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import type { ChannelImportProgress } from "../models/domain/import-progress.js";

/**
 * The import ledger, durable (`odd/tasks/ingestion-catchup.md` T1; docs/features/ingestion.md R14; the table is
 * migration 9, `import_channel_progress`).
 *
 * One row per `(guildId, channelId)`, and the four questions it exists to answer:
 *
 * - **`loadAll`** — what does this Guild's ledger say? The bootstrap import reads it once and stops treating a
 *   restart as a blank slate: a channel already `complete` costs zero history reads, which is the measured waste
 *   this table removes.
 * - **`saveAll`** — record where a channel's attempt ended. Called **per channel**, never per page: a page is the
 *   store's business (R7's idempotent batch), a channel's outcome is the ledger's, and a write per page would
 *   add SQL to the hot path of the walk to record a cursor the next page supersedes.
 * - **`outstanding`** — the catch-up's only read: the rows that still have work (`status <> 'complete'`) and are
 *   due (`next_attempt_at` absent or in the past), bounded by a limit the caller declares before it runs.
 * - **`forgetChannels`** — R2/R6 pruning. A channel the registry no longer names keeps no ledger row, and this is
 *   the durable half of the in-memory `forget`; without it a deleted channel would be walked once per tick
 *   forever.
 *
 * What is deliberately NOT here: no query by channel id (the import loads the whole Guild and the catch-up page
 * is bounded by the tick, so a point read would exist only for a caller that does not), no deletion of a Guild's
 * ledger (no rule asks for one, and a migration is the append-only place for a bulk removal), and no ordering
 * rule stated twice — `outstanding` returns oldest-due first, which is the fairness the catch-up needs.
 */
export interface ImportProgressRepository {
	/**
	 * Every ledger row of one Guild, in channel id order. The bootstrap import turns this into its in-run ledger;
	 * no other caller reads the whole set.
	 */
	readonly loadAll: (guildId: DiscordIdentifier) => Promise<readonly ChannelImportProgress[]>;

	/**
	 * Upsert these channels' rows in one transaction. Each entry replaces the stored row whole, because a row is
	 * the channel's state, not a patch: a stale counter must not survive a save that no longer carries it.
	 */
	readonly saveAll: (guildId: DiscordIdentifier, entries: readonly ChannelImportProgress[]) => Promise<void>;

	/**
	 * Rows of one Guild with work left and no pending backoff, oldest due first, at most `limit` of them. `now` is
	 * the caller's instant, so "due" is a fact of the run rather than of the database's clock.
	 */
	readonly outstanding: (
		guildId: DiscordIdentifier,
		now: Date,
		limit: number
	) => Promise<readonly ChannelImportProgress[]>;

	/**
	 * Drop the named channels' rows and report how many were dropped. Used when the registry no longer names a
	 * channel (R2, R6): its cursor cannot be resumed, and keeping it would make the catch-up walk a channel that
	 * no longer exists.
	 */
	readonly forgetChannels: (guildId: DiscordIdentifier, channelIds: readonly DiscordIdentifier[]) => Promise<number>;
}
