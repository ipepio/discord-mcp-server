import type { AttachmentMetadata, StoredMessage } from "../models/domain/message.js";
import type {
	ActivityChannelCount,
	ActivityPageInput,
	ActivityReadInput,
	ActivityReadRepository,
	CandidateReadInput,
	MessagePageInput,
	MessageReadRepository,
	MessageReadScope,
	MessageWindowInput
} from "./message-read.repository.js";

export interface QuerySqlExecutor {
	readonly query: <Row>(sql: string, values: readonly unknown[]) => Promise<{ readonly rows: readonly Row[] }>;
}
interface MessageRow {
	message_id: string;
	guild_id: string;
	channel_id: string;
	author_id: string;
	author_username: string | null;
	created_instant: Date;
	edited_instant: Date | null;
	message_type: string;
	reply_message_id: string | null;
	content: string;
	content_length: number;
	attachments: AttachmentMetadata[];
}
const columns = `m.message_id::text, m.guild_id::text, m.channel_id::text, m.author_id::text,
 m.author_username, m.created_instant, m.edited_instant, m.message_type, m.reply_message_id::text,
 m.content, char_length(m.content)::integer AS content_length,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('attachmentId', a.attachment_id::text,
 'filename', a.filename, 'contentType', a.content_type, 'sizeBytes', a.size_bytes,
 'url', a.url) ORDER BY a.attachment_id) FROM message_attachment a
 WHERE a.guild_id = m.guild_id AND a.message_id = m.message_id), '[]'::jsonb) AS attachments`;
// Ingestion intentionally has no FK to registry tables. Live registry IDs are the deleted-container predicate.
const scope = `m.guild_id = $1::bigint AND m.channel_id = ANY($2::bigint[]) AND m.deleted_at IS NULL`;

