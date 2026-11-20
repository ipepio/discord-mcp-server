/**
 * Validated technical configuration shapes (docs/architecture/shared.md).
 * Parsed once at startup from the environment; nothing else reads `process.env`.
 * Extending this contract with new variables (for example Discord settings) means adding fields
 * here plus the matching validators in `config.validators.ts` and parsing in `config.factory.ts`.
 */

import type { BrandConfig } from "./brand-config.js";

export interface AuthorizationRateLimitConfig {
	readonly registerPerHour: number;
	readonly authorizePerMinute: number;
	readonly tokenPerMinute: number;
	readonly mcpPerMinute: number;
}

export interface AuthorizationConfig {
	readonly discordClientId: string;
	readonly discordClientSecret: string;
	readonly publicBaseUrl: string;
	readonly sessionTtlSeconds: number;
	/**
	 * Always populated by `loadAuthorizationConfig`; the property is optional only so partial
	 * composition fixtures for unrelated features remain valid `AppConfig` literals. Code that
	 * enforces the limiter calls `authorizationRateLimits()` to obtain the shipped defaults when absent.
	 */
	readonly rateLimits?: AuthorizationRateLimitConfig;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * The environment actually seen at startup. Injected as data so validation stays testable and
 * no module depends on the global process object.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface DatabaseConfig {
	readonly url: string;
}

export interface HttpConfig {
	readonly port: number;
}

export interface LoggingConfig {
	readonly level: LogLevel;
}

export interface AppConfig {
	/** Deployment-controlled identity for the browser pages, MCP metadata and diagnostics. */
	readonly brand?: BrandConfig;
	readonly authorization: AuthorizationConfig;
	readonly database: DatabaseConfig;
	readonly http: HttpConfig;
	readonly logging: LoggingConfig;
}
