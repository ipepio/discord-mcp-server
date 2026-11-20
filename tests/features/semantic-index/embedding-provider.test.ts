import { describe, expect, it, vi } from "vitest";
import { loadEmbeddingConfig } from "../../../src/features/semantic-index/config/embedding-config.validator.js";
import { loadFullTextLanguage } from "../../../src/features/semantic-index/config/full-text-language.validator.js";
import { OpenAiEmbeddingGateway } from "../../../src/features/semantic-index/gateways/openai-embedding.gateway.js";

const env = {
	EMBEDDING_PROVIDER: "openai",
	EMBEDDING_MODEL: "text-embedding-3-small",
	EMBEDDING_DIMENSION: "1536",
	EMBEDDING_API_KEY: "secret-test-key"
};
const config = loadEmbeddingConfig(env);
const vector = Array.from({ length: 1536 }, () => 1);
const body = { model: config.model, data: [{ index: 0, embedding: vector }] };

describe("embedding provider configuration", () => {
	it("defaults FTS to Spanish and validates configurable dictionaries", () => {
		expect(loadFullTextLanguage({})).toBe("spanish");
		for (const language of ["spanish", "english", "simple"] as const) {
			expect(loadFullTextLanguage({ FTS_LANGUAGE: language })).toBe(language);
		}
		expect(() => loadFullTextLanguage({ FTS_LANGUAGE: "untrusted; sql" })).toThrow();
	});
	it("validates every setting synchronously before constructing a network adapter", () => {
		expect(config.dimension).toBe(1536);
		for (const name of Object.keys(env)) expect(() => loadEmbeddingConfig({ ...env, [name]: "" })).toThrow();
		for (const dimension of ["12", "1536.0", "NaN"])
			expect(() => loadEmbeddingConfig({ ...env, EMBEDDING_DIMENSION: dimension })).toThrow();
		expect(() => loadEmbeddingConfig({ ...env, EMBEDDING_MODEL: "foreign" })).toThrow();
		expect(() => loadEmbeddingConfig({ ...env, EMBEDDING_PROVIDER: "foreign" })).toThrow();
	});
	it("accepts an OpenAI-compatible endpoint with its own model, refusing unsafe URLs", () => {
		const custom = loadEmbeddingConfig({
			...env,
			EMBEDDING_BASE_URL: "https://embeddings.example/v1",
			EMBEDDING_MODEL: "qwen3-embedding"
		});
		expect(custom.baseUrl).toBe("https://embeddings.example/v1");
		expect(custom.model).toBe("qwen3-embedding");
		// The managed default stays pinned to the documented model.
		expect(loadEmbeddingConfig(env).baseUrl).toBe("https://api.openai.com/v1");
		for (const bad of ["not-a-url", "ftp://example/v1", "https://user:pw@example/v1", "https://example/v1?k=1"])
			expect(() => loadEmbeddingConfig({ ...env, EMBEDDING_BASE_URL: bad })).toThrow();
		// The vector column still fixes the dimension, whatever the endpoint.
		expect(() =>
			loadEmbeddingConfig({ ...env, EMBEDDING_BASE_URL: "https://e.example/v1", EMBEDDING_DIMENSION: "4096" })
		).toThrow();
	});
});

describe("OpenAI embedding protocol (no external calls)", () => {
	it("pins the model/dimension, authenticates and sets an explicit timeout", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
		const gateway = new OpenAiEmbeddingGateway(config, request);
		expect(await gateway.embed(["private content"])).toEqual([vector]);
		const call = request.mock.calls[0];
		expect(call?.[0]).toBe("https://api.openai.com/v1/embeddings");
		expect(call?.[1]?.signal).toBeInstanceOf(AbortSignal);
		expect(JSON.parse(String(call?.[1]?.body))).toEqual({
			model: config.model,
			dimensions: 1536,
			input: ["private content"]
		});
	});
	it("retries transient failures with bounded backoff and sanitizes transport errors", async () => {
		const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("secret-test-key private content"));
		const delay = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue();
		await expect(new OpenAiEmbeddingGateway(config, request, delay).embed(["private content"])).rejects.toThrow(
			"Embedding provider is unavailable"
		);
		expect(request).toHaveBeenCalledTimes(3);
		expect(delay.mock.calls).toEqual([[250], [500]]);
	});
	it("does not retry authentication rejection", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("sensitive", { status: 401 }));
		await expect(new OpenAiEmbeddingGateway(config, request).embed(["private content"])).rejects.toThrow(
			"Embedding provider is unavailable"
		);
		expect(request).toHaveBeenCalledTimes(1);
	});
	it("validates foreign model, duplicate index, dimension, and finite nonzero coordinates", async () => {
		for (const invalid of [
			{ ...body, model: "foreign" },
			{ ...body, data: [] },
			{ ...body, data: [{ index: 1, embedding: vector }] },
			{ ...body, data: [{ index: 0, embedding: [1] }] },
			{ ...body, data: [{ index: 0, embedding: Array.from({ length: 1536 }, () => 0) }] }
		]) {
			const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(invalid)));
			await expect(new OpenAiEmbeddingGateway(config, request).embed(["private content"])).rejects.toThrow(
				"Embedding provider is unavailable"
			);
			expect(request).toHaveBeenCalledTimes(1);
		}
	});
	it("bounds batches and input before any request", async () => {
		const request = vi.fn<typeof fetch>();
		const gateway = new OpenAiEmbeddingGateway(config, request);
		for (const input of [[], [" "], ["x".repeat(8001)], Array.from({ length: 65 }, () => "x")])
			await expect(gateway.embed(input)).rejects.toThrow();
		expect(request).not.toHaveBeenCalled();
	});
});
