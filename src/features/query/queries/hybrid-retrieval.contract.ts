/** The producer owns the contract; query consumes only its public, framework-free seam. */
export type {
	QueryHybridCandidate as HybridCandidate,
	QueryHybridInput as HybridRetrievalInput,
	QueryHybridRetrieval as HybridRetrieval
} from "../../semantic-index/index.js";
