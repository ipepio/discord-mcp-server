import type { EnvSource } from "../../../shared/config/app-config.interface.js";
import { InvalidConfigurationError } from "../../../shared/config/config.errors.js";
import { requireText } from "../../../shared/config/config.validator.js";

export interface EmbeddingConfig {
	readonly provider: "openai";
	readonly model: string;
	readonly apiKey: string;
	readonly dimension: 1536;
	/** OpenAI-compatible embeddings endpoint root, without the `/embeddings` suffix. */
	readonly baseUrl: string;
}

const DEFAULT_EMBEDDING_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

/** A base URL that carries credentials, a query or a fragment is refused before any request. */
function loadEmbeddingBaseUrl(env: EnvSource): string {
	const raw = env["EMBEDDING_BASE_URL"];
	if (raw === undefined || raw.trim() === "") return DEFAULT_EMBEDDING_BASE_URL;
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new InvalidConfigurationError("EMBEDDING_BASE_URL", "must be an absolute http(s) URL");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new InvalidConfigurationError("EMBEDDING_BASE_URL", "must be an absolute http(s) URL");
	}
	if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
		throw new InvalidConfigurationError("EMBEDDING_BASE_URL", "must not carry credentials, a query or a fragment");
	}
	return url.toString().replace(/\/+$/, "");
}

export function loadEmbeddingConfig(env: EnvSource): EmbeddingConfig {
	const provider = requireText(env, "EMBEDDING_PROVIDER");
	const model = requireText(env, "EMBEDDING_MODEL");
	const dimension = requireText(env, "EMBEDDING_DIMENSION");
	const baseUrl = loadEmbeddingBaseUrl(env);
	if (provider !== "openai") throw new InvalidConfigurationError("EMBEDDING_PROVIDER", "must be openai");
	// A custom OpenAI-compatible endpoint serves its own model names; the managed default is pinned.
	if (baseUrl === DEFAULT_EMBEDDING_BASE_URL && model !== DEFAULT_EMBEDDING_MODEL) {
		throw new InvalidConfigurationError(
			"EMBEDDING_MODEL",
			"must be text-embedding-3-small unless EMBEDDING_BASE_URL names another OpenAI-compatible endpoint"
		);
	}
	if (!/^[A-Za-z0-9._:-]{1,120}$/.test(model)) {
		throw new InvalidConfigurationError("EMBEDDING_MODEL", "must be a plain model identifier");
	}
	if (!/^1536$/.test(dimension)) {
		throw new InvalidConfigurationError(
			"EMBEDDING_DIMENSION",
			"must match the vector(1536) migration before startup"
		);
	}
	return Object.freeze({
		provider,
		model,
		dimension: 1536,
		baseUrl,
		apiKey: requireText(env, "EMBEDDING_API_KEY")
	});
}
