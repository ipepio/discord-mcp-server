import type { MessageAttachmentMetadata, NormalizedReplyReference } from "../../../discord/index.js";
import type { MessageReplyReference, StoredMessageAttachment } from "../domain/message-records.js";
import { replyReferenceIsStorable, toStoredAttachments } from "../domain/message-rules.js";

/**
 * Boundary conversions between what Discord reports about a message and what the message store writes
 * (docs/architecture/structure.md: "Pure conversion | Mapper; no I/O").
 *
 * These two conversions exist because the two shapes disagree in exactly one way, and the disagreement is a
 * rule rather than a naming accident: a Discord payload distinguishes **absent** from **empty** — a message
 * object that carried no `attachments` key is not a message with no attachments (docs/features/discord.md R3,
 * docs/features/guild-state.md R10) — while the store record distinguishes them as
 * `readonly StoredMessageAttachment[] | null`, with `null` meaning "the stored set stays" (R4, R5). Absent
 * therefore maps to `null` and an empty list maps to `[]`, which is the pair of facts a guarded write can act
 * on differently.
 *
 * A reply reference has the same shape of problem: Discord can name a reply channel or guild without naming
 * the message replied to, and the domain rule that decides whether such a half reference is storable lives in
 * `../domain/message-rules.ts` — this file only applies it and reports that it did.
 *
 * Nothing here validates: validation is the domain rules' job, and the repository runs it on the way into a
 * statement. A mapper that validated would let a second, weaker copy of a rule exist.
 */

/**
 * The attachment metadata a payload reported, as the store's own three-state record (R4, R11).
 * `undefined` — the payload carried no list — becomes `null`: the stored set stays exactly as it is.
 */
export function toReportedAttachments(
	attachments: readonly MessageAttachmentMetadata[] | undefined
): readonly StoredMessageAttachment[] | null {
	if (attachments === undefined) {
		return null;
	}

	return toStoredAttachments(
		attachments.map((attachment): StoredMessageAttachment => ({
			attachmentId: attachment.attachmentId,
			filename: attachment.filename,
			url: attachment.url,
			contentType: attachment.contentType ?? null,
			sizeBytes: attachment.sizeBytes
		}))
	);
}

/** Where one reply reference ended up: the storable reference, and whether a reported one was dropped (R4). */
export interface StorableReplyReference {
	readonly reference: MessageReplyReference | null;
	/** True only when the payload named a reference that had no message to point at — counted, never swallowed. */
	readonly dropped: boolean;
}

export function toStorableReplyReference(reference: NormalizedReplyReference | undefined): StorableReplyReference {
	if (reference === undefined) {
		return { reference: null, dropped: false };
	}
	if (!replyReferenceIsStorable(reference)) {
		return { reference: null, dropped: true };
	}

	return {
		reference: {
			messageId: reference.messageId,
			channelId: reference.channelId ?? null,
			guildId: reference.guildId ?? null
		},
		dropped: false
	};
}
