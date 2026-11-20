import type { NormalizedMessageType } from "../../discord/index.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier, requireSizeBytes } from "../models/domain/discord-identifier.js";
import type {
	ChannelExclusionResult,
	ChannelMessageExclusion,
	MessageBatchWriteResult,
	MessageEditWrite,
	MessageEditWriteResult,
	MessageTombstoneResult,
	MessageTombstoneWrite,
	MessageWrite,
	StoredMessage,
	StoredMessageAttachment
} from "../models/domain/message-records.js";
import {
	editWouldRegress,
	messageIsTombstoned,
	tombstoneProjection,
	validateChannelExclusion,
	validateMessageEdit,
	validateMessageTombstone,
	validateMessageWrite
} from "../models/domain/message-rules.js";
import type { MessageStoreRepository } from "./message-store.repository.js";
import { splitWriteBatch } from "./message-write-batch.js";
import type { SqlExecutor, SqlStatementRunner } from "./sql-executor.js";

/**
 * The PostgreSQL message store (docs/features/ingestion.md R4 to R8, R11; ADR-0007;
 * docs/architecture/persistence.md).
 *
 * The three rules that shape every statement here:
 *
 * - **One idempotent write per message id.** `message_id` is Discord's own and the table's key, so R7's replay
 *   is `ON CONFLICT … DO UPDATE`, never a delete-then-insert and never a second row.
 * - **Convergence is a guard clause, not a comparison in JavaScript.** The no-regression rule (R5, R8) and the
 *   "a tombstone is terminal" rule (R6) live in the `WHERE` of the write itself, and each statement reports
 *   what it actually changed through `RETURNING`. A command that read the row, decided, and then wrote would
 *   settle nothing about a concurrent delivery of the same replay, and persistence.md names exactly that
 *   hazard. The counts a caller sees are counts of writes, not of intentions.
 * - **Content and attachment metadata are dropped physically, and nothing else is.** A tombstone sets
 *   `content = NULL` and deletes the attachment rows; the id, author, both instants and `deleted_at` stay
 *   (ADR-0007). No statement in this file deletes a message row.
 *
 * Values only ever arrive as bound parameters, including the ids inside `ANY($n::bigint[])` and the per-column
 * arrays of a batched `UNNEST`; there is no interpolated identifier anywhere. Batches are bounded by the
 * configured size, one transaction each, and the bulk exclusion declares its page bound before it runs
 * (persistence.md: "Batch writes must declare a page or key bound before execution").
 */

/** One message's attachment set, as the replacement statement needs it: which row, and what belongs to it. */
interface AttachmentSet {
	readonly messageId: DiscordIdentifier;
	readonly attachments: readonly StoredMessageAttachment[];
}

