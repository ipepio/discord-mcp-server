import { describe, expect, it } from "vitest";
import {
	AUTHORIZATION_RATE_LIMIT_DEFAULTS,
	authorizationRateLimits,
	loadAuthorizationConfig
} from "../../../src/shared/config/authorization-config.js";
import { InMemoryFixedWindowRateLimiter } from "../../../src/features/authorization/gateways/rate-limit.gateway.js";
import {
	RATE_LIMITED_ROUTES,
	rateLimitRules,
	resolveRateLimitRule
} from "../../../src/features/authorization/models/domain/rate-limit-policy.js";
import { clientAddress } from "../../../src/features/authorization/controllers/client-address.js";

const env = {
	DISCORD_CLIENT_ID: "fixture-id",
	DISCORD_CLIENT_SECRET: "fixture-secret",
	PUBLIC_BASE_URL: "https://hub.example",
	SESSION_TTL_SECONDS: "300"
};

describe("O3 rate-limit configuration", () => {
	it("ships the documented defaults when every variable is unset", () => {
		expect(AUTHORIZATION_RATE_LIMIT_DEFAULTS).toEqual({
			registerPerHour: 10,
			authorizePerMinute: 20,
			tokenPerMinute: 30,
			mcpPerMinute: 300
		});
		const config = loadAuthorizationConfig(env);
		expect(config.rateLimits).toEqual(AUTHORIZATION_RATE_LIMIT_DEFAULTS);
		expect(Object.isFrozen(config.rateLimits)).toBe(true);
		expect(authorizationRateLimits(config)).toEqual(AUTHORIZATION_RATE_LIMIT_DEFAULTS);
	});

	it("overrides each limit independently", () => {
		const config = loadAuthorizationConfig({
			...env,
			RATE_LIMIT_REGISTER_PER_HOUR: "25",
			RATE_LIMIT_AUTHORIZE_PER_MINUTE: "40",
			RATE_LIMIT_TOKEN_PER_MINUTE: "50",
			RATE_LIMIT_MCP_PER_MINUTE: "600"
		});
		expect(config.rateLimits).toEqual({
			registerPerHour: 25,
			authorizePerMinute: 40,
			tokenPerMinute: 50,
			mcpPerMinute: 600
		});
	});

	it.each([
		"RATE_LIMIT_REGISTER_PER_HOUR",
		"RATE_LIMIT_AUTHORIZE_PER_MINUTE",
		"RATE_LIMIT_TOKEN_PER_MINUTE",
		"RATE_LIMIT_MCP_PER_MINUTE"
	])("rejects invalid %s values naming the variable", (name) => {
		for (const value of ["0", "-1", "1.5", "1e2", "abc", "Infinity", "99999999999999999999"]) {
			expect(() => loadAuthorizationConfig({ ...env, [name]: value })).toThrow(name);
		}
	});

	it("falls back to the default for a blank variable", () => {
		expect(loadAuthorizationConfig({ ...env, RATE_LIMIT_TOKEN_PER_MINUTE: "   " }).rateLimits).toEqual(
			AUTHORIZATION_RATE_LIMIT_DEFAULTS
		);
	});
});

describe("O3 endpoint policy", () => {
	it("maps exactly the public endpoints to their shipped limits and windows", () => {
		expect(
			rateLimitRules(AUTHORIZATION_RATE_LIMIT_DEFAULTS).map(({ route, method, path, windowSeconds, limit }) => ({
				route,
				method,
				path,
				windowSeconds,
				limit
			}))
		).toEqual([
			{ route: "oauth_register", method: "POST", path: "/oauth/register", windowSeconds: 3600, limit: 10 },
			{ route: "oauth_authorize", method: "GET", path: "/oauth/authorize", windowSeconds: 60, limit: 20 },
			{
				route: "oauth_discord_callback",
				method: "GET",
				path: "/oauth/discord/callback",
				windowSeconds: 60,
				limit: 20
			},
			{ route: "oauth_token", method: "POST", path: "/oauth/token", windowSeconds: 60, limit: 30 },
			{ route: "mcp", method: "POST", path: "/mcp", windowSeconds: 60, limit: 300 }
		]);
		expect(RATE_LIMITED_ROUTES).toHaveLength(5);
	});

	it("resolves the configured limit for each method/path without leaking unrelated routes", () => {
		const settings = { registerPerHour: 3, authorizePerMinute: 4, tokenPerMinute: 5, mcpPerMinute: 6 };
		expect(resolveRateLimitRule(settings, "POST", "/oauth/register")).toMatchObject({
			route: "oauth_register",
			limit: 3
		});
		expect(resolveRateLimitRule(settings, "get", "/oauth/authorize")).toMatchObject({
			route: "oauth_authorize",
			limit: 4
		});
		expect(resolveRateLimitRule(settings, "GET", "/oauth/discord/callback")).toMatchObject({
			route: "oauth_discord_callback",
			limit: 4
		});
		expect(resolveRateLimitRule(settings, "POST", "/oauth/token")).toMatchObject({
			route: "oauth_token",
			limit: 5
		});
		expect(resolveRateLimitRule(settings, "POST", "/mcp")).toMatchObject({ route: "mcp", limit: 6 });
		// A trailing slash or different method cannot dodge the bound.
		expect(resolveRateLimitRule(settings, "POST", "/oauth/register/")).toMatchObject({ route: "oauth_register" });
		expect(resolveRateLimitRule(settings, "GET", "/oauth/register")).toBeUndefined();
		expect(resolveRateLimitRule(settings, "POST", "/health")).toBeUndefined();
		expect(resolveRateLimitRule(settings, "GET", "/mcp")).toBeUndefined();
	});
});

