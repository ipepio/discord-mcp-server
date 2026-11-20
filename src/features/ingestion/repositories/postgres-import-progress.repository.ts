import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import type { ChannelImportProgress, ChannelImportStatus } from "../models/domain/import-progress.js";
import type { ChannelHistoryStopReason } from "../models/domain/history-walk-rules.js";
import type { DiscordRestFailureReason } from "../../discord/index.js";
import { InvalidMessageBatchError, InvalidMessageIdentifierError } from "../models/domain/ingestion-store.errors.js";
import type { ImportProgressRepository } from "./import-progress.repository.js";
import type { SqlExecutor } from "./sql-executor.js";

/**
 * The PostgreSQL import ledger (`odd/tasks/ingestion-catchup.md` T1; docs/features/ingestion.md R14). Table
 * `import_channel_progress`, one row per `(guild_id, channel_id)`, written and read through
 * {@link ImportProgressRepository}.
 *
 * The rules this adapter keeps, and where each one lives:
 *
 * - **Values are bound, never interpolated.** Ids, statuses, reasons, instants and counters reach PostgreSQL as
 *   `$n` parameters; the statement text carries column names and nothing a caller supplied.
 * - **A save replaces the row whole.** `ON CONFLICT (guild_id, channel_id) DO UPDATE SET` every column, because
 *   the row *is* the channel's state: a merge would let a counter that was reset (`attempts`, after a successful
 *   attempt) survive as a stale value.
 * - **The selection predicate is the rule, in SQL.** `outstanding` is `status <> 'complete'` and due now, ordered
 *   oldest-due-first and bounded by the caller's limit — the same statement the index
 *   `import_channel_progress_outstanding_index` serves, so the catch-up's fairness and its bound are one read.
 * - **`bigint` arrives as text and leaves as a number.** `pg` hands `int8` back as a string, so counters are
 *   parsed here rather than trusted; a value outside the safe integer range is refused instead of rounded
 *   (docs/architecture/persistence.md).
 * - **A write per call, not per page.** `saveAll` runs one statement per entry inside one transaction: the callers
 *   (`ImportChannelHistoryCommand`, `CatchUpOutstandingChannelsCommand`) persist a *channel's outcome*, and a
 *   transaction per channel keeps a half-written page of channels impossible without adding SQL to the walk.
 *
 * Nothing here logs: a failure propagates as itself, and no statement text or parameter set is ever formatted
 * into a message (R12).
 */

const PROGRESS_COLUMNS = `guild_id, channel_id, status, cursor_before_id, pages_read, messages_stored,
	messages_unchanged, messages_outside_window, attachments_written, attempts,
	last_stop_reason, last_failure_reason, next_attempt_at`;

const LOAD_ALL_STATEMENT = `
	SELECT ${PROGRESS_COLUMNS}
	FROM import_channel_progress
	WHERE guild_id = $1
	ORDER BY channel_id
`;

/**
 * The catch-up's only read. `next_attempt_at IS NULL` means "no backoff pending", which is why a completed row
 * (`status = 'complete'`) and a skipped one (due again on the next tick) need no second flag. `NULLS FIRST`
 * keeps a channel that has never been deferred ahead of one that has, so a fresh channel is not starved by a
 * backlog of deferrals.
 */
const OUTSTANDING_STATEMENT = `
	SELECT ${PROGRESS_COLUMNS}
	FROM import_channel_progress
	WHERE guild_id = $1
		AND status <> 'complete'
		AND (next_attempt_at IS NULL OR next_attempt_at <= $2)
	ORDER BY next_attempt_at ASC NULLS FIRST, channel_id ASC
	LIMIT $3
`;

const UPSERT_STATEMENT = `
	INSERT INTO import_channel_progress (${PROGRESS_COLUMNS}, updated_at)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
	ON CONFLICT (guild_id, channel_id) DO UPDATE SET
		status = EXCLUDED.status,
		cursor_before_id = EXCLUDED.cursor_before_id,
		pages_read = EXCLUDED.pages_read,
		messages_stored = EXCLUDED.messages_stored,
		messages_unchanged = EXCLUDED.messages_unchanged,
		messages_outside_window = EXCLUDED.messages_outside_window,
		attachments_written = EXCLUDED.attachments_written,
		attempts = EXCLUDED.attempts,
		last_stop_reason = EXCLUDED.last_stop_reason,
		last_failure_reason = EXCLUDED.last_failure_reason,
		next_attempt_at = EXCLUDED.next_attempt_at,
		updated_at = EXCLUDED.updated_at
	RETURNING channel_id
`;

const FORGET_STATEMENT = `
	DELETE FROM import_channel_progress
	WHERE guild_id = $1 AND channel_id = ANY($2::bigint[])
	RETURNING channel_id
`;

/** One row as PostgreSQL hands it back: `bigint` columns are text, the instant is a `Date`. */
interface ProgressRow {
	readonly channel_id: string;
	readonly status: string;
	readonly cursor_before_id: string | null;
	readonly pages_read: string | number;
	readonly messages_stored: string | number;
	readonly messages_unchanged: string | number;
	readonly messages_outside_window: string | number;
	readonly attachments_written: string | number;
	readonly attempts: string | number;
	readonly last_stop_reason: string | null;
	readonly last_failure_reason: string | null;
	readonly next_attempt_at: Date | string | null;
}