export class PostgresMessageReadRepository implements MessageReadRepository, ActivityReadRepository {
	public constructor(private readonly sql: QuerySqlExecutor) {}
	public async readPage(input: MessagePageInput): Promise<readonly StoredMessage[]> {
		bound(input.pageSize);
		// R13: recent-first, so a page without a key starts at the newest row of the filter window and every
		// continuation compares `<` against its key. `from`/`to` stay the same inclusive predicates.
		const result = await this.sql.query<MessageRow>(
			`SELECT ${columns} FROM message m WHERE ${scope}
 AND m.channel_id = $3::bigint AND ($4::timestamptz IS NULL OR m.created_instant >= $4)
 AND ($5::timestamptz IS NULL OR m.created_instant <= $5)
 AND ($6::timestamptz IS NULL OR (m.created_instant, m.message_id) < ($6::timestamptz, $7::bigint))
 ORDER BY m.created_instant DESC, m.message_id DESC LIMIT $8`,
			[
				input.guildId,
				input.accessibleChannelIds,
				input.channelId,
				input.from ?? null,
				input.to ?? null,
				input.before?.createdAt ?? null,
				input.before?.messageId ?? null,
				input.pageSize + 1
			]
		);
		return result.rows.map(mapMessage);
	}
	public async readCandidates(input: CandidateReadInput): Promise<readonly StoredMessage[]> {
		bound(input.pageSize);
		if (input.messageIds.length > input.pageSize + 1) throw new Error("Candidate set exceeds page bound");
		const result = await this.sql.query<MessageRow>(
			`SELECT ${columns} FROM message m WHERE ${scope}
 AND m.message_id = ANY($3::bigint[]) ORDER BY m.created_instant, m.message_id LIMIT $4`,
			[input.guildId, input.accessibleChannelIds, input.messageIds, input.pageSize + 1]
		);
		return result.rows.map(mapMessage);
	}
	public async readWindow(input: MessageWindowInput): Promise<readonly StoredMessage[]> {
		bound(input.windowSize);
		const result = await this.sql.query<MessageRow>(
			`WITH anchor AS (
 SELECT m.channel_id, m.created_instant, m.message_id FROM message m WHERE ${scope} AND m.message_id = $3::bigint
 ), older AS (
 SELECT m.message_id FROM message m JOIN anchor x ON m.channel_id = x.channel_id
 WHERE ${scope} AND (m.created_instant, m.message_id) < (x.created_instant, x.message_id)
 ORDER BY m.created_instant DESC, m.message_id DESC LIMIT $4
 ), newer AS (
 SELECT m.message_id FROM message m JOIN anchor x ON m.channel_id = x.channel_id
 WHERE ${scope} AND (m.created_instant, m.message_id) > (x.created_instant, x.message_id)
 ORDER BY m.created_instant, m.message_id LIMIT $5
 ) SELECT ${columns} FROM message m WHERE ${scope} AND m.message_id IN (
 SELECT message_id FROM anchor UNION ALL SELECT message_id FROM older UNION ALL SELECT message_id FROM newer)
 ORDER BY m.created_instant, m.message_id LIMIT $6`,
			[
				input.guildId,
				input.accessibleChannelIds,
				input.messageId,
				Math.floor((input.windowSize - 1) / 2),
				Math.ceil((input.windowSize - 1) / 2),
				input.windowSize
			]
		);
		return result.rows.map(mapMessage);
	}
	/**
	 * R14's grouped count: ONE statement over the whole scope set, never one per container. The cursor key, when
	 * the call continues a group, bounds it the same way the page read does, so the count is what the
	 * continuation can still reach — which is what makes the digest's `hasNext` exact.
	 */
	public async countWindowMessages(input: ActivityReadInput): Promise<readonly ActivityChannelCount[]> {
		const result = await this.sql.query<{ channel_id: string; message_count: number }>(
			`SELECT m.channel_id::text AS channel_id, COUNT(*)::integer AS message_count FROM message m WHERE ${scope}
 AND m.created_instant >= $3::timestamptz AND m.created_instant <= $4::timestamptz
 AND ($5::timestamptz IS NULL OR (m.created_instant, m.message_id) < ($5::timestamptz, $6::bigint))
 GROUP BY m.channel_id`,
			[
				input.guildId,
				input.accessibleChannelIds,
				input.since,
				input.until,
				input.before?.createdAt ?? null,
				input.before?.messageId ?? null
			]
		);
		return result.rows.map((row) => ({ channelId: row.channel_id, messageCount: row.message_count }));
	}
	/**
	 * R14's ONE partitioned page read: a window function ranks messages inside each container partition, so the
	 * scope set is read in a single statement and each container yields at most `pageSize + 1` rows (R4's probe).
	 * Ordering is the digest's own: container ascending, then recent-first inside it (R13's order).
	 */
	public async readActivityPage(input: ActivityPageInput): Promise<readonly StoredMessage[]> {
		bound(input.pageSize);
		const result = await this.sql.query<MessageRow>(
			`WITH ranked AS (
 SELECT m.message_id, row_number() OVER (
 PARTITION BY m.channel_id ORDER BY m.created_instant DESC, m.message_id DESC) AS activity_rank
 FROM message m WHERE ${scope}
 AND m.created_instant >= $3::timestamptz AND m.created_instant <= $4::timestamptz
 AND ($5::timestamptz IS NULL OR (m.created_instant, m.message_id) < ($5::timestamptz, $6::bigint))
 ) SELECT ${columns} FROM message m JOIN ranked r ON r.message_id = m.message_id
 WHERE r.activity_rank <= $7 ORDER BY m.channel_id, m.created_instant DESC, m.message_id DESC`,
			[
				input.guildId,
				input.accessibleChannelIds,
				input.since,
				input.until,
				input.before?.createdAt ?? null,
				input.before?.messageId ?? null,
				input.pageSize + 1
			]
		);
		return result.rows.map(mapMessage);
	}
	/** R14's anchor (O7): the Requester's newest authored instant in the scope, or nothing at all. */
	public async readMyLastMessageAt(input: MessageReadScope & { readonly authorId: string }): Promise<string | null> {
		const result = await this.sql.query<{ last_authored: Date | null }>(
			`SELECT MAX(m.created_instant) AS last_authored FROM message m WHERE ${scope} AND m.author_id = $3::bigint`,
			[input.guildId, input.accessibleChannelIds, input.authorId]
		);
		return result.rows[0]?.last_authored?.toISOString() ?? null;
	}
}
function bound(value: number): void {
	if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error("Invalid read bound");
}
function mapMessage(row: MessageRow): StoredMessage {
	return {
		messageId: row.message_id,
		guildId: row.guild_id,
		channelId: row.channel_id,
		authorId: row.author_id,
		authorDisplayName: row.author_username,
		createdAt: row.created_instant.toISOString(),
		editedAt: row.edited_instant?.toISOString() ?? null,
		messageType: row.message_type,
		replyToMessageId: row.reply_message_id,
		content: row.content,
		contentLength: row.content_length,
		attachments: row.attachments
	};
}
