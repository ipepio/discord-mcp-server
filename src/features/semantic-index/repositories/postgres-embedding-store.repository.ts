import { EMBEDDING_BATCH_LIMIT, EMBEDDING_DIMENSION } from "./embedding-store.repository.js";
import type {
	EmbeddingStoreRepository,
	EmbeddingWrite,
	NearestEmbeddingRequest,
	PendingEmbedding,
	VectorCandidate
} from "./embedding-store.repository.js";

/** Single-statement pool seam; no transaction or provider call spans these operations. */
export interface EmbeddingSqlExecutor {
	readonly query: <Row>(
		statement: string,
		parameters?: readonly unknown[]
	) => Promise<{ readonly rows: readonly Row[] }>;
}

export function requireEmbeddingLimit(limit: number): void {
	if (!Number.isInteger(limit) || limit < 1 || limit > EMBEDDING_BATCH_LIMIT) {
		throw new Error("Embedding batch limit must be between 1 and 64");
	}
}

export function embeddingLiteral(embedding: readonly number[]): string {
	if (embedding.length !== EMBEDDING_DIMENSION || !embedding.every(Number.isFinite)) {
		throw new Error("Embedding has an invalid dimension or non-finite coordinates");
	}
	return JSON.stringify(embedding);
}

interface CandidateRow {
	readonly message_id: string;
	readonly channel_id: string;
	readonly created_instant: Date;
	readonly edited_instant: Date | null;
}

export class PostgresEmbeddingStoreRepository implements EmbeddingStoreRepository {
	constructor(private readonly sql: EmbeddingSqlExecutor) {}

	async fetchNextUnembedded(model: string, limit: number): Promise<readonly PendingEmbedding[]> {
		requireEmbeddingLimit(limit);
		const { rows } = await this.sql.query<{
			message_id: string;
			content: string;
			content_revision: string;
		}>(
			`
			SELECT m.message_id::text, m.content, encode(sha256(convert_to(m.content, 'UTF8')), 'hex') AS content_revision
			FROM message m
			WHERE m.deleted_at IS NULL AND m.content ~ '[^[:space:]]'
			AND NOT EXISTS (
				SELECT 1 FROM message_embeddings e
				WHERE e.message_id = m.message_id AND e.model = $1
					AND e.content_revision = encode(sha256(convert_to(m.content, 'UTF8')), 'hex')
			)
			ORDER BY m.message_id LIMIT $2
		`,
			[model, limit]
		);
		return rows.map((row) => ({
			messageId: row.message_id,
			content: row.content,
			contentRevision: row.content_revision
		}));
	}

	async upsertBatch(model: string, writes: readonly EmbeddingWrite[]): Promise<number> {
		if (writes.length === 0) return 0;
		requireEmbeddingLimit(writes.length);
		const payload = writes.map((write) => ({
			message_id: write.messageId,
			content_revision: write.contentRevision,
			embedding: embeddingLiteral(write.embedding)
		}));
		const { rows } = await this.sql.query<{ message_id: string }>(
			`
			WITH source AS (
				SELECT m.message_id, p.content_revision, p.embedding::vector AS embedding
				FROM jsonb_to_recordset($2::jsonb) AS p(message_id bigint, content_revision text, embedding text)
				JOIN message m ON m.message_id = p.message_id
				WHERE m.deleted_at IS NULL AND m.content ~ '[^[:space:]]'
					AND encode(sha256(convert_to(m.content, 'UTF8')), 'hex') = p.content_revision
				FOR UPDATE OF m
			)
			INSERT INTO message_embeddings (message_id, model, content_revision, embedding)
			SELECT message_id, $1, content_revision, embedding FROM source
			ON CONFLICT (message_id, model) DO UPDATE SET
				content_revision = EXCLUDED.content_revision, embedding = EXCLUDED.embedding
			RETURNING message_id::text
		`,
			[model, JSON.stringify(payload)]
		);
		return rows.length;
	}

	async deleteByMessageIds(messageIds: readonly string[]): Promise<number> {
		if (messageIds.length === 0) return 0;
		requireEmbeddingLimit(messageIds.length);
		const { rows } = await this.sql.query<{ message_id: string }>(
			"DELETE FROM message_embeddings WHERE message_id = ANY($1::bigint[]) RETURNING message_id::text",
			[messageIds]
		);
		return rows.length;
	}

	async nearest(request: NearestEmbeddingRequest): Promise<readonly VectorCandidate[]> {
		requireEmbeddingLimit(request.limit);
		const vector = embeddingLiteral(request.embedding);
		if (request.accessibleChannelIds.length === 0) return [];
		const { rows } = await this.sql.query<CandidateRow>(
			`
			SELECT m.message_id::text, m.channel_id::text, m.created_instant, m.edited_instant
			FROM message_embeddings e JOIN message m ON m.message_id = e.message_id
			WHERE e.model = $1 AND m.deleted_at IS NULL
				AND e.content_revision = encode(sha256(convert_to(m.content, 'UTF8')), 'hex')
				AND m.channel_id = ANY($3::bigint[])
				AND ($5::bigint[] IS NULL OR m.channel_id = ANY($5::bigint[]))
				AND ($6::bigint IS NULL OR m.author_id = $6)
				AND ($7::timestamptz IS NULL OR m.created_instant >= $7)
				AND ($8::timestamptz IS NULL OR m.created_instant <= $8)
			ORDER BY e.embedding <=> $2::vector, m.message_id LIMIT $4
		`,
			[
				request.model,
				vector,
				request.accessibleChannelIds,
				request.limit,
				request.channelIds ?? null,
				request.authorId ?? null,
				request.from ?? null,
				request.to ?? null
			]
		);
		return rows.map((row) => ({
			messageId: row.message_id,
			channelId: row.channel_id,
			createdInstant: row.created_instant,
			editedInstant: row.edited_instant
		}));
	}
}
