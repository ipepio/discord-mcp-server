export interface EmbeddingProvider {
	readonly model: string;
	readonly embed: (texts: readonly string[]) => Promise<readonly (readonly number[])[]>;
}

/** Safe to surface: never includes a request, credential, response body, or underlying fetch error. */
export class EmbeddingProviderUnavailableError extends Error {
	constructor() {
		super("Embedding provider is unavailable");
		this.name = "EmbeddingProviderUnavailableError";
	}
}