/** R4's whole-row write, guarded so a replay and a late backfill record can neither duplicate nor regress it. */
const UPSERT_MESSAGES_STATEMENT = `
	INSERT INTO message
		(message_id, guild_id, channel_id, author_id, author_username, author_is_bot, webhook_id,
		 message_type, content, created_instant, edited_instant,
		 reply_message_id, reply_channel_id, reply_guild_id)
	SELECT s.message_id, s.guild_id, s.channel_id, s.author_id, s.author_username, s.author_is_bot, s.webhook_id,
		s.message_type, s.content, s.created_instant, s.edited_instant,
		s.reply_message_id, s.reply_channel_id, s.reply_guild_id
	FROM UNNEST(
		$1::bigint[], $2::bigint[], $3::bigint[], $4::bigint[], $5::text[], $6::boolean[], $7::bigint[],
		$8::text[], $9::text[], $10::timestamptz[], $11::timestamptz[],
		$12::bigint[], $13::bigint[], $14::bigint[]
	) AS s(
		message_id, guild_id, channel_id, author_id, author_username, author_is_bot, webhook_id,
		message_type, content, created_instant, edited_instant,
		reply_message_id, reply_channel_id, reply_guild_id
	)
	ON CONFLICT (message_id) DO UPDATE SET
		guild_id = EXCLUDED.guild_id,
		channel_id = EXCLUDED.channel_id,
		author_id = EXCLUDED.author_id,
		author_username = EXCLUDED.author_username,
		author_is_bot = EXCLUDED.author_is_bot,
		webhook_id = EXCLUDED.webhook_id,
		message_type = EXCLUDED.message_type,
		content = EXCLUDED.content,
		created_instant = EXCLUDED.created_instant,
		edited_instant = EXCLUDED.edited_instant,
		reply_message_id = EXCLUDED.reply_message_id,
		reply_channel_id = EXCLUDED.reply_channel_id,
		reply_guild_id = EXCLUDED.reply_guild_id
	WHERE message.deleted_at IS NULL
		AND (
			message.edited_instant IS NULL
			OR (EXCLUDED.edited_instant IS NOT NULL AND EXCLUDED.edited_instant >= message.edited_instant)
		)
		AND (
			message.content IS DISTINCT FROM EXCLUDED.content
			OR message.edited_instant IS DISTINCT FROM EXCLUDED.edited_instant
			OR message.message_type IS DISTINCT FROM EXCLUDED.message_type
			OR message.author_id IS DISTINCT FROM EXCLUDED.author_id
			OR message.channel_id IS DISTINCT FROM EXCLUDED.channel_id
			OR message.author_username IS DISTINCT FROM EXCLUDED.author_username
			OR message.author_is_bot IS DISTINCT FROM EXCLUDED.author_is_bot
			OR message.webhook_id IS DISTINCT FROM EXCLUDED.webhook_id
			OR message.created_instant IS DISTINCT FROM EXCLUDED.created_instant
			OR message.reply_message_id IS DISTINCT FROM EXCLUDED.reply_message_id
			OR message.reply_channel_id IS DISTINCT FROM EXCLUDED.reply_channel_id
			OR message.reply_guild_id IS DISTINCT FROM EXCLUDED.reply_guild_id
		)
	RETURNING message_id
`;

/** R11: the attachment metadata of these messages, swept before the new set is inserted, in one statement. */
const DELETE_MESSAGE_ATTACHMENTS_STATEMENT = `
	DELETE FROM message_attachment AS a
	USING UNNEST($1::bigint[], $2::bigint[]) AS s(guild_id, message_id)
	WHERE a.guild_id = s.guild_id AND a.message_id = s.message_id
	RETURNING a.attachment_id
`;

const INSERT_MESSAGE_ATTACHMENTS_STATEMENT = `
	INSERT INTO message_attachment (message_id, attachment_id, guild_id, filename, url, content_type, size_bytes)
	SELECT s.message_id, s.attachment_id, s.guild_id, s.filename, s.url, s.content_type, s.size_bytes
	FROM UNNEST($1::bigint[], $2::bigint[], $3::bigint[], $4::text[], $5::text[], $6::text[], $7::bigint[])
		AS s(message_id, attachment_id, guild_id, filename, url, content_type, size_bytes)
	ON CONFLICT (message_id, attachment_id) DO UPDATE SET
		guild_id = EXCLUDED.guild_id,
		filename = EXCLUDED.filename,
		url = EXCLUDED.url,
		content_type = EXCLUDED.content_type,
		size_bytes = EXCLUDED.size_bytes
	RETURNING attachment_id
`;

const MESSAGE_COLUMNS = `message_id, guild_id, channel_id, author_id, author_username, author_is_bot, webhook_id,
	message_type, content, created_instant, edited_instant,
	reply_message_id, reply_channel_id, reply_guild_id, deleted_at`;

const FIND_MESSAGE_STATEMENT = `
	SELECT ${MESSAGE_COLUMNS}
	FROM message
	WHERE guild_id = $1 AND message_id = $2
`;

