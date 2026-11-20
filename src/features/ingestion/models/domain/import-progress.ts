import type { DiscordRestFailureReason } from "../../../discord/index.js";
import type { DiscordIdentifier } from "./discord-identifier.js";
import type { ChannelHistoryStopReason } from "./history-walk-rules.js";
import { stopReasonCompletesWalk } from "./history-walk-rules.js";

/**
 * R3's resumability, as state: what one channel's import has already done, and where the next page picks up
 * (docs/features/ingestion.md R3: "The import is a resumable background job: it tolerates restarts, resumes
 * without duplicating").
 *
 * A resumable import needs three facts and nothing more: **how far this channel's walk got** (the `before`
 * cursor the next page is asked for), **whether anything is left to do** (the status), and **what stopped it**
 * (the reason, so a skip and a truncation are never read as a completion). Counts travel with them because R3
 * also requires progress to be observable, and a count that only ever existed in a log line cannot be totalled
 * across the runs one channel took.
 *
 * The status vocabulary is deliberately narrow, with exactly one terminal value. `complete` is the only status
 * that excuses a later run from asking for a page, because it is the only one R3 allows to be claimed as
 * "imported". Everything else — `partial` at the page bound, `deferred` behind a rate limit, `skipped` by a 4xx
 * — is outstanding work that the next run attempts again, so a transient condition cannot turn into a
 * permanently skipped channel. A 4xx is not lost either: re-asking a channel whose permission came back is the
 * only way an in-process import ever recovers it, and the registry list, not this ledger, is what decides a
 * channel is gone for good (R2).
 *
 * This is a contract, not a store.
 *
 * **Update (R14, `odd/tasks/ingestion-catchup.md` T1): the store exists.** `import_channel_progress` holds these
 * rows, `ImportProgressRepository` is the contract over it, and this type is now the **in-run** shape — what a
 * command loads once, updates as it walks, and hands back per channel. The vocabulary, the one terminal status
 * and the counts are unchanged on purpose: only where the rows live moved. The reason the old comment gave for
 * keeping them in memory ("R7 makes a re-read cheap") was measured and found false for this Guild — a restart
 * re-read 1 782 pages to rediscover 166 866 already-stored messages — so the durable ledger is the fix for that
 * waste, and R7 remains what makes a duplicated page harmless.
 */

/** Where one channel's import stands. Only `complete` means "no work left". */
export type ChannelImportStatus = "in-progress" | "partial" | "deferred" | "skipped" | "complete";

/** One channel's resumable import state, as the ledger holds it. Ids and counts only (R12). */
export interface ChannelImportProgress {
	readonly channelId: DiscordIdentifier;
	readonly status: ChannelImportStatus;
	/** The `before` cursor the next page of this channel is asked for; `null` starts at the newest message. */
	readonly nextBeforeId: string | null;
	/** Why the last attempt stopped, or `null` when no attempt has run. */
	readonly stopReason: ChannelHistoryStopReason | null;
	/** The boundary cause that produced `stopReason`, kept so a skip can name the status it saw (R3). */
	readonly restFailureReason: DiscordRestFailureReason | null;
	/** Cumulative across every run this channel's state has survived, including across restarts (R14). */
	readonly pagesRead: number;
	readonly messagesStored: number;
	/** Rows R7's store guard refused: already as current as this page said. */
	readonly messagesUnchanged: number;
	/** Messages R3's window excluded. Counted, never silently dropped. */
	readonly messagesOutsideWindow: number;
	/** Attachment rows written by the cumulative walks of this channel (R11, R14). */
	readonly attachmentsWritten: number;
	/**
	 * Consecutive deferrals, and the exponent of R14's backoff:
	 * `models/domain/catch-up-backoff.ts`. Zero on every outcome that is not a deferral, so a channel that
	 * advanced a page and then hit a rate limit starts its wait from the base again.
	 */
	readonly attempts: number;
	/** The earliest instant the catch-up may attempt this channel again; `null` means "eligible now". */
	readonly nextAttemptAt: Date | null;
}

