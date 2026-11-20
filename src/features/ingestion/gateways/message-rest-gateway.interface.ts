import type { DiscordMessageRecord } from "../../discord/index.js";

/**
 * The message read ingestion owns as a contract (docs/features/ingestion.md R5; docs/architecture/structure.md:
 * "A capability used by another feature goes through an intentional public contract").
 *
 * The shape is guild-state's precedent: the consuming feature declares the narrow contract, the `discord`
 * feature's REST adapter satisfies it structurally, and the import direction stays type-only and one-way —
 * ingestion knows these application types, `discord` knows nothing about this feature. No discord.js type
 * reaches a command, and no read beyond the one the reconciliation needs is reachable through this seam.
 *
 * What is deliberately absent:
 *
 * - **No history page.** Channel backfill is T3's contract, over `readMessageHistoryPage`; a reconciliation
 *   must not be able to turn into a scan, which is exactly why the parent decision for this read rejected
 *   page-scanning (`odd/tasks/ingestion.md` T2).
 * - **No write, and no guild id.** The adapter is constructed with the configured Guild, and a message read is
 *   addressed by its channel and message ids — the same two ids the event already named (R1, R2).
 *
 * Every bound the read obeys — the explicit timeout, the bounded retries for transient failures only, the
 * refusal to retry a client error, and the payload validation that names a field path — lives inside the
 * discord adapter (docs/features/discord.md R7). A caller here therefore gets either a whole
 * `DiscordMessageRecord` or a named `DiscordRestFailureError`, never a partially populated record to
 * interpret and never a field to invent (R5, R10).
 */

/** The one message a reconciliation asks for, addressed the way Discord addresses a message. */
export interface MessageReconciliationRead {
	/** The container the event named: a thread's own id when the message was posted in a thread. */
	readonly channelId: string;
	readonly messageId: string;
}

export interface MessageRestGateway {
	/** One message whole by id, as the only way to complete an update that arrived without every field (R5). */
	readonly readMessage: (read: MessageReconciliationRead) => Promise<DiscordMessageRecord>;
}
