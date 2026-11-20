import type { EmbeddingConfig } from "../config/embedding-config.validator.js";
import type { EmbeddingProvider } from "./embedding-provider.interface.js";
import { EmbeddingProviderUnavailableError } from "./embedding-provider.interface.js";

const MAX_BATCH = 64;
// Conservative UTF-8 byte bound below the model's per-input token ceiling.
export const MAX_EMBEDDING_TEXT_BYTES = 8000;
const TIMEOUT_MS = 10_000;
const ATTEMPTS = 3;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseResponse(value: unknown, count: number, config: EmbeddingConfig): readonly (readonly number[])[] {
	if (
		!record(value) ||
		value["model"] !== config.model ||
		!Array.isArray(value["data"]) ||
		value["data"].length !== count
	) {
		throw new EmbeddingProviderUnavailableError();
	}
	const vectors = new Map<number, readonly number[]>();
	for (const item of value["data"]) {
		if (
			!record(item) ||
			typeof item["index"] !== "number" ||
			!Number.isInteger(item["index"]) ||
			item["index"] < 0 ||
			item["index"] >= count ||
			vectors.has(item["index"]) ||
			!Array.isArray(item["embedding"])
		) {
			throw new EmbeddingProviderUnavailableError();
		}
		const coordinates: number[] = [];
		for (const coordinate of item["embedding"]) {
			if (typeof coordinate !== "number" || !Number.isFinite(coordinate))
				throw new EmbeddingProviderUnavailableError();
			coordinates.push(coordinate);
		}
		if (coordinates.length !== config.dimension || !coordinates.some((coordinate) => coordinate !== 0))
			throw new EmbeddingProviderUnavailableError();
		vectors.set(item["index"], coordinates);
	}
	return Array.from({ length: count }, (_, index) => {
		const vector = vectors.get(index);
		if (vector === undefined) throw new EmbeddingProviderUnavailableError();
		return vector;
	});
}

export class OpenAiEmbeddingGateway implements EmbeddingProvider {
	readonly model: string;
	constructor(
		private readonly config: EmbeddingConfig,
		private readonly request: typeof fetch = fetch,
		private readonly delay: (milliseconds: number) => Promise<void> = (milliseconds) =>
			new Promise((resolve) => setTimeout(resolve, milliseconds))
	) {
		this.model = config.model;
	}

	async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
		if (
			texts.length < 1 ||
			texts.length > MAX_BATCH ||
			texts.some((text) => text.trim() === "" || Buffer.byteLength(text, "utf8") > MAX_EMBEDDING_TEXT_BYTES)
		) {
			throw new Error("Embedding request exceeds technical input bounds");
		}
		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			let retry = false;
			try {
				const response = await this.request(`${this.config.baseUrl}/embeddings`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.apiKey}` },
					body: JSON.stringify({ model: this.model, dimensions: this.config.dimension, input: texts }),
					signal: AbortSignal.timeout(TIMEOUT_MS)
				});
				if (response.ok) return parseResponse(await response.json(), texts.length, this.config);
				retry = response.status === 429 || response.status >= 500;
				await response.body?.cancel();
			} catch (failure) {
				if (failure instanceof EmbeddingProviderUnavailableError) throw failure;
				// Network/timeout errors can contain sensitive transport details: never propagate them.
				retry = true;
			}
			if (!retry || attempt === ATTEMPTS - 1) throw new EmbeddingProviderUnavailableError();
			await this.delay(250 * 2 ** attempt);
		}
		throw new EmbeddingProviderUnavailableError();
	}
}