const FIND_MESSAGE_ATTACHMENTS_STATEMENT = `
	SELECT attachment_id, filename, url, content_type, size_bytes
	FROM message_attachment
	WHERE guild_id = $1 AND message_id = ANY($2::bigint[])
	ORDER BY message_id, attachment_id
`;

/** R5, in the statement: replace content and edit instant, and only when the incoming state is not older. */
const APPLY_MESSAGE_EDIT_STATEMENT = `
	UPDATE message AS m
	SET content = $3::text,
		edited_instant = $4::timestamptz,
		message_type = COALESCE($5::text, m.message_type)
	WHERE m.guild_id = $1
		AND m.message_id = $2
		AND m.deleted_at IS NULL
		AND (m.edited_instant IS NULL OR ($4::timestamptz IS NOT NULL AND m.edited_instant <= $4))
		AND (
			m.content IS DISTINCT FROM $3::text
			OR m.edited_instant IS DISTINCT FROM $4::timestamptz
			OR COALESCE($5::text, m.message_type) IS DISTINCT FROM m.message_type
		)
	RETURNING m.edited_instant
`;

/** R6: what the named ids look like right now, so a replay's counts name the difference instead of hiding it. */
const FIND_TOMBSTONE_STATE_STATEMENT = `
	SELECT message_id, deleted_at
	FROM message
	WHERE guild_id = $1 AND message_id = ANY($2::bigint[])
	ORDER BY message_id
`;

const TOMBSTONE_MESSAGES_STATEMENT = `
	UPDATE message
	SET content = NULL, deleted_at = $3::timestamptz
	WHERE guild_id = $1 AND message_id = ANY($2::bigint[]) AND deleted_at IS NULL
	RETURNING message_id
`;

const FIND_EXCLUSION_PAGE_STATEMENT = `
	SELECT message_id
	FROM message
	WHERE guild_id = $1 AND channel_id = ANY($2::bigint[]) AND deleted_at IS NULL
	ORDER BY message_id
	LIMIT $3
`;

type MessageRow = {
	message_id: string;
	guild_id: string;
	channel_id: string;
	author_id: string;
	author_username: string | null;
	author_is_bot: boolean | null;
	webhook_id: string | null;
	message_type: string;
	content: string | null;
	created_instant: Date;
	edited_instant: Date | null;
	reply_message_id: string | null;
	reply_channel_id: string | null;
	reply_guild_id: string | null;
	deleted_at: Date | null;
};

type AttachmentRow = {
	attachment_id: string;
	filename: string;
	url: string;
	content_type: string | null;
	size_bytes: string;
};

/**
 * The row mappers, with the one widening cast among them. `message_type` is `text` because the normalized type
 * names are the `discord` feature's vocabulary and stay open to new kinds (its R3 refuses to drop an unknown
 * kind), so reading one back is a widening the schema already made — the same reasoning and the same
 * single-cast rule as guild-state's channel type. Nothing below this file sees anything but application types,
 * and `size_bytes` is parsed rather than trusted because `pg` returns `int8` as text.
 */
function toStoredMessage(row: MessageRow, attachments: readonly StoredMessageAttachment[]): StoredMessage {
	return tombstoneProjection({
		guildId: row.guild_id,
		messageId: row.message_id,
		channelId: row.channel_id,
		authorId: row.author_id,
		authorUsername: row.author_username,
		authorIsBot: row.author_is_bot,
		webhookId: row.webhook_id,
		messageType: row.message_type as NormalizedMessageType,
		content: row.content,
		createdInstant: row.created_instant,
		editedInstant: row.edited_instant,
		replyReference:
			row.reply_message_id === null
				? null
				: { messageId: row.reply_message_id, channelId: row.reply_channel_id, guildId: row.reply_guild_id },
		attachments,
		deletedAt: row.deleted_at
	});
}