describe("in-memory fixed-window limiter", () => {
	const buckets = { test: { limit: 2, windowSeconds: 60 } };

	it("allows up to the limit, then blocks with the seconds until reset", () => {
		let now = 1_000_000;
		const limiter = new InMemoryFixedWindowRateLimiter({ buckets, now: () => now });
		expect(limiter.take("test|203.0.113.1")).toEqual({ allowed: true, retryAfterSeconds: 0 });
		expect(limiter.take("test|203.0.113.1")).toEqual({ allowed: true, retryAfterSeconds: 0 });
		expect(limiter.take("test|203.0.113.1")).toEqual({ allowed: false, retryAfterSeconds: 60 });
		now += 30_000;
		expect(limiter.take("test|203.0.113.1")).toEqual({ allowed: false, retryAfterSeconds: 30 });
		expect(limiter.take("test|203.0.113.2")).toEqual({ allowed: true, retryAfterSeconds: 0 });
	});

	it("starts a fresh window exactly at the reset boundary", () => {
		let now = 1_000_000;
		const limiter = new InMemoryFixedWindowRateLimiter({ buckets, now: () => now });
		limiter.take("test|a");
		limiter.take("test|a");
		expect(limiter.take("test|a").allowed).toBe(false);
		now += 60_000;
		expect(limiter.take("test|a")).toEqual({ allowed: true, retryAfterSeconds: 0 });
	});

	it("bounds memory by dropping the oldest key and never refuses an evicted key", () => {
		let now = 1_000_000;
		const limiter = new InMemoryFixedWindowRateLimiter({ buckets, maxEntries: 2, now: () => now });
		limiter.take("test|oldest");
		limiter.take("test|middle");
		expect(limiter.entryCount()).toBe(2);
		limiter.take("test|newest");
		expect(limiter.entryCount()).toBe(2);
		// `oldest` was evicted, so it opens a new window instead of inheriting the earlier count.
		expect(limiter.take("test|oldest")).toEqual({ allowed: true, retryAfterSeconds: 0 });
		expect(limiter.entryCount()).toBe(2);
		now += 1;
	});

	it("rejects unknown buckets and non-positive capacity instead of guessing", () => {
		const limiter = new InMemoryFixedWindowRateLimiter({ buckets });
		expect(() => limiter.take("unknown|203.0.113.1")).toThrow("Unknown rate limit bucket");
		expect(() => new InMemoryFixedWindowRateLimiter({ buckets, maxEntries: 0 })).toThrow(RangeError);
	});
});

describe("client address for the limiter key", () => {
	it("uses the rightmost X-Forwarded-For entry (one trusted proxy hop)", () => {
		expect(clientAddress({ headers: { "x-forwarded-for": "198.51.100.9, 203.0.113.7" } })).toBe("203.0.113.7");
		expect(clientAddress({ headers: { "x-forwarded-for": ["203.0.113.7"] } })).toBe("203.0.113.7");
	});

	it("falls back to the socket peer for a direct connection and normalizes IPv4-mapped IPv6", () => {
		expect(clientAddress({ headers: {}, socket: { remoteAddress: "::ffff:203.0.113.7" } })).toBe("203.0.113.7");
		expect(clientAddress({ headers: {}, socket: { remoteAddress: "::1" } })).toBe("::1");
		expect(clientAddress({ headers: {} })).toBe("unknown");
		expect(clientAddress({ headers: { "x-forwarded-for": " , " }, socket: { remoteAddress: "127.0.0.1" } })).toBe(
			"127.0.0.1"
		);
	});
});
