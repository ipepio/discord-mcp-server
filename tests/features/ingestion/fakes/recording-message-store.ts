import type { DiscordIdentifier } from "../../../../src/features/ingestion/models/domain/discord-identifier.js";
import type {
	ChannelExclusionResult,
	ChannelMessageExclusion,
	MessageBatchWriteResult,
	MessageEditWrite,
	MessageEditWriteResult,
	MessageTombstoneResult,
	MessageTombstoneWrite,
	MessageWrite,
	StoredMessage
} from "../../../../src/features/ingestion/models/domain/message-records.js";
import {
	editChangesStoredState,
	editWouldRegress,
	tombstoneDropsContent,
	validateChannelExclusion,
	validateMessageEdit,
	validateMessageTombstone,
	validateMessageWrite
} from "../../../../src/features/ingestion/models/domain/message-rules.js";
import type { MessageStoreRepository } from "../../../../src/features/ingestion/repositories/message-store.repository.js";

/**
 * The `MessageStoreRepository` double the command tests run on (docs/architecture/testing.md: "Mock
 * repository/gateway contracts for use-case tests, not their implementation internals").
 *
 * It is not a call recorder only. It holds rows and applies the same guard semantics the PostgreSQL adapter
 * puts in the `WHERE` of its statements — a replay that changes nothing is refused, an older edit instant never
 * overwrites a newer one, a tombstone is terminal, an absent id is counted rather than invented, and content
 * with its attachment metadata goes on a deletion while every identifying fact stays
 * (docs/features/ingestion.md R4–R8, R11; ADR-0007). The decisions a command makes are only observable against
 * a double that can refuse them, and the refusals are the same domain rules the SQL encodes, so a unit case
 * here cannot drift from the server case in `tests/integration/`.
 *
 * Every statement is recorded in order, which is what lets a test prove the *bound* a rule implies: a full edit
 * issues one write and no read, a partial edit issues one read and one write, a deferred edit issues a read and
 * no write at all, and a foreign-Guild event issues nothing.
 *
 * The SQL itself — placeholders, batch bounds, transaction atomicity, constraint refusals — is proven against a
 * real PostgreSQL in `tests/integration/ingestion-message-store.integration.test.ts`; nothing in this file
 * claims to prove it.
 */

/** One recorded store call: the contract method and the ids it named. */
export interface RecordedStoreCall {
	readonly operation: keyof MessageStoreRepository;
	readonly detail: string;
}

export interface RecordingMessageStoreOptions {
	/** Rows per statement the double reports as batches, so a bulk call's batching stays assertable. */
	readonly writeBatchSize?: number;
	/** Fail the named operation instead of answering it, once per call. Models a statement refusing mid-event. */
	readonly failOperation?: keyof MessageStoreRepository;
}

export class RecordingMessageStore implements MessageStoreRepository {
	public readonly calls: RecordedStoreCall[] = [];

	/** The rows the store holds, keyed by Discord message id — what a test reads back. */
	public readonly rows = new Map<DiscordIdentifier, StoredMessage>();

	private readonly options: RecordingMessageStoreOptions;

	public constructor(options: RecordingMessageStoreOptions = {}) {
		this.options = options;
	}

	public operationOrder(): string[] {
		return this.calls.map((call) => call.operation);
	}

	public callsTo(operation: keyof MessageStoreRepository): RecordedStoreCall[] {
		return this.calls.filter((call) => call.operation === operation);
	}

	public readonly upsertMessages = async (messages: readonly MessageWrite[]): Promise<MessageBatchWriteResult> => {
		const validated = messages.map(validateMessageWrite);
		this.record("upsertMessages", `${validated.length} message(s)`);

		let rowsWritten = 0;
		let rowsSkipped = 0;
		let attachmentsWritten = 0;
		let attachmentsRemoved = 0;

		for (const message of validated) {
			const stored = this.rows.get(message.messageId);
			if (stored === undefined) {
				this.rows.set(message.messageId, this.live(message, message.attachments ?? []));
				rowsWritten += 1;
				attachmentsWritten += (message.attachments ?? []).length;
				continue;
			}

			// A tombstone is terminal, and a late record of a pre-edit version never regresses newer content:
			// the two refusals the real statement carries in its `WHERE` (R6, R8).
			if (this.refuses(stored, message)) {
				rowsSkipped += 1;
				continue;
			}

			// The whole row is replaced, and the attachment set only when the payload reported one and the write
			// actually landed (R7: a refused replay moves nothing, attachment rows included).
			const reported = message.attachments;
			if (reported !== null) {
				// The sweep-then-insert the real adapter runs inside the batch transaction: the stored set goes and
				// the reported set replaces it, counts included.
				attachmentsRemoved += stored.attachments.length;
				attachmentsWritten += reported.length;
			}
			// A record that reported no list leaves the rows exactly where they are and says so with zero counts —
			// no statements at all, which is what the adapter does for it (R10, R11).
			this.rows.set(message.messageId, this.live(message, reported ?? stored.attachments));
			rowsWritten += 1;
		}

		return {
			rowsWritten,
			rowsSkipped,
			attachmentsWritten,
			attachmentsRemoved,
			batches: this.batches(validated.length)
		};
	};

	public readonly findMessage = async (
		guildId: DiscordIdentifier,
		messageId: DiscordIdentifier
	): Promise<StoredMessage | null> => {
		this.record("findMessage", `${guildId}/${messageId}`);
		const found = this.rows.get(messageId);
		return found === undefined || found.guildId !== guildId ? null : found;
	};