function toStoredAttachment(row: AttachmentRow): StoredMessageAttachment {
	return {
		attachmentId: row.attachment_id,
		filename: row.filename,
		url: row.url,
		contentType: row.content_type,
		sizeBytes: requireSizeBytes("message_attachment.size_bytes", row.size_bytes)
	};
}

export class PostgresMessageStoreRepository implements MessageStoreRepository {
	public constructor(
		private readonly deps: {
			readonly executor: SqlExecutor;
			readonly writeBatchSize: number;
			readonly exclusionPageSize: number;
		}
	) {}

	public readonly upsertMessages = async (messages: readonly MessageWrite[]): Promise<MessageBatchWriteResult> => {
		const validated = messages.map(validateMessageWrite);

		let rowsWritten = 0;
		let rowsSkipped = 0;
		let attachmentsWritten = 0;
		let attachmentsRemoved = 0;
		let batches = 0;

		for (const batch of splitWriteBatch(validated, this.deps.writeBatchSize)) {
			batches += 1;
			const outcome = await this.writeMessageBatch(batch);
			rowsWritten += outcome.rowsWritten;
			rowsSkipped += outcome.rowsSkipped;
			attachmentsWritten += outcome.attachmentsWritten;
			attachmentsRemoved += outcome.attachmentsRemoved;
		}

		return { rowsWritten, rowsSkipped, attachmentsWritten, attachmentsRemoved, batches };
	};

	public readonly findMessage = async (
		guildId: DiscordIdentifier,
		messageId: DiscordIdentifier
	): Promise<StoredMessage | null> => {
		const scopedGuildId = requireDiscordIdentifier("message.guild_id", guildId);
		const scopedMessageId = requireDiscordIdentifier("message.message_id", messageId);

		const { rows } = await this.deps.executor.query<MessageRow>(FIND_MESSAGE_STATEMENT, [
			scopedGuildId,
			scopedMessageId
		]);
		const row = rows[0];
		if (row === undefined) {
			return null;
		}

		const stored = toStoredMessage(row, []);
		// A tombstone's attachment rows were deleted along with its content, so the metadata read is issued only
		// for a live row: R6's exclusion costs no statement for a message that has nothing left to exclude (R11).
		if (messageIsTombstoned(stored)) {
			return stored;
		}
		return toStoredMessage(row, await this.readAttachments(this.deps.executor, scopedGuildId, [scopedMessageId]));
	};

	public readonly applyMessageEdit = async (edit: MessageEditWrite): Promise<MessageEditWriteResult> => {
		const validated = validateMessageEdit(edit);
		// One local per fact the two paths turn on: a property test does not survive into the transaction
		// callback below, and which rows are written must not depend on where the statement happens to run.
		const reportsAttachmentSet = validated.attachments !== null;
		const attachmentSets: readonly AttachmentSet[] = reportsAttachmentSet
			? [{ messageId: validated.messageId, attachments: validated.attachments ?? [] }]
			: [];

		if (!reportsAttachmentSet) {
			// One statement for the common path, exactly as persistence.md asks: a single-event application is a
			// single statement with its guard in the WHERE, and the refusal classification is a point read that
			// runs only when the guard refused.
			const applied = await this.writeEdit(this.deps.executor, validated);
			return applied ?? (await this.classifyRefusal(this.deps.executor, validated));
		}

		// The content write and the attachment-set replacement are one atomic replacement (R5 with R11): a
		// failure between them would leave newer text describing older attachments.
		return this.deps.executor.transaction(async (session) => {
			const applied = await this.writeEdit(session, validated);
			if (applied === null) {
				return this.classifyRefusal(session, validated);
			}
			const replacement = await this.replaceAttachmentSets(session, validated.guildId, attachmentSets);
			return {
				...applied,
				attachmentsRemoved: replacement.removed,
				attachmentsWritten: replacement.written
			};
		});
	};

