import type { AuthorizationConfig, AuthorizationRateLimitConfig, EnvSource } from "./app-config.interface.js";

/** O3 shipped defaults; the environment overrides each one independently and only when set. */
export const AUTHORIZATION_RATE_LIMIT_DEFAULTS = Object.freeze({
	registerPerHour: 10,
	authorizePerMinute: 20,
	tokenPerMinute: 30,
	mcpPerMinute: 300
});

/** Validated limits, falling back to the shipped defaults for partial composition fixtures. */
export function authorizationRateLimits(config: AuthorizationConfig): AuthorizationRateLimitConfig {
	return config.rateLimits ?? AUTHORIZATION_RATE_LIMIT_DEFAULTS;
}

/** Required settings, no implicit issuer or session lifetime; evaluated before listeners/network activity. */
export function loadAuthorizationConfig(env: EnvSource): AuthorizationConfig {
	const required = (name: string): string => {
		const value = env[name];
		if (!value || !value.trim()) throw new Error(`Invalid or missing configuration: ${name}`);
		return value;
	};
	/** Optional integer >= 1 with a documented default; the value is never echoed in the error. */
	const positiveInteger = (name: string, fallback: number): number => {
		const raw = env[name];
		if (raw === undefined || raw.trim() === "") return fallback;
		const value = raw.trim();
		if (!/^[0-9]+$/.test(value)) throw new Error(`Invalid configuration: ${name}`);
		const parsed = Number(value);
		if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid configuration: ${name}`);
		return parsed;
	};
	const discordClientId = required("DISCORD_CLIENT_ID");
	const discordClientSecret = required("DISCORD_CLIENT_SECRET");
	const base = required("PUBLIC_BASE_URL");
	let url: URL;
	try {
		url = new URL(base);
	} catch {
		throw new Error("Invalid configuration: PUBLIC_BASE_URL");
	}
	const localDevelopment = env["AUTHORIZATION_LOCAL_DEVELOPMENT"];
	if (localDevelopment !== undefined && localDevelopment !== "true" && localDevelopment !== "false")
		throw new Error("Invalid configuration: AUTHORIZATION_LOCAL_DEVELOPMENT");
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.pathname !== "/" && url.pathname !== "") ||
		(url.protocol !== "https:" &&
			!(
				localDevelopment === "true" &&
				url.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
			))
	)
		throw new Error("Invalid configuration: PUBLIC_BASE_URL");
	const ttl = required("SESSION_TTL_SECONDS");
	const sessionTtlSeconds = Number(ttl);
	if (
		!/^[0-9]+$/.test(ttl) ||
		!Number.isInteger(sessionTtlSeconds) ||
		sessionTtlSeconds < 300 ||
		sessionTtlSeconds > 86400
	)
		throw new Error("Invalid configuration: SESSION_TTL_SECONDS");
	const rateLimits = Object.freeze({
		registerPerHour: positiveInteger(
			"RATE_LIMIT_REGISTER_PER_HOUR",
			AUTHORIZATION_RATE_LIMIT_DEFAULTS.registerPerHour
		),
		authorizePerMinute: positiveInteger(
			"RATE_LIMIT_AUTHORIZE_PER_MINUTE",
			AUTHORIZATION_RATE_LIMIT_DEFAULTS.authorizePerMinute
		),
		tokenPerMinute: positiveInteger(
			"RATE_LIMIT_TOKEN_PER_MINUTE",
			AUTHORIZATION_RATE_LIMIT_DEFAULTS.tokenPerMinute
		),
		mcpPerMinute: positiveInteger("RATE_LIMIT_MCP_PER_MINUTE", AUTHORIZATION_RATE_LIMIT_DEFAULTS.mcpPerMinute)
	});
	return Object.freeze({
		discordClientId,
		discordClientSecret,
		publicBaseUrl: url.origin,
		sessionTtlSeconds,
		rateLimits
	});
}
