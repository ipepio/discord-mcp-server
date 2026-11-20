import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { CursorKey, ToolInput } from "../models/domain/tool-input.js";
import { QueryError } from "../models/domain/query.errors.js";
import type { HybridRetrieval } from "./hybrid-retrieval.contract.js";
import type { QueryAccess } from "./query-access.policy.js";

export class SearchCandidatesQuery {
	public constructor(
		private readonly retrieval: HybridRetrieval,
		private readonly logger: AppLogger
	) {}
	public async execute(input: ToolInput, access: QueryAccess, after?: CursorKey) {
		if (!input.query) throw new QueryError("invalid_input", "Invalid field: query");
		const accessibleChannelIds = access.accessibleChannelIds.filter(
			(id) => !input.channelId || id === input.channelId
		);
		try {
			const result = await this.retrieval.execute({
				query: input.query,
				guildId: access.guildId,
				accessibleChannelIds,
				...(input.channelId ? { channelId: input.channelId } : {}),
				...(input.authorId ? { authorId: input.authorId } : {}),
				...(input.from ? { from: input.from } : {}),
				...(input.to ? { to: input.to } : {}),
				...(after?.rank !== undefined && after.messageId
					? { after: { rank: after.rank, messageId: after.messageId } }
					: {}),
				limit: input.pageSize + 1
			});
			if (
				result.candidates.length > input.pageSize + 1 ||
				!["hybrid", "full-text-only"].includes(result.retrieval)
			)
				throw new Error("Invalid retrieval page");
			const allowed = new Set(accessibleChannelIds);
			const candidates = result.candidates.filter((candidate) => {
				if (allowed.has(candidate.channelId)) return true;
				this.logger.warn("query rejected out-of-scope retrieval candidate", {
					messageId: candidate.messageId,
					channelId: candidate.channelId
				});
				return false;
			});
			for (let i = 0; i < candidates.length; i++) {
				const candidate = candidates[i];
				const previous = candidates[i - 1];
				if (!candidate || !Number.isFinite(candidate.rank) || !/^[1-9][0-9]{0,18}$/.test(candidate.messageId))
					throw new Error("Invalid retrieval key");
				const prior =
					previous ??
					(after?.rank !== undefined && after.messageId
						? { rank: after.rank, messageId: after.messageId }
						: undefined);
				if (
					prior &&
					(candidate.rank > prior.rank ||
						(candidate.rank === prior.rank && BigInt(candidate.messageId) <= BigInt(prior.messageId)))
				)
					throw new Error("Unordered retrieval page");
			}
			return { candidates, retrieval: result.retrieval };
		} catch {
			throw new QueryError("internal_error", "Could not retrieve messages");
		}
	}
}