	public readonly tombstoneMessages = async (tombstone: MessageTombstoneWrite): Promise<MessageTombstoneResult> => {
		const validated = validateMessageTombstone(tombstone);

		let messagesTombstoned = 0;
		let attachmentsRemoved = 0;
		let alreadyTombstoned = 0;
		let batches = 0;
		const unknownMessageIds: DiscordIdentifier[] = [];

		for (const batch of splitWriteBatch(validated.messageIds, this.deps.writeBatchSize)) {
			batches += 1;
			const outcome = await this.tombstoneBatch(validated.guildId, batch, validated.deletedAt);
			unknownMessageIds.push(...batch.filter((messageId) => !outcome.presentIds.includes(messageId)));

			messagesTombstoned += outcome.tombstoned;
			attachmentsRemoved += outcome.removed;
			alreadyTombstoned += outcome.presentIds.length - outcome.tombstoned;
		}

		return {
			messagesTombstoned,
			attachmentsRemoved,
			alreadyTombstoned,
			unknownMessageIds: Object.freeze(unknownMessageIds),
			batches
		};
	};

	public readonly excludeChannelMessages = async (
		exclusion: ChannelMessageExclusion
	): Promise<ChannelExclusionResult> => {
		const validated = validateChannelExclusion(exclusion);

		let messagesTombstoned = 0;
		let attachmentsRemoved = 0;
		let batches = 0;

		// Bounded by the declared page size, and terminating because every row a page returns is marked in the
		// same transaction and so cannot match the page predicate again. Progress is structural rather than a
		// retry budget, which is why no page cap can cut a sweep short and still report it as an exclusion
		// (R6: the messages of a removed channel all of them, not the first page of them).
		for (;;) {
			const page = await this.deps.executor.transaction(async (session) => {
				const found = await session.query<{ message_id: string }>(FIND_EXCLUSION_PAGE_STATEMENT, [
					validated.guildId,
					validated.channelIds,
					this.deps.exclusionPageSize
				]);
				const ids = found.rows.map((row) => row.message_id);
				if (ids.length === 0) {
					return { swept: 0, tombstoned: 0, removed: 0 };
				}
				const swept = await this.replaceAttachmentSets(
					session,
					validated.guildId,
					ids.map((messageId) => ({ messageId, attachments: [] }))
				);
				const written = await session.query<{ message_id: string }>(TOMBSTONE_MESSAGES_STATEMENT, [
					validated.guildId,
					ids,
					validated.deletedAt
				]);
				return { swept: ids.length, tombstoned: written.rows.length, removed: swept.removed };
			});

			if (page.swept === 0) {
				break;
			}
			batches += 1;
			messagesTombstoned += page.tombstoned;
			attachmentsRemoved += page.removed;
			if (page.swept < this.deps.exclusionPageSize) {
				break;
			}
		}

		return { messagesTombstoned, attachmentsRemoved, batches };
	};

	/**
	 * One bounded batch, in one transaction: the guarded whole-row upsert, then the attachment replacement for
	 * exactly those messages the guard wrote and whose payload reported a set. A message the guard refused is a
	 * message whose stored state is newer, so its attachment set must stay exactly as stored (R8) — which is why
	 * the replacement keys off the statement's own `RETURNING` and not off the input list.
	 */
	private readonly writeMessageBatch = async (
		batch: readonly MessageWrite[]
	): Promise<{
		rowsWritten: number;
		rowsSkipped: number;
		attachmentsWritten: number;
		attachmentsRemoved: number;
	}> => {
		return this.deps.executor.transaction(async (session) => {
			const written = await session.query<{ message_id: string }>(UPSERT_MESSAGES_STATEMENT, [
				batch.map((message) => message.messageId),
				batch.map((message) => message.guildId),
				batch.map((message) => message.channelId),
				batch.map((message) => message.authorId),
				batch.map((message) => message.authorUsername),
				batch.map((message) => message.authorIsBot),
				batch.map((message) => message.webhookId),
				batch.map((message) => message.messageType),
				batch.map((message) => message.content),
				batch.map((message) => message.createdInstant),
				batch.map((message) => message.editedInstant),
				batch.map((message) => message.replyReference?.messageId ?? null),
				batch.map((message) => message.replyReference?.channelId ?? null),
				batch.map((message) => message.replyReference?.guildId ?? null)
			]);

			const writtenIds = new Set(written.rows.map((row) => row.message_id));
			const reported = batch.filter(
				(message) => message.attachments !== null && writtenIds.has(message.messageId)
			);
			const replacement = await this.replaceReportedAttachmentSets(session, reported);

			return {
				rowsWritten: written.rows.length,
				rowsSkipped: batch.length - written.rows.length,
				attachmentsWritten: replacement.written,
				attachmentsRemoved: replacement.removed
			};
		});
	};

