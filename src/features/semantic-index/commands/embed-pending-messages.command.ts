import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { EmbeddingProvider } from "../gateways/embedding-provider.interface.js";
import type { EmbeddingStoreRepository } from "../repositories/embedding-store.repository.js";
import { EMBEDDING_BATCH_LIMIT, EMBEDDING_DIMENSION } from "../repositories/embedding-store.repository.js";

/** Provider-sized chunks keep every text-bearing message eligible, including Unicode-heavy content. */
function chunks(text: string): readonly string[] {
	const points = Array.from(text);
	const result: string[] = [];
	for (let offset = 0; offset < points.length; offset += 2000) {
		const part = points.slice(offset, offset + 2000).join("");
		if (part.trim() !== "") result.push(part);
	}
	return result;
}

export interface EmbeddingBatchResult {
	readonly examined: number;
	readonly stored: number;
	readonly paused: boolean;
}

/** Stored state is the cursor: missing (message_id, model, revision) rows are retried in id order. */
export class EmbedPendingMessagesCommand {
	constructor(
		private readonly store: EmbeddingStoreRepository,
		private readonly provider: EmbeddingProvider,
		private readonly logger: AppLogger
	) {}

	async execute(): Promise<EmbeddingBatchResult> {
		const pending = await this.store.fetchNextUnembedded(this.provider.model, EMBEDDING_BATCH_LIMIT);
		if (pending.length === 0) return { examined: 0, stored: 0, paused: false };
		const perMessage = pending.map((message) => chunks(message.content));
		const input = perMessage.flat();
		const vectors: (readonly number[])[] = [];
		try {
			for (let offset = 0; offset < input.length; offset += EMBEDDING_BATCH_LIMIT) {
				const batch = input.slice(offset, offset + EMBEDDING_BATCH_LIMIT);
				const output = await this.provider.embed(batch);
				if (
					output.length !== batch.length ||
					output.some((vector) => vector.length !== EMBEDDING_DIMENSION || !vector.every(Number.isFinite))
				) {
					throw new Error("Invalid embedding provider output");
				}
				vectors.push(...output);
			}
		} catch {
			this.logger.warn("Embedding pipeline paused", { count: pending.length });
			return { examined: pending.length, stored: 0, paused: true };
		}
		let cursor = 0;
		const writes = pending.map((message, index) => {
			const parts = perMessage[index];
			if (parts === undefined || parts.length === 0) throw new Error("Pending message has no text");
			const selected = vectors.slice(cursor, cursor + parts.length);
			cursor += parts.length;
			const embedding = Array.from(
				{ length: EMBEDDING_DIMENSION },
				(_, coordinate) =>
					selected.reduce((sum, vector) => sum + (vector[coordinate] ?? 0), 0) / selected.length
			);
			return { messageId: message.messageId, contentRevision: message.contentRevision, embedding };
		});
		const stored = await this.store.upsertBatch(this.provider.model, writes);
		this.logger.info("Embedding batch committed", { examined: pending.length, stored });
		return { examined: pending.length, stored, paused: false };
	}
}
