export const HYBRID_RETRIEVAL = "QUERY_HYBRID_RETRIEVAL";

export interface HybridFilters {
	readonly channelIds?: readonly string[];
	readonly authorId?: string;
	readonly from?: Date;
	readonly to?: Date;
}

/** Consumer contract, owned here with the producer; compatibility names are mapped before I/O. */
export interface QueryHybridCandidate {
	readonly messageId: string;
	readonly channelId: string;
	readonly parentChannelId: string | null;
	readonly createdAt: string;
	readonly rank: number;
}
export interface QueryHybridInput {
	readonly query: string;
	readonly guildId: string;
	readonly accessibleChannelIds: readonly string[];
	readonly channelId?: string;
	readonly authorId?: string;
	readonly from?: string;
	readonly to?: string;
	readonly after?: { readonly rank: number; readonly messageId: string };
	readonly limit: number;
}
export interface QueryHybridRetrieval {
	readonly execute: (input: QueryHybridInput) => Promise<{
		readonly candidates: readonly QueryHybridCandidate[];
		readonly retrieval: "hybrid" | "full-text-only";
	}>;
}

/** Required query-time accessible channel AND thread ids; an empty set means deny all. */
export interface HybridRetrievalRequest extends HybridFilters {
	readonly cursor?: { readonly score: number; readonly messageId: string };
	readonly text: string;
	readonly accessibleChannelIds: readonly string[];
	readonly limit: number;
}

export interface HybridCandidate {
	readonly messageId: string;
	/** Discord container id; a thread's id is its channel id, never its parent's id. */
	readonly channelId: string;
	readonly createdInstant: Date;
	readonly editedInstant: Date | null;
	readonly score: number;
	readonly branches: readonly ("fts" | "vector")[];
}

export interface HybridRetrievalResult {
	readonly candidates: readonly HybridCandidate[];
	readonly vectorAvailable: boolean;
}

/** The query feature consumes only this use-case contract, not provider or table types. */
export interface HybridRetrieval {
	readonly execute: (request: HybridRetrievalRequest) => Promise<HybridRetrievalResult>;
}