	/**
	 * R6 for one bounded id list, in one transaction: read the state of what the deletion named, drop the
	 * attachment metadata of the rows that were still live, then mark those rows. Reading first is what makes
	 * the reported counts the three different facts they have to be — tombstoned now, already tombstoned, and
	 * never stored — without a second statement going looking for them afterwards.
	 */
	private readonly tombstoneBatch = async (
		guildId: DiscordIdentifier,
		messageIds: readonly DiscordIdentifier[],
		deletedAt: Date
	): Promise<{ tombstoned: number; removed: number; presentIds: readonly DiscordIdentifier[] }> => {
		return this.deps.executor.transaction(async (session) => {
			const state = await session.query<{ message_id: string; deleted_at: Date | null }>(
				FIND_TOMBSTONE_STATE_STATEMENT,
				[guildId, messageIds]
			);
			const presentIds = state.rows.map((row) => row.message_id);
			const liveIds = state.rows.filter((row) => row.deleted_at === null).map((row) => row.message_id);
			if (liveIds.length === 0) {
				return { tombstoned: 0, removed: 0, presentIds };
			}

			// Attachments first, so the count is the count of rows that really existed under these messages, and
			// content second: one transaction, so no read can ever see dropped content with its attachment
			// metadata still listed (R6, ADR-0007).
			const swept = await this.replaceAttachmentSets(
				session,
				guildId,
				liveIds.map((messageId) => ({ messageId, attachments: [] }))
			);
			const written = await session.query<{ message_id: string }>(TOMBSTONE_MESSAGES_STATEMENT, [
				guildId,
				liveIds,
				deletedAt
			]);
			return { tombstoned: written.rows.length, removed: swept.removed, presentIds };
		});
	};

	/** Attachment sets of one batch, grouped by Guild: a set belongs to the Guild its message row names. */
	private readonly replaceReportedAttachmentSets = async (
		session: SqlStatementRunner,
		messages: readonly MessageWrite[]
	): Promise<{ removed: number; written: number }> => {
		let removed = 0;
		let written = 0;
		const byGuild = new Map<DiscordIdentifier, AttachmentSet[]>();
		for (const message of messages) {
			if (message.attachments === null) {
				continue;
			}
			const sets = byGuild.get(message.guildId) ?? [];
			sets.push({ messageId: message.messageId, attachments: message.attachments });
			byGuild.set(message.guildId, sets);
		}

		for (const [guildId, sets] of byGuild) {
			const outcome = await this.replaceAttachmentSets(session, guildId, sets);
			removed += outcome.removed;
			written += outcome.written;
		}
		return { removed, written };
	};

