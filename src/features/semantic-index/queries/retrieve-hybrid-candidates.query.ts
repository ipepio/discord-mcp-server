import type { EmbeddingProvider } from "../gateways/embedding-provider.interface.js";
import type { EmbeddingStoreRepository, VectorCandidate } from "../repositories/embedding-store.repository.js";
import type { FullTextCandidatesRepository } from "../repositories/full-text-candidates.repository.js";
import type {
	QueryHybridInput,
	QueryHybridRetrieval,
	QueryHybridCandidate,
	HybridCandidate,
	HybridRetrieval,
	HybridRetrievalRequest,
	HybridRetrievalResult
} from "./hybrid-retrieval.interface.js";

const RRF_OFFSET = 60;

export class RetrieveHybridCandidatesQuery implements HybridRetrieval, QueryHybridRetrieval {
	constructor(
		private readonly fullText: FullTextCandidatesRepository,
		private readonly vectors: EmbeddingStoreRepository,
		private readonly provider: EmbeddingProvider,
		/** Internal quality tuning only; ACL remains mandatory for both branches. */
		overFetch = 2
	) {
		if (!Number.isInteger(overFetch) || overFetch < 1 || overFetch > 4)
			throw new Error("Invalid candidate over-fetch");
	}

	async execute(request: QueryHybridInput): Promise<{
		readonly candidates: readonly QueryHybridCandidate[];
		readonly retrieval: "hybrid" | "full-text-only";
	}>;
	async execute(request: HybridRetrievalRequest): Promise<HybridRetrievalResult>;
	async execute(
		input: HybridRetrievalRequest | QueryHybridInput
	): Promise<
		| HybridRetrievalResult
		| { readonly candidates: readonly QueryHybridCandidate[]; readonly retrieval: "hybrid" | "full-text-only" }
	> {
		const consumer = "query" in input;
		const request: HybridRetrievalRequest = consumer
			? {
					text: input.query,
					accessibleChannelIds: input.accessibleChannelIds,
					limit: input.limit,
					...(input.channelId ? { channelIds: [input.channelId] } : {}),
					...(input.authorId ? { authorId: input.authorId } : {}),
					...(input.from ? { from: new Date(input.from) } : {}),
					...(input.to ? { to: new Date(input.to) } : {}),
					...(input.after ? { cursor: { score: input.after.rank, messageId: input.after.messageId } } : {})
				}
			: input;
		const format = (candidates: readonly HybridCandidate[], vectorAvailable: boolean) =>
			consumer
				? {
						candidates: candidates.map((candidate) => ({
							messageId: candidate.messageId,
							channelId: candidate.channelId,
							parentChannelId: null,
							createdAt: candidate.createdInstant.toISOString(),
							rank: candidate.score
						})),
						retrieval: vectorAvailable ? ("hybrid" as const) : ("full-text-only" as const)
					}
				: { candidates, vectorAvailable };
		const snowflake = (value: string) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
		if (
			!Number.isInteger(request.limit) ||
			request.limit < 1 ||
			request.limit > 101 ||
			(request.cursor !== undefined &&
				(!Number.isFinite(request.cursor.score) || !snowflake(request.cursor.messageId))) ||
			(request.authorId !== undefined && !snowflake(request.authorId)) ||
			(request.channelIds !== undefined && !request.channelIds.every(snowflake)) ||
			(request.from !== undefined && !Number.isFinite(request.from.getTime())) ||
			(request.to !== undefined && !Number.isFinite(request.to.getTime())) ||
			request.text.trim() === "" ||
			Array.from(request.text).length > 2000 ||
			!Array.isArray(request.accessibleChannelIds)
		) {
			throw new Error("Invalid hybrid retrieval request");
		}
		if (request.accessibleChannelIds.length === 0) return format([], true);
		// Copy the ACL set once; a caller cannot mutate it while a provider request is in flight.
		const accessibleIds = [...request.accessibleChannelIds];
		const accessible = new Set(accessibleIds);
		// A fixed bounded candidate horizon makes RRF ranks independent of page size/cursor.
		const count = 64;
		const filters = {
			...(request.channelIds ? { channelIds: [...request.channelIds] } : {}),
			...(request.authorId ? { authorId: request.authorId } : {}),
			...(request.from ? { from: request.from } : {}),
			...(request.to ? { to: request.to } : {})
		};
		const fts = await this.fullText.search(request.text, accessibleIds, count, filters);
		let vectorCandidates: readonly VectorCandidate[] = [];
		let vectorAvailable = true;
		let embedding: readonly number[] | undefined;
		try {
			const embedded = await this.provider.embed([request.text]);
			embedding = embedded[0];
			if (embedded.length !== 1 || embedding === undefined) throw new Error("Missing query embedding");
		} catch {
			vectorAvailable = false;
		}
		if (embedding !== undefined)
			vectorCandidates = await this.vectors.nearest({
				model: this.provider.model,
				embedding,
				accessibleChannelIds: accessibleIds,
				limit: count,
				...filters
			});
		const fused = new Map<string, HybridCandidate>();
		for (const [branch, candidates] of [
			["fts", fts],
			["vector", vectorCandidates]
		] as const) {
			// SQL already filters before LIMIT/ranking; this guard also secures alternative repository adapters.
			const allowed = candidates.filter((candidate) => accessible.has(candidate.channelId));
			const seen = new Set<string>();
			let rank = 0;
			for (const candidate of allowed) {
				if (seen.has(candidate.messageId)) continue;
				seen.add(candidate.messageId);
				rank++;
				const previous = fused.get(candidate.messageId);
				fused.set(candidate.messageId, {
					...candidate,
					score: (previous?.score ?? 0) + 1 / (RRF_OFFSET + rank),
					branches: [...(previous?.branches ?? []), branch]
				});
			}
		}
		const candidates = [...fused.values()]
			.sort((left, right) => {
				const scoreOrder = right.score - left.score;
				if (scoreOrder !== 0) return scoreOrder;
				if (BigInt(left.messageId) < BigInt(right.messageId)) return -1;
				if (BigInt(left.messageId) > BigInt(right.messageId)) return 1;
				return 0;
			})
			.filter(
				(candidate) =>
					!request.cursor ||
					candidate.score < request.cursor.score ||
					(candidate.score === request.cursor.score &&
						BigInt(candidate.messageId) > BigInt(request.cursor.messageId))
			)
			.slice(0, request.limit);
		return format(candidates, vectorAvailable);
	}
}
