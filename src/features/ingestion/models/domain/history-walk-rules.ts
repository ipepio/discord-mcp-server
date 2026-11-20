import type { DiscordMessageHistoryPage, DiscordRestFailureReason } from "../../../discord/index.js";

/**
 * The rules one walk of a channel's history obeys (docs/features/ingestion.md R3 and R9; the transport rules
 * they lean on are R7 there — bounded pages, bounded retries, a named failure instead of a shortened page).
 *
 * A walk ends for exactly one of six reasons, and which one it was decides what the caller is allowed to
 * claim. That is the whole point of naming them: "stopped early" and "finished" must never share a value, or
 * an import that read four pages of a channel would report the channel as imported. Three reasons complete a
 * channel, one is resumable by design, and two are failures that leave the channel's work outstanding.
 *
 * Nothing here catches an error or reaches a gateway: this file classifies a reason the caller already holds
 * and derives the cursor the next page needs.
 */

/** Why one channel's history walk stopped, as R3's and R9's own vocabulary. */
export type ChannelHistoryStopReason =
	/** Discord reported no older page: the retrievable history was walked to its end. */
	| "history-exhausted"
	/** The newest-first page reached R3's cutoff; no older page can enter the window. */
	| "window-bound"
	/** This run's page bound was reached while older pages remained: outstanding work, resumable. */
	| "page-bound"
	/** A 4xx: the channel cannot be read — permission removed, or deleted mid-import (R3's error case). */
	| "rest-access-lost"
	/** A rate limit, 5xx, timeout or transport failure, after the adapter spent its bounded retries (R3). */
	| "rest-transient-failure"
	/** Discord's page payload failed validation, so nothing in the page could be trusted (R7 there). */
	| "rest-payload-invalid";

/** The reasons that mean the channel is imported: nothing further can be read for it in this window. */
export type CompletingChannelHistoryStopReason = "history-exhausted" | "window-bound";

export const COMPLETING_STOP_REASONS: readonly CompletingChannelHistoryStopReason[] = Object.freeze([
	"history-exhausted",
	"window-bound"
] as const);

/** R3: did this stop reason finish the channel, or does work remain? */
export function stopReasonCompletesWalk(
	reason: ChannelHistoryStopReason
): reason is CompletingChannelHistoryStopReason {
	return (COMPLETING_STOP_REASONS as readonly ChannelHistoryStopReason[]).includes(reason);
}

/** How a REST failure of a history read bears on the walk: skip it, retry it later, or distrust the page. */
export type HistoryFailureClass = "rest-access-lost" | "rest-transient-failure" | "rest-payload-invalid";

/**
 * R3's error clause, total by construction over the boundary's own reason vocabulary: a client error is a
 * condition of the channel and will not change by asking again, a rate limit or a 5xx is a condition of the
 * moment (the adapter has already retried it within its bound), and a payload that did not validate is neither
 * — it is a defect to report, not a channel to skip.
 */
const HISTORY_FAILURE_CLASSES: Record<DiscordRestFailureReason, HistoryFailureClass> = Object.freeze({
	"client-error": "rest-access-lost",
	unauthorized: "rest-access-lost",
	"not-found": "rest-access-lost",
	"rate-limit": "rest-transient-failure",
	"server-error": "rest-transient-failure",
	timeout: "rest-transient-failure",
	transport: "rest-transient-failure",
	validation: "rest-payload-invalid"
});

export function classifyHistoryFailure(reason: DiscordRestFailureReason): HistoryFailureClass {
	return HISTORY_FAILURE_CLASSES[reason];
}

/**
 * The cursor the next (older) page is asked for.
 *
 * Discord names one when it knows an older page exists. When it does not — the last page of a channel, or a
 * page whose `hasMore` was reported without a cursor — the oldest id the page carried is the same fact
 * restated: asking for messages older than it cannot return anything this walk has already applied. Without
 * either, there is nothing to resume from and the walk starts at the channel's newest message.
 */
export function olderHistoryCursor(page: DiscordMessageHistoryPage): string | null {
	if (page.nextBeforeId !== undefined) {
		return page.nextBeforeId;
	}

	const oldest = page.messages[page.messages.length - 1];
	return oldest === undefined ? null : oldest.messageId;
}