	/**
	 * Sweep-then-insert of the attachment metadata of these messages. A set listed as empty is the payload's own
	 * "this message has no attachments" and is swept without a re-insert (R11); a message that is not named at
	 * all is not touched, because absent is never empty (docs/features/discord.md R3).
	 */
	private readonly replaceAttachmentSets = async (
		session: SqlStatementRunner,
		guildId: DiscordIdentifier,
		sets: readonly AttachmentSet[]
	): Promise<{ removed: number; written: number }> => {
		if (sets.length === 0) {
			return { removed: 0, written: 0 };
		}
		const messageIds = sets.map((set) => set.messageId);
		const swept = await session.query<{ attachment_id: string }>(DELETE_MESSAGE_ATTACHMENTS_STATEMENT, [
			messageIds.map(() => guildId),
			messageIds
		]);

		const rows = sets.flatMap((set) => set.attachments.map((attachment) => ({ set, attachment })));
		if (rows.length === 0) {
			return { removed: swept.rows.length, written: 0 };
		}

		const inserted = await session.query<{ attachment_id: string }>(INSERT_MESSAGE_ATTACHMENTS_STATEMENT, [
			rows.map((row) => row.set.messageId),
			rows.map((row) => row.attachment.attachmentId),
			rows.map(() => guildId),
			rows.map((row) => row.attachment.filename),
			rows.map((row) => row.attachment.url),
			rows.map((row) => row.attachment.contentType),
			// `size_bytes` is a `bigint` column, and a bigint parameter is bound as text: the same rule the
			// ids obey, applied to the one numeric column this table has (persistence.md).
			rows.map((row) => String(row.attachment.sizeBytes))
		]);
		return { removed: swept.rows.length, written: inserted.rows.length };
	};

	private readonly readAttachments = async (
		runner: SqlStatementRunner,
		guildId: DiscordIdentifier,
		messageIds: readonly DiscordIdentifier[]
	): Promise<readonly StoredMessageAttachment[]> => {
		if (messageIds.length === 0) {
			return Object.freeze([]);
		}
		const { rows } = await runner.query<AttachmentRow>(FIND_MESSAGE_ATTACHMENTS_STATEMENT, [guildId, messageIds]);
		return Object.freeze(rows.map(toStoredAttachment));
	};

	/** The guarded edit statement itself. `null` means a guard refused it, and the caller classifies why. */
	private readonly writeEdit = async (
		runner: SqlStatementRunner,
		edit: MessageEditWrite
	): Promise<MessageEditWriteResult | null> => {
		const written = await runner.query<{ edited_instant: Date | null }>(APPLY_MESSAGE_EDIT_STATEMENT, [
			edit.guildId,
			edit.messageId,
			edit.content,
			edit.editedInstant,
			edit.messageType
		]);
		const row = written.rows[0];
		if (row === undefined) {
			return null;
		}
		return {
			status: "applied",
			storedEditedInstant: row.edited_instant,
			attachmentsRemoved: 0,
			attachmentsWritten: 0
		};
	};

	/**
	 * Why a guarded edit wrote nothing. One point read, only on the refusal path, separating the cases a caller
	 * has to report differently (R5, R6, R7, R8) — and `stale` against `unchanged` is decided by the same domain
	 * rule the statement's `WHERE` encodes, so the code and the SQL can never disagree about what regressed.
	 */
	private readonly classifyRefusal = async (
		runner: SqlStatementRunner,
		edit: MessageEditWrite
	): Promise<MessageEditWriteResult> => {
		const { rows } = await runner.query<MessageRow>(FIND_MESSAGE_STATEMENT, [edit.guildId, edit.messageId]);
		const row = rows[0];
		if (row === undefined) {
			return this.refusal("absent", null);
		}
		const stored = toStoredMessage(row, []);
		if (messageIsTombstoned(stored)) {
			return this.refusal("tombstoned", stored.editedInstant);
		}
		return this.refusal(
			editWouldRegress(stored.editedInstant, edit.editedInstant) ? "stale" : "unchanged",
			stored.editedInstant
		);
	};

	private readonly refusal = (
		status: MessageEditWriteResult["status"],
		storedEditedInstant: Date | null
	): MessageEditWriteResult => ({ status, storedEditedInstant, attachmentsRemoved: 0, attachmentsWritten: 0 });
}
