import type { NormalizedMessageType } from "../../../discord/index.js";
import type { DiscordIdentifier } from "./discord-identifier.js";

/**
 * The application records the message store holds (docs/features/ingestion.md R4, R5, R6, R11; ADR-0007).
 * These types are the repository contract's vocabulary, and a PostgreSQL row shape never appears in them —
 * row types belong to the adapter file that reads them (docs/architecture/persistence.md).
 *
 * Two conventions carry the whole feature's meaning, and both are deliberate:
 *
 * - **A nullable column is `T | null`, never an optional property** (the rule guild-state states for its own
 *   registry, and `docs/features/discord.md` R3 establishes for the boundary): "Discord did not send it" and
 *   "the caller forgot to say" must not look the same to a repository. Where absentness is a real third
 *   state — a payload that reported no attachment list at all — the record says so with `null` on a
 *   whole-set field, and the write path reads that as "leave the stored set alone".
 * - **`content: string | null` means "there is no content to have"**, which happens exactly once: the row is
 *   a tombstone (R6, ADR-0007). A live message always has text, even the empty string an attachment-only
 *   post carries. The schema states the same rule as a CHECK, so a write that would put content on a
 *   tombstone, or take it off a live row, is refused by the database as well as by this type.
 */

/** Attachment metadata, R11's list and nothing more: no bytes, no storage reference, no local path. */
export interface StoredMessageAttachment {
	readonly attachmentId: DiscordIdentifier;
	readonly filename: string;
	readonly url: string;
	/** `null` when Discord sent no content type — deliberately not an empty string. */
	readonly contentType: string | null;
	readonly sizeBytes: number;
}

/** A reply reference as stored: the message it names, plus the channel and guild Discord named with it. */
export interface MessageReplyReference {
	readonly messageId: DiscordIdentifier;
	readonly channelId: DiscordIdentifier | null;
	readonly guildId: DiscordIdentifier | null;
}

/**
 * One stored message, the shape every read path returns. `deletedAt` non-null makes it a tombstone, and a
 * tombstone's `content` is `null` and its `attachments` empty — not "unknown", but physically gone (ADR-0007:
 * the id, author, timestamps and `deleted_at` remain; the deleted content is unrecoverable by design).
 */
export interface StoredMessage {
	readonly guildId: DiscordIdentifier;
	readonly messageId: DiscordIdentifier;
	/** The container Discord named: a thread's own id when the message was posted in a thread. */
	readonly channelId: DiscordIdentifier;
	readonly authorId: DiscordIdentifier;
	readonly authorUsername: string | null;
	/** `null` when the payload said nothing about the author's kind; `true` for a bot or webhook author. */
	readonly authorIsBot: boolean | null;
	/** Present only when the message arrived through a webhook (R4's provenance). */
	readonly webhookId: DiscordIdentifier | null;
	readonly messageType: NormalizedMessageType;
	readonly content: string | null;
	readonly createdInstant: Date;
	/** The newest edit instant Discord has reported for this message, or `null` when it never reported one. */
	readonly editedInstant: Date | null;
	readonly replyReference: MessageReplyReference | null;
	readonly attachments: readonly StoredMessageAttachment[];
	/** The instant the hub applied the deletion, or `null` while the message is live. */
	readonly deletedAt: Date | null;
}

/**
 * One message as a create event or a REST history record describes it — the whole row, written or replaced
 * in one idempotent upsert (R4, R7). The `Discord`-side shapes satisfy this structurally; the command maps
 * absent to `null` so the repository never has to guess what an `undefined` meant.
 */
export interface MessageWrite {
	readonly guildId: DiscordIdentifier;
	readonly messageId: DiscordIdentifier;
	readonly channelId: DiscordIdentifier;
	readonly authorId: DiscordIdentifier;
	readonly authorUsername: string | null;
	readonly authorIsBot: boolean | null;
	readonly webhookId: DiscordIdentifier | null;
	readonly messageType: NormalizedMessageType;
	readonly content: string;
	readonly createdInstant: Date;
	readonly editedInstant: Date | null;
	readonly replyReference: MessageReplyReference | null;
	/** `null` means the payload carried no attachment list, so the stored set stays; `[]` means it has none. */
	readonly attachments: readonly StoredMessageAttachment[] | null;
}

/**
 * One edit, as the reconciled state of a `message-updated` event (R5). Content and edited instant are what
 * the rule replaces; the message type is replaced only when a payload named one, and the attachment set is
 * replaced only when a payload reported one — an edit event carries no attachment list, so only a
 * REST-reconciled edit can report one.
 */
export interface MessageEditWrite {
	readonly guildId: DiscordIdentifier;
	readonly messageId: DiscordIdentifier;
	readonly content: string;
	readonly editedInstant: Date | null;
	readonly messageType: NormalizedMessageType | null;
	readonly attachments: readonly StoredMessageAttachment[] | null;
}

/** The ids a deletion names, with the instant the hub observed it (R6). */
export interface MessageTombstoneWrite {
	readonly guildId: DiscordIdentifier;
	readonly messageIds: readonly DiscordIdentifier[];
	readonly deletedAt: Date;
}

/** The channel and thread ids whose messages a structural change excludes (R6's bulk half; T5 resolves the set). */
export interface ChannelMessageExclusion {
	readonly guildId: DiscordIdentifier;
	readonly channelIds: readonly DiscordIdentifier[];
	readonly deletedAt: Date;
}

/** How many rows a bounded batch wrote, how many its guards refused, and how many transactions it cost. */
export interface MessageBatchWriteResult {
	readonly rowsWritten: number;
	/** Rows the guards refused: already as current as the payload, or tombstoned and therefore terminal (R7, R8). */
	readonly rowsSkipped: number;
	readonly attachmentsWritten: number;
	readonly attachmentsRemoved: number;
	readonly batches: number;
}

/**
 * What one guarded edit statement decided. `stale` and `unchanged` are the two refusals that leave content
 * exactly where it was — R5's "does not regress" and R7's replay — and the difference is only whether the
 * incoming state was older or identical. `tombstoned` and `absent` are the two cases where there is nothing
 * to edit (R6 terminal, R4 not yet stored).
 */
export type MessageEditWriteStatus = "applied" | "unchanged" | "stale" | "tombstoned" | "absent";

export interface MessageEditWriteResult {
	readonly status: MessageEditWriteStatus;
	/** The edited instant stored after this write, which is what the next comparison is made against. */
	readonly storedEditedInstant: Date | null;
	readonly attachmentsRemoved: number;
	readonly attachmentsWritten: number;
}

/** R6, single and bulk deletion: what was tombstoned, what was already gone, what the store never had. */
export interface MessageTombstoneResult {
	readonly messagesTombstoned: number;
	readonly attachmentsRemoved: number;
	/** Rows already tombstoned: a replay changes nothing, and `deleted_at` keeps its first value (R7). */
	readonly alreadyTombstoned: number;
	/** Ids with no row at all. Counted and named, never guessed at or invented (R4, R6). */
	readonly unknownMessageIds: readonly DiscordIdentifier[];
	readonly batches: number;
}

/** R6's bulk half, reported in counts so an exclusion is auditable without reading a single message. */
export interface ChannelExclusionResult {
	readonly messagesTombstoned: number;
	readonly attachmentsRemoved: number;
	readonly batches: number;
}
