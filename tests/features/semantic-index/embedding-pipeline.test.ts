import { describe, expect, it, vi } from "vitest";
import { EmbedPendingMessagesCommand } from "../../../src/features/semantic-index/commands/embed-pending-messages.command.js";
import type { EmbeddingStoreRepository } from "../../../src/features/semantic-index/repositories/embedding-store.repository.js";
import type { AppLogger } from "../../../src/shared/logging/logger.interface.js";

function fixture(content = "private content") {
	const store: EmbeddingStoreRepository = {
		fetchNextUnembedded: vi.fn().mockResolvedValue([{ messageId: "100", contentRevision: "revision", content }]),
		upsertBatch: vi.fn().mockResolvedValue(1),
		deleteByMessageIds: vi.fn(),
		nearest: vi.fn()
	};
	const provider = {
		model: "test-model",
		embed: vi
			.fn()
			.mockImplementation(async (texts: readonly string[]) =>
				texts.map(() => Array.from({ length: 1536 }, () => 1))
			)
	};
	const logger: AppLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: vi.fn() };
	return { store, provider, logger, command: new EmbedPendingMessagesCommand(store, provider, logger) };
}

describe("decoupled embedding pipeline", () => {
	it("reads stored messages, embeds and commits a bounded batch without logging content", async () => {
		const { command, store, provider, logger } = fixture();
		expect(await command.execute()).toEqual({ examined: 1, stored: 1, paused: false });
		expect(store.fetchNextUnembedded).toHaveBeenCalledWith("test-model", 64);
		expect(provider.embed).toHaveBeenCalledWith(["private content"]);
		expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain("private content");
	});
	it("outage retains the cursor and resumes idempotently on the next iteration", async () => {
		const { command, store, provider, logger } = fixture();
		provider.embed.mockRejectedValueOnce(new Error("private content secret-key"));
		expect((await command.execute()).paused).toBe(true);
		expect(store.upsertBatch).not.toHaveBeenCalled();
		expect((await command.execute()).stored).toBe(1);
		expect(store.fetchNextUnembedded).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("private");
	});
	it("handles Unicode-heavy long text without making it permanently ineligible", async () => {
		const { command, provider } = fixture("😀".repeat(4000));
		expect((await command.execute()).stored).toBe(1);
		expect(provider.embed.mock.calls[0]?.[0]).toHaveLength(2);
	});
	it("idle batches do not call the provider", async () => {
		const { command, store, provider } = fixture();
		vi.mocked(store.fetchNextUnembedded).mockResolvedValue([]);
		expect((await command.execute()).examined).toBe(0);
		expect(provider.embed).not.toHaveBeenCalled();
	});
});
