/**
 * O3 fixed-window policy for the public surfaces that must not be floodable. The limits are startup
 * configuration; the windows are part of the decision and never read from the environment.
 * `/mcp` is the product surface, so its bound only catches floods.
 */

/** The four validated configuration values, structurally compatible with `AuthorizationConfig.rateLimits`. */
export interface RateLimitSettings {
	readonly registerPerHour: number;
	readonly authorizePerMinute: number;
	readonly tokenPerMinute: number;
	readonly mcpPerMinute: number;
}

export type RateLimitRoute = "oauth_register" | "oauth_authorize" | "oauth_discord_callback" | "oauth_token" | "mcp";

export interface RateLimitedRoute {
	readonly route: RateLimitRoute;
	readonly method: "GET" | "POST";
	readonly path: string;
	readonly windowSeconds: number;
	readonly limitKey: keyof RateLimitSettings;
}

export interface RateLimitRule extends RateLimitedRoute {
	readonly limit: number;
}

const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;

/** Exactly the public endpoints the brief bounds, independent of the configured values. */
export const RATE_LIMITED_ROUTES: readonly RateLimitedRoute[] = Object.freeze([
	{
		route: "oauth_register",
		method: "POST",
		path: "/oauth/register",
		windowSeconds: HOUR_SECONDS,
		limitKey: "registerPerHour"
	},
	{
		route: "oauth_authorize",
		method: "GET",
		path: "/oauth/authorize",
		windowSeconds: MINUTE_SECONDS,
		limitKey: "authorizePerMinute"
	},
	{
		route: "oauth_discord_callback",
		method: "GET",
		path: "/oauth/discord/callback",
		windowSeconds: MINUTE_SECONDS,
		limitKey: "authorizePerMinute"
	},
	{
		route: "oauth_token",
		method: "POST",
		path: "/oauth/token",
		windowSeconds: MINUTE_SECONDS,
		limitKey: "tokenPerMinute"
	},
	{
		route: "mcp",
		method: "POST",
		path: "/mcp",
		windowSeconds: MINUTE_SECONDS,
		limitKey: "mcpPerMinute"
	}
]);

export function rateLimitRules(settings: RateLimitSettings): readonly RateLimitRule[] {
	return RATE_LIMITED_ROUTES.map((route) => Object.freeze({ ...route, limit: settings[route.limitKey] }));
}

/** Exact method/path match; a trailing slash and case cannot dodge the bound. */
export function resolveRateLimitRule(
	settings: RateLimitSettings,
	method: string,
	path: string
): RateLimitRule | undefined {
	const normalizedPath = (path.length > 1 ? path.replace(/\/+$/, "") : path).toLowerCase();
	return rateLimitRules(settings).find(
		(rule) => rule.method === method.toUpperCase() && rule.path === normalizedPath
	);
}
