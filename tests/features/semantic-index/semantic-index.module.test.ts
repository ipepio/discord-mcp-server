import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { SemanticIndexModule, HYBRID_RETRIEVAL } from "../../../src/features/semantic-index/index.js";
import type { HybridRetrieval } from "../../../src/features/semantic-index/index.js";
import {
	EMBEDDING_PROVIDER,
	EMBEDDING_WORKER,
	EMBEDDING_BATCH_COMMAND
} from "../../../src/features/semantic-index/semantic-index.tokens.js";
import { EmbeddingPipelineWorker } from "../../../src/features/semantic-index/embedding-pipeline.worker.js";
import { EmbedPendingMessagesCommand } from "../../../src/features/semantic-index/commands/embed-pending-messages.command.js";
import { APP_CONFIG_TOKEN } from "../../../src/shared/config/config.tokens.js";
import { PG_POOL_TOKEN } from "../../../src/shared/persistence/persistence.tokens.js";

const env = {
	EMBEDDING_PROVIDER: "openai",
	EMBEDDING_MODEL: "text-embedding-3-small",
	EMBEDDING_DIMENSION: "1536",
	EMBEDDING_API_KEY: "test-only"
};

describe("semantic index composition", () => {
	it("fails invalid dimensions before building the module or constructing a provider", () => {
		expect(() => SemanticIndexModule.register({ ...env, EMBEDDING_DIMENSION: "10" })).toThrow("1536");
	});
	it("resolves real command/query/worker instances with explicit tokens and shuts down serial work", async () => {
		vi.useFakeTimers();
		const sql = { query: vi.fn().mockResolvedValue({ rows: [] }), end: vi.fn().mockResolvedValue(undefined) };
		const provider = { model: env.EMBEDDING_MODEL, embed: vi.fn() };
		const module = await Test.createTestingModule({ imports: [SemanticIndexModule.register(env)] })
			.overrideProvider(APP_CONFIG_TOKEN)
			.useValue({
				database: { url: "postgresql://unused:unused@127.0.0.1:1/unused" },
				logging: { level: "error" },
				http: { port: 3000 }
			})
			.overrideProvider(PG_POOL_TOKEN)
			.useValue(sql)
			.overrideProvider(EMBEDDING_PROVIDER)
			.useValue(provider)
			.compile();
		try {
			expect(module.get(EMBEDDING_WORKER)).toBeInstanceOf(EmbeddingPipelineWorker);
			expect(module.get(EMBEDDING_BATCH_COMMAND)).toBeInstanceOf(EmbedPendingMessagesCommand);
			await module.init();
			await vi.advanceTimersByTimeAsync(1);
			expect(sql.query).toHaveBeenCalledTimes(1);
			expect(provider.embed).not.toHaveBeenCalled();
			expect(
				(
					await module
						.get<HybridRetrieval>(HYBRID_RETRIEVAL)
						.execute({ text: "test", accessibleChannelIds: [], limit: 1 })
				).candidates
			).toEqual([]);
			await module.close();
			await vi.advanceTimersByTimeAsync(10000);
			expect(sql.query).toHaveBeenCalledTimes(1);
		} finally {
			await module.close();
			vi.useRealTimers();
		}
	});
});
