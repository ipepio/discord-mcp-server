import type { DiscordMessageRecord } from "../../../discord/index.js";
import type { DiscordIdentifier } from "../domain/discord-identifier.js";
import type { MessageWrite } from "../domain/message-records.js";
import { toReportedAttachments, toStorableReplyReference } from "./message-event.mapper.js";

/**
 * A message as a REST history page reported it, as the message store's write record
 * (docs/features/ingestion.md R3 with R4, R7, R8, R11).
 *
 * This is the same conversion `RecordMessageCommand` performs for a `MESSAGE_CREATE`, and it is a separate
 * file rather than a call to that command for one reason: R3 makes the import a **batched** job — "applied
 * through idempotent batches" — and one bounded upsert per page is what makes 100 messages one transaction
 * instead of 100. The store's guarded statement, not this mapper, is what decides whether a row changes
 * (R7, R8), so mapping through the same record type is the whole of the sharing.
 *
 * The absent-versus-empty translation is the one inherited from `./message-event.mapper.js` and it matters
 * more here than in the event path: a history page reports `attachments` for every message it carries, so a
 * message that genuinely has none arrives as an empty list and its stored set is replaced with nothing, while
 * a payload that reported no list at all keeps the stored set untouched.
 *
 * Webhook provenance is carried by the REST contract too: replaying a webhook message must not clear the
 * Gateway-derived webhook id (R7).
 */

/** One record, converted: the write the store receives, and the refusal the payload forced on the way (R4). */
export interface MappedHistoryMessage {
	readonly write: MessageWrite;
	/** True when Discord named a reply reference with no message to point at: counted, never swallowed (R4). */
	readonly replyReferenceDropped: boolean;
}

/**
 * The whole write, stamped with the configured Guild.
 *
 * R1 holds here by construction rather than by a check: the channel ids this walk visits come from the
 * guild-scoped registry (R2), and a page read for one of them describes messages of that channel, so there is
 * no foreign Guild id to compare and refuse. The `guildId` a row carries is the Installation's own, which is
 * the only value that makes the row reachable by this mirror's read paths at all.
 */
export function toHistoryMessageWrite(guildId: DiscordIdentifier, record: DiscordMessageRecord): MappedHistoryMessage {
	const reply = toStorableReplyReference(record.replyReference);

	return {
		replyReferenceDropped: reply.dropped,
		write: {
			guildId,
			messageId: record.messageId,
			channelId: record.channelId,
			authorId: record.authorId,
			// Every field the history record does not carry is stated as the value that means "not reported",
			// exactly as the event path does (R4), so the repository never has to interpret an `undefined`.
			authorUsername: record.authorUsername ?? null,
			authorIsBot: record.authorIsBot ?? null,
			webhookId: record.webhookId ?? null,
			messageType: record.messageType,
			content: record.content,
			createdInstant: record.createdInstant,
			editedInstant: record.editedInstant ?? null,
			replyReference: reply.reference,
			attachments: toReportedAttachments(record.attachments)
		}
	};
}
