import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type {
	MessageAttachmentMetadata,
	NormalizedMessageType,
	NormalizedReplyReference
} from "../../discord/index.js";
import type { IngestionConfig } from "../config/ingestion-config.interface.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import type { MessageReplyReference, MessageWrite } from "../models/domain/message-records.js";
import { isForeignGuildRecord } from "../models/domain/message-rules.js";
import { toReportedAttachments, toStorableReplyReference } from "../models/mappers/message-event.mapper.js";
import type { MessageStoreRepository } from "../repositories/message-store.repository.js";

/**
 * `MESSAGE_CREATE` applied to the message store (docs/features/ingestion.md R4, with R7, R8, R11 and R1 at the
 * event boundary).
 *
 * One message, one guarded upsert: the row is written whole through the repository's idempotent statement, so
 * this command's work is the three decisions a write cannot make for itself.
 *
 * - **R1.** An event naming another Guild is refused before any statement runs, counted as an anomaly and
 *   returned — never stored, and never dropped without saying so.
 * - **R4.** Every fact the rule lists goes in as Discord reported it, all message types included, with the
 *   store's own convention applied on the way: an absent author kind, an absent webhook, an absent edit instant
 *   and an absent reply reference each become `null`, and a payload that carried no attachment list becomes
 *   `null` on the set field so the stored set stays rather than being wiped. A reply reference that names no
 *   message is dropped whole and counted — the domain rule decides it, this command only reports that it did.
 * - **R7.** A replayed message id is a no-op, and it is a no-op *because of the store's own guard*: the
 *   repository refuses a write that would change nothing observable and refuses to overwrite newer or
 *   tombstoned state, so a duplicate delivery reports `rowsWritten: 0, rowsSkipped: 1` and moves nothing —
 *   including the attachment rows, which a refused write must not widen or narrow (R8). This command does not
 *   read the row first to find out whether it existed: the guard already answers that with its counts, and a
 *   read-then-write would settle nothing about two concurrent deliveries of one replay
 *   (docs/architecture/persistence.md).
 *
 * R12: a log line names ids and counts. Message text, author display names and attachment metadata are never
 * log fields, and a skipped write says which guard skipped it rather than quoting what it skipped.
 */

/** One created message, as a normalized event or a REST history record describes it. Absent fields were absent. */
export interface RecordMessageEvent {
	/** The Guild the event came from. Anything other than the configured one is refused (R1). */
	readonly guildId: DiscordIdentifier;
	readonly messageId: DiscordIdentifier;
	/** The container Discord named: a thread's own id for a message posted in a thread (R2 there). */
	readonly channelId: DiscordIdentifier;
	readonly authorId: DiscordIdentifier;
	readonly authorUsername?: string;
	readonly authorIsBot?: boolean;
	/** Present only when the message arrived through a webhook (R4's provenance). */
	readonly webhookId?: DiscordIdentifier;
	readonly messageType: NormalizedMessageType;
	readonly content: string;
	readonly createdInstant: Date;
	readonly editedInstant?: Date;
	readonly replyReference?: NormalizedReplyReference;
	/** Absent when the payload carried no attachment list; an empty list means the message has none (R11). */
	readonly attachments?: readonly MessageAttachmentMetadata[];
}

/** Where one created message ended up. */
export type RecordMessageOutcome =
	| {
			readonly status: "applied";
			readonly guildId: DiscordIdentifier;
			readonly messageId: DiscordIdentifier;
			readonly channelId: DiscordIdentifier;
			/** False when the store's guard refused the write: a replay, or stored state that is newer (R7, R8). */
			readonly rowsWritten: number;
			readonly rowsSkipped: number;
			readonly attachmentsWritten: number;
			readonly attachmentsRemoved: number;
			/** True when R4's rule dropped a reply reference that named no message. */
			readonly replyReferenceDropped: boolean;
	  }
	| {
			readonly status: "dropped";
			readonly guildId: DiscordIdentifier;
			readonly messageId: DiscordIdentifier;
			readonly channelId: DiscordIdentifier;
			readonly reason: "foreign-guild";
	  };

export interface RecordMessageCommandDeps {
	readonly config: IngestionConfig;
	readonly messageStore: MessageStoreRepository;
	readonly logger: AppLogger;
}

