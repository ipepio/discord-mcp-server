import type { DiscordMessageHistoryPage } from "../../discord/index.js";

/**
 * The channel-history read a backfill is built on (docs/features/ingestion.md R3 and R9; the Discord side of
 * the same capability is `readMessageHistoryPage`, spec R7 there: bounded pages, bounded retries for transient
 * failures only, a named failure instead of a silently shortened page).
 *
 * `../gateways/message-rest-gateway.interface.js` says why this contract is not part of it: a reconciliation
 * of one message must not be able to turn into a scan, so the by-id read and the page read are separate seams
 * a command takes separately. The import and the resync take this one; the edit path never sees it.
 *
 * The shape mirrors guild-state's precedent and stays narrower than the adapter's own contract on purpose: a
 * backfill walks **older**, so `after` — the direction the adapter also admits — is not reachable from here.
 * Narrowing the read is what keeps a gap backfill from silently becoming a forward scan of a channel that has
 * already been walked.
 *
 * Every bound the read obeys belongs to the discord adapter, and so does every retry: this seam either returns
 * a whole page or throws a named `DiscordRestFailureError`. `hasMore` and `nextBeforeId` are the page's own
 * facts, and the decision about asking for another one is ingestion's (see
 * `../models/domain/history-walk-rules.js`).
 */

/** One page of one channel's history, asked for the way Discord addresses pages. */
export interface MessageHistoryPageRead {
	/** The container to read: a thread's own id when the messages live in a thread (R2 there). */
	readonly channelId: string;
	/** Ask for messages older than this id. Absent means start at the channel's newest message. */
	readonly before?: string;
	/** How many messages to ask for. The adapter clamps to its own policy and to Discord's ceiling. */
	readonly limit?: number;
}

export interface MessageHistoryGateway {
	readonly readMessageHistoryPage: (read: MessageHistoryPageRead) => Promise<DiscordMessageHistoryPage>;
}