/** The statuses this table stores; the CHECK in migration 9 states the same list. */
const STORED_STATUSES: readonly ChannelImportStatus[] = ["in-progress", "partial", "deferred", "skipped", "complete"];

export class PostgresImportProgressRepository implements ImportProgressRepository {
	public constructor(private readonly executor: SqlExecutor) {}

	public readonly loadAll = async (guildId: DiscordIdentifier): Promise<readonly ChannelImportProgress[]> => {
		const scope = requireDiscordIdentifier("import_channel_progress.guild_id", guildId);
		const { rows } = await this.executor.query<ProgressRow>(LOAD_ALL_STATEMENT, [scope]);
		return rows.map((row) => toProgress(row));
	};

	public readonly saveAll = async (
		guildId: DiscordIdentifier,
		entries: readonly ChannelImportProgress[]
	): Promise<void> => {
		const scope = requireDiscordIdentifier("import_channel_progress.guild_id", guildId);
		// Nothing to write is not an error and not an empty transaction: a caller that walked no channel must not
		// open one.
		if (entries.length === 0) return;

		const parameters = entries.map((entry) => parametersOf(scope, entry));
		await this.executor.transaction(async (session) => {
			for (const row of parameters) {
				await session.query(UPSERT_STATEMENT, row);
			}
		});
	};

	public readonly outstanding = async (
		guildId: DiscordIdentifier,
		now: Date,
		limit: number
	): Promise<readonly ChannelImportProgress[]> => {
		const scope = requireDiscordIdentifier("import_channel_progress.guild_id", guildId);
		if (!Number.isInteger(limit) || limit < 1) {
			// persistence.md: a bounded read declares its bound before execution, and a limit of "everything" is
			// exactly the unbounded read the catch-up must not issue.
			throw new InvalidMessageBatchError(
				"import-progress.outstanding",
				"the limit must be a positive whole number"
			);
		}

		const { rows } = await this.executor.query<ProgressRow>(OUTSTANDING_STATEMENT, [scope, now, limit]);
		return rows.map((row) => toProgress(row));
	};

	public readonly forgetChannels = async (
		guildId: DiscordIdentifier,
		channelIds: readonly DiscordIdentifier[]
	): Promise<number> => {
		const scope = requireDiscordIdentifier("import_channel_progress.guild_id", guildId);
		if (channelIds.length === 0) return 0;
		// An empty array would be "no ids", but a repository that silently treats an empty list as a no-op hides a
		// caller that meant to prune and resolved nothing; the guard is the caller's list being non-empty here.
		const ids = channelIds.map((channelId) =>
			requireDiscordIdentifier("import_channel_progress.channel_id", channelId)
		);
		const { rows } = await this.executor.query<{ channel_id: string }>(FORGET_STATEMENT, [scope, ids]);
		return rows.length;
	};
}

/** The statement's parameter tuple, in the column order {@link UPSERT_STATEMENT} declares. */
function parametersOf(guildId: DiscordIdentifier, entry: ChannelImportProgress): readonly unknown[] {
	return [
		guildId,
		requireDiscordIdentifier("import_channel_progress.channel_id", entry.channelId),
		requireStoredStatus(entry.status),
		entry.nextBeforeId === null
			? null
			: requireDiscordIdentifier("import_channel_progress.cursor_before_id", entry.nextBeforeId),
		entry.pagesRead,
		entry.messagesStored,
		entry.messagesUnchanged,
		entry.messagesOutsideWindow,
		entry.attachmentsWritten,
		entry.attempts,
		entry.stopReason,
		entry.restFailureReason,
		entry.nextAttemptAt
	];
}

function requireStoredStatus(status: ChannelImportStatus): ChannelImportStatus {
	if (!STORED_STATUSES.includes(status)) {
		// Unreachable through the domain's own type, and stated anyway: the column's CHECK would report a
		// constraint name and an unquoted value, which names a table rather than the state that produced it.
		throw new InvalidMessageBatchError("import-progress.save", `unknown channel import status ${String(status)}`);
	}

	return status;
}

/** One row of the table, as the in-run shape the commands carry. */
function toProgress(row: ProgressRow): ChannelImportProgress {
	return {
		channelId: requireDiscordIdentifier("import_channel_progress.channel_id", row.channel_id),
		status: requireStoredStatus(row.status as ChannelImportStatus),
		nextBeforeId: row.cursor_before_id,
		stopReason: row.last_stop_reason as ChannelHistoryStopReason | null,
		restFailureReason: row.last_failure_reason as DiscordRestFailureReason | null,
		pagesRead: countOf("pages_read", row.pages_read),
		messagesStored: countOf("messages_stored", row.messages_stored),
		messagesUnchanged: countOf("messages_unchanged", row.messages_unchanged),
		messagesOutsideWindow: countOf("messages_outside_window", row.messages_outside_window),
		attachmentsWritten: countOf("attachments_written", row.attachments_written),
		attempts: countOf("attempts", row.attempts),
		nextAttemptAt: instantOf(row.next_attempt_at)
	};
}

function countOf(field: string, value: string | number): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new InvalidMessageIdentifierError(`import_channel_progress.${field}`, "out-of-safe-integer-range");
	}

	return parsed;
}

function instantOf(value: Date | string | null): Date | null {
	if (value === null) return null;
	return value instanceof Date ? value : new Date(value);
}