/** The ledger an import reads and writes. One entry per channel id, replaced whole on record. */
export interface ImportProgressLedger {
	readonly progressFor: (channelId: DiscordIdentifier) => ChannelImportProgress | null;
	readonly record: (progress: ChannelImportProgress) => void;
	/** Drops a channel's entry. Used when the registry no longer names the channel (R2). */
	readonly forget: (channelId: DiscordIdentifier) => boolean;
	/** Every entry, in the order they were first recorded. */
	readonly snapshot: () => readonly ChannelImportProgress[];
}

/**
 * R3: does this channel still need work? Absence needs work — a channel the ledger has never heard of has had
 * no page read for it, which is the common case on a first run and the reason "unknown" is not an outcome.
 */
export function channelImportNeedsWork(progress: ChannelImportProgress | null): boolean {
	return progress === null || progress.status !== "complete";
}

/**
 * R3's completion claim, as one derivation from the registry's channel set and the ledger: a Guild is imported
 * when every channel the registry currently names as ingestible has reached `complete`. Nothing else counts —
 * not a page bound, not a 4xx, not an empty channel — which is what keeps "the run finished" from being
 * reported as "the import finished" (R3: completion only once every channel has finished).
 */
export function outstandingChannelIds(
	channelIds: readonly DiscordIdentifier[],
	ledger: ImportProgressLedger
): readonly DiscordIdentifier[] {
	return channelIds.filter((channelId) => channelImportNeedsWork(ledger.progressFor(channelId)));
}

/**
 * The status a finished walk earned from its stop reason. Stated once because both import and resync derive it,
 * and a channel whose walk stopped at the page bound must not be recorded as complete by one caller and
 * partial by the other.
 */
export function channelStatusForStopReason(reason: ChannelHistoryStopReason): ChannelImportStatus {
	if (stopReasonCompletesWalk(reason)) {
		return "complete";
	}

	switch (reason) {
		case "page-bound":
			return "partial";
		case "rest-access-lost":
			return "skipped";
		case "rest-transient-failure":
		case "rest-payload-invalid":
			return "deferred";
	}
}

/** What one attempt walked, as the ledger counts it. Every field is a count of rows or pages (R12). */
export interface ChannelImportAttemptCounts {
	readonly pagesRead: number;
	readonly messagesStored: number;
	readonly messagesUnchanged: number;
	readonly messagesOutsideWindow: number;
	readonly attachmentsWritten: number;
}

/** The two scheduling facts an attempt leaves behind, owned by whoever decided the backoff. */
export interface ChannelImportScheduling {
	readonly attempts: number;
	readonly nextAttemptAt: Date | null;
}

/**
 * The row one attempt leaves behind: the stored row's cumulative counts plus what this attempt did, the status
 * its stop reason earned, and the scheduling the caller decided.
 *
 * Stated once because two callers write this row — the bootstrap import and R14's catch-up — and a count that
 * one of them forgot to carry would silently reset a channel's history to "nothing was ever done here". The
 * status is derived here rather than passed in for the same reason: a caller may choose when to retry, never
 * what a stop reason means.
 */
export function applyChannelImportAttempt(input: {
	readonly previous: ChannelImportProgress | null;
	readonly channelId: DiscordIdentifier;
	readonly stopReason: ChannelHistoryStopReason;
	readonly restFailureReason: DiscordRestFailureReason | null;
	readonly nextBeforeId: string | null;
	readonly counts: ChannelImportAttemptCounts;
	readonly scheduling: ChannelImportScheduling;
}): ChannelImportProgress {
	const previous = input.previous;

	return {
		channelId: input.channelId,
		status: channelStatusForStopReason(input.stopReason),
		nextBeforeId: input.nextBeforeId,
		stopReason: input.stopReason,
		restFailureReason: input.restFailureReason,
		pagesRead: (previous?.pagesRead ?? 0) + input.counts.pagesRead,
		messagesStored: (previous?.messagesStored ?? 0) + input.counts.messagesStored,
		messagesUnchanged: (previous?.messagesUnchanged ?? 0) + input.counts.messagesUnchanged,
		messagesOutsideWindow: (previous?.messagesOutsideWindow ?? 0) + input.counts.messagesOutsideWindow,
		attachmentsWritten: (previous?.attachmentsWritten ?? 0) + input.counts.attachmentsWritten,
		attempts: input.scheduling.attempts,
		nextAttemptAt: input.scheduling.nextAttemptAt
	};
}