export class RecordMessageCommand {
	private readonly guildId: DiscordIdentifier;

	private readonly messageStore: MessageStoreRepository;

	private readonly logger: AppLogger;

	public constructor(deps: RecordMessageCommandDeps) {
		this.guildId = deps.config.guildId;
		this.messageStore = deps.messageStore;
		this.logger = deps.logger;
	}

	public readonly execute = async (event: RecordMessageEvent): Promise<RecordMessageOutcome> => {
		if (isForeignGuildRecord(event.guildId, this.guildId)) {
			return this.dropForeignGuild(event.guildId, event.messageId, event.channelId);
		}

		const messageId = requireDiscordIdentifier("message.message_id", event.messageId);
		const channelId = requireDiscordIdentifier("message.channel_id", event.channelId);
		const reply = toStorableReplyReference(event.replyReference);

		const written = await this.messageStore.upsertMessages([this.toWrite(event, messageId, channelId, reply)]);

		this.logger.info("ingestion applied a message creation event", {
			guildId: this.guildId,
			messageId,
			channelId,
			rowsWritten: written.rowsWritten,
			rowsSkipped: written.rowsSkipped,
			attachmentsWritten: written.attachmentsWritten,
			attachmentsRemoved: written.attachmentsRemoved,
			batches: written.batches,
			// R7's replay is a fact about the store's guard, reported rather than left for a caller to infer.
			outcome: written.rowsWritten > 0 ? "written" : "unchanged-by-store-guard",
			replyReferenceDropped: reply.dropped
		});
		if (reply.dropped) {
			this.logger.warn("ingestion dropped a reply reference that named no message", {
				guildId: this.guildId,
				messageId,
				channelId,
				reason: "reply-reference-has-no-target"
			});
		}

		return {
			status: "applied",
			guildId: this.guildId,
			messageId,
			channelId,
			rowsWritten: written.rowsWritten,
			rowsSkipped: written.rowsSkipped,
			attachmentsWritten: written.attachmentsWritten,
			attachmentsRemoved: written.attachmentsRemoved,
			replyReferenceDropped: reply.dropped
		};
	};

	/** R1: named and counted, never written — another Guild's message has no row in this mirror. */
	private dropForeignGuild(
		eventGuildId: DiscordIdentifier,
		messageId: DiscordIdentifier,
		channelId: DiscordIdentifier
	): RecordMessageOutcome {
		this.logger.warn("ingestion dropped a message event for another guild", {
			guildId: this.guildId,
			eventGuildId,
			messageId,
			channelId,
			operation: "record-message"
		});
		return { status: "dropped", guildId: this.guildId, messageId, channelId, reason: "foreign-guild" };
	}

	/**
	 * The write record: the ids this command validated, and every fact the event did not carry stated as the
	 * value that means "not reported" (R4). The repository's own validation runs on the way into the statement;
	 * this is the shape it validates, built in one place so a create event and a REST history record — which
	 * describe the same message with different absences — both arrive through it.
	 */
	private toWrite(
		event: RecordMessageEvent,
		messageId: DiscordIdentifier,
		channelId: DiscordIdentifier,
		reply: { readonly reference: MessageReplyReference | null; readonly dropped: boolean }
	): MessageWrite {
		return {
			guildId: this.guildId,
			messageId,
			channelId,
			authorId: requireDiscordIdentifier("message.author_id", event.authorId),
			// R4's provenance and R11's set are stated as `null` when the payload said nothing, which is the only
			// form in which "the event did not say" survives the trip to a guarded write.
			authorUsername: event.authorUsername ?? null,
			authorIsBot: event.authorIsBot ?? null,
			webhookId: this.toStorableWebhookId(event.webhookId),
			messageType: event.messageType,
			content: event.content,
			createdInstant: event.createdInstant,
			editedInstant: event.editedInstant ?? null,
			replyReference: reply.reference,
			attachments: toReportedAttachments(event.attachments)
		};
	}

	/** `webhook_id` is a `bigint` column or nothing: present-but-unstorable is refused, not dropped (R4). */
	private toStorableWebhookId(webhookId: DiscordIdentifier | undefined): DiscordIdentifier | null {
		return webhookId === undefined ? null : requireDiscordIdentifier("message.webhook_id", webhookId);
	}
}
