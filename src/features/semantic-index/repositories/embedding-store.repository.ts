import type { HybridFilters } from "../queries/hybrid-retrieval.interface.js";
export const EMBEDDING_DIMENSION = 1536;
export const EMBEDDING_BATCH_LIMIT = 64;

export interface PendingEmbedding {
	readonly messageId: string;
	readonly content: string;
	readonly contentRevision: string;
}

export interface EmbeddingWrite {
	readonly messageId: string;
	readonly contentRevision: string;
	readonly embedding: readonly number[];
}

export interface VectorCandidate {
	readonly messageId: string;
	readonly channelId: string;
	readonly createdInstant: Date;
	readonly editedInstant: Date | null;
}

/** Accessible channel/thread ids must come from query-time permission evaluation. */
export interface NearestEmbeddingRequest extends HybridFilters {
	readonly model: string;
	readonly embedding: readonly number[];
	readonly accessibleChannelIds: readonly string[];
	readonly limit: number;
}

export interface EmbeddingStoreRepository {
	readonly fetchNextUnembedded: (model: string, limit: number) => Promise<readonly PendingEmbedding[]>;
	readonly upsertBatch: (model: string, writes: readonly EmbeddingWrite[]) => Promise<number>;
	readonly deleteByMessageIds: (messageIds: readonly string[]) => Promise<number>;
	readonly nearest: (request: NearestEmbeddingRequest) => Promise<readonly VectorCandidate[]>;
}