	public readonly applyMessageEdit = async (edit: MessageEditWrite): Promise<MessageEditWriteResult> => {
		const validated = validateMessageEdit(edit);
		this.record("applyMessageEdit", validated.messageId);

		const stored = this.rows.get(validated.messageId);
		// The real statement scopes by Guild as well as by id (`WHERE m.guild_id = $1 AND m.message_id = $2`), so
		// a row belonging to another Guild is not this row: absence, not a regression (R1).
		if (stored === undefined || stored.guildId !== validated.guildId) {
			return this.refusal("absent", null);
		}
		if (stored.deletedAt !== null) {
			return this.refusal("tombstoned", stored.editedInstant);
		}
		if (editWouldRegress(stored.editedInstant, validated.editedInstant)) {
			return this.refusal("stale", stored.editedInstant);
		}
		if (!editChangesStoredState(stored, validated)) {
			return this.refusal("unchanged", stored.editedInstant);
		}

		const attachments = validated.attachments ?? stored.attachments;
		this.rows.set(validated.messageId, {
			...stored,
			content: validated.content,
			editedInstant: validated.editedInstant,
			messageType: validated.messageType ?? stored.messageType,
			attachments
		});
		return {
			status: "applied",
			storedEditedInstant: validated.editedInstant,
			// An edit that reported no set runs no attachment statement at all, so it reports no counts either —
			// the same zero the PostgreSQL adapter returns for it (R10, R11).
			attachmentsRemoved: validated.attachments === null ? 0 : stored.attachments.length,
			attachmentsWritten: validated.attachments === null ? 0 : validated.attachments.length
		};
	};

	public readonly tombstoneMessages = async (tombstone: MessageTombstoneWrite): Promise<MessageTombstoneResult> => {
		const validated = validateMessageTombstone(tombstone);
		this.record("tombstoneMessages", `${validated.messageIds.length} id(s)`);

		let messagesTombstoned = 0;
		let attachmentsRemoved = 0;
		let alreadyTombstoned = 0;
		const unknownMessageIds: DiscordIdentifier[] = [];

		for (const messageId of validated.messageIds) {
			const stored = this.rows.get(messageId);
			if (stored === undefined || stored.guildId !== validated.guildId) {
				unknownMessageIds.push(messageId);
				continue;
			}
			if (stored.deletedAt !== null) {
				// A replay changes nothing, `deleted_at` included (R7).
				alreadyTombstoned += 1;
				continue;
			}
			// ADR-0007: content and attachment metadata go, every identifying fact stays.
			attachmentsRemoved += stored.attachments.length;
			this.rows.set(messageId, tombstoneDropsContent(stored, validated.deletedAt));
			messagesTombstoned += 1;
		}

		return {
			messagesTombstoned,
			attachmentsRemoved,
			alreadyTombstoned,
			unknownMessageIds: Object.freeze(unknownMessageIds),
			batches: this.batches(validated.messageIds.length)
		};
	};

	public readonly excludeChannelMessages = async (
		exclusion: ChannelMessageExclusion
	): Promise<ChannelExclusionResult> => {
		const validated = validateChannelExclusion(exclusion);
		this.record("excludeChannelMessages", validated.channelIds.join(","));

		let messagesTombstoned = 0;
		let attachmentsRemoved = 0;
		for (const [messageId, stored] of this.rows) {
			if (stored.guildId !== validated.guildId || !validated.channelIds.includes(stored.channelId)) {
				continue;
			}
			if (stored.deletedAt !== null) {
				continue;
			}
			attachmentsRemoved += stored.attachments.length;
			this.rows.set(messageId, tombstoneDropsContent(stored, validated.deletedAt));
			messagesTombstoned += 1;
		}

		return { messagesTombstoned, attachmentsRemoved, batches: messagesTombstoned > 0 ? 1 : 0 };
	};

	/** A row written whole by a create or a backfill record: live, with the set the payload reported. */
	private live(message: MessageWrite, attachments: StoredMessage["attachments"]): StoredMessage {
		return {
			guildId: message.guildId,
			messageId: message.messageId,
			channelId: message.channelId,
			authorId: message.authorId,
			authorUsername: message.authorUsername,
			authorIsBot: message.authorIsBot,
			webhookId: message.webhookId,
			messageType: message.messageType,
			content: message.content,
			createdInstant: message.createdInstant,
			editedInstant: message.editedInstant,
			replyReference: message.replyReference,
			attachments,
			deletedAt: null
		};
	}

	/** The whole-row guard of the upsert statement, mirrored: terminal row, or nothing new to store (R6, R7, R8). */
	private refuses(stored: StoredMessage, message: MessageWrite): boolean {
		if (stored.deletedAt !== null) {
			return true;
		}
		if (editWouldRegress(stored.editedInstant, message.editedInstant)) {
			return true;
		}
		return (
			!editChangesStoredState(stored, {
				content: message.content,
				editedInstant: message.editedInstant,
				messageType: message.messageType
			}) &&
			stored.channelId === message.channelId &&
			stored.authorId === message.authorId
		);
	}

	private refusal(
		status: MessageEditWriteResult["status"],
		storedEditedInstant: Date | null
	): MessageEditWriteResult {
		return { status, storedEditedInstant, attachmentsRemoved: 0, attachmentsWritten: 0 };
	}

	private record(operation: keyof MessageStoreRepository, detail: string): void {
		this.calls.push({ operation, detail });
		if (this.options.failOperation === operation) {
			throw new Error(`recording message store failed ${operation}`);
		}
	}

	private batches(rows: number): number {
		const size = this.options.writeBatchSize ?? 200;
		return Math.max(1, Math.ceil(rows / size));
	}
}

/** Seed rows straight into the double, bypassing the guards a test is not about. */
export function seedRows(store: RecordingMessageStore, ...rows: readonly StoredMessage[]): void {
	for (const row of rows) {
		store.rows.set(row.messageId, row);
	}
}
