import type { HybridFilters } from "../queries/hybrid-retrieval.interface.js";
import type { FullTextLanguage } from "../config/full-text-language.validator.js";
import type { FullTextCandidatesRepository } from "./full-text-candidates.repository.js";
import type { VectorCandidate } from "./embedding-store.repository.js";
import { requireEmbeddingLimit } from "./postgres-embedding-store.repository.js";
import type { EmbeddingSqlExecutor } from "./postgres-embedding-store.repository.js";

export class PostgresFullTextCandidatesRepository implements FullTextCandidatesRepository {
	constructor(
		private readonly sql: EmbeddingSqlExecutor,
		private readonly language: FullTextLanguage = "spanish"
	) {}

	async search(
		text: string,
		accessibleChannelIds: readonly string[],
		limit: number,
		filters: HybridFilters = {}
	): Promise<readonly VectorCandidate[]> {
		requireEmbeddingLimit(limit);
		if (accessibleChannelIds.length === 0) return [];
		const { rows } = await this.sql.query<{
			message_id: string;
			channel_id: string;
			created_instant: Date;
			edited_instant: Date | null;
		}>(
			`
			SELECT message_id::text, channel_id::text, created_instant, edited_instant
			FROM message
			WHERE deleted_at IS NULL AND channel_id = ANY($2::bigint[])
				AND ($5::bigint[] IS NULL OR channel_id = ANY($5::bigint[]))
				AND ($6::bigint IS NULL OR author_id = $6)
				AND ($7::timestamptz IS NULL OR created_instant >= $7)
				AND ($8::timestamptz IS NULL OR created_instant <= $8)
				AND to_tsvector($4::regconfig, content) @@ plainto_tsquery($4::regconfig, $1)
			ORDER BY ts_rank_cd(to_tsvector($4::regconfig, content), plainto_tsquery($4::regconfig, $1)) DESC, message_id
			LIMIT $3
		`,
			[
				text,
				accessibleChannelIds,
				limit,
				this.language,
				filters.channelIds ?? null,
				filters.authorId ?? null,
				filters.from ?? null,
				filters.to ?? null
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
