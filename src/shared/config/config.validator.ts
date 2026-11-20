import { InvalidConfigurationError, MissingConfigurationError } from "./config.errors.js";
import type { LogLevel } from "./app-config.interface.js";

/** Environment variable names read at startup. Adding a variable means adding a name and a validator. */
export const ENV_VARIABLES = {
	databaseUrl: "DATABASE_URL",
	appPort: "APP_PORT",
	logLevel: "LOG_LEVEL"
} as const;

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function isLogLevel(candidate: string): candidate is LogLevel {
	return (LOG_LEVELS as readonly string[]).includes(candidate);
}

/** Required, non-empty value. */
export function requireText(env: Readonly<Record<string, string | undefined>>, name: string): string {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") {
		throw new MissingConfigurationError(name);
	}

	return raw.trim();
}

/** Optional integer inside an inclusive bound, with a documented default. */
export function optionalPort(
	env: Readonly<Record<string, string | undefined>>,
	name: string,
	fallback: number
): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") {
		return fallback;
	}

	if (!/^\d+$/.test(raw.trim())) {
		throw new InvalidConfigurationError(name, "must be a positive integer without separators");
	}

	const port = Number(raw.trim());
	if (port < 1 || port > 65_535) {
		throw new InvalidConfigurationError(name, "must be between 1 and 65535");
	}

	return port;
}

/** Case-insensitive log level restricted to the known set. */
export function optionalLogLevel(
	env: Readonly<Record<string, string | undefined>>,
	name: string,
	fallback: LogLevel
): LogLevel {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") {
		return fallback;
	}

	const candidate = raw.trim().toLowerCase();
	if (!isLogLevel(candidate)) {
		throw new InvalidConfigurationError(name, `must be one of ${LOG_LEVELS.join(", ")}`);
	}

	return candidate;
}
