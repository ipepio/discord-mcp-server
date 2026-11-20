import type { HybridFilters } from "../queries/hybrid-retrieval.interface.js";
import type { VectorCandidate } from "./embedding-store.repository.js";

export interface FullTextCandidatesRepository {
	readonly search: (
		text: string,
		accessibleChannelIds: readonly string[],
		limit: number,
		filters?: HybridFilters
	) => Promise<readonly VectorCandidate[]>;
}
