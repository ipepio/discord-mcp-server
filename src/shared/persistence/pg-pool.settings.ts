/**
 * Bounded pool settings for the one managed PostgreSQL pool of this application instance
 * (docs/architecture/persistence.md: validate settings, use bounded timeouts, close on shutdown).
 */

export interface PgPoolSettings {
	readonly maxConnections: number;
	readonly connectionTimeoutMillis: number;
	readonly idleTimeoutMillis: number;
	readonly statementTimeoutMillis: number;
	readonly applicationName: string;
}

export class InvalidPoolSettingsError extends Error {
	public readonly code = "POOL_SETTINGS_INVALID";

	constructor(setting: string, reason: string) {
		super(`PostgreSQL pool setting ${setting} is invalid: ${reason}`);
		this.name = "InvalidPoolSettingsError";
	}
}

export const PG_POOL_SETTINGS: PgPoolSettings = {
	maxConnections: 10,
	connectionTimeoutMillis: 5_000,
	idleTimeoutMillis: 30_000,
	statementTimeoutMillis: 10_000,
	applicationName: "discord-mcp-server"
};

export type NumericPgPoolSetting =
	"maxConnections" | "connectionTimeoutMillis" | "idleTimeoutMillis" | "statementTimeoutMillis";

/** Positive integers only: an unbounded or zero timeout would let the pool hang or spin. */
export function validatePgPoolSettings(settings: PgPoolSettings): PgPoolSettings {
	const bounded: readonly [setting: NumericPgPoolSetting, limit: number][] = [
		["maxConnections", 100],
		["connectionTimeoutMillis", 600_000],
		["idleTimeoutMillis", 3_600_000],
		["statementTimeoutMillis", 600_000]
	];

	for (const [name, limit] of bounded) {
		const value = settings[name];
		if (!Number.isInteger(value) || value < 1 || value > limit) {
			throw new InvalidPoolSettingsError(name, `must be an integer between 1 and ${limit}`);
		}
	}

	if (settings.applicationName.trim() === "") {
		throw new InvalidPoolSettingsError("applicationName", "must not be empty");
	}

	return settings;
}
