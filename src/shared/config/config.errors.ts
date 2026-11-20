/**
 * Named startup configuration errors (docs/architecture/conventions.md: named errors for expected
 * failures; docs/architecture/shared.md: validate required configuration once at startup).
 * The messages name the variable but never echo its value, because values may contain credentials.
 */

export class MissingConfigurationError extends Error {
	public readonly code = "CONFIG_MISSING";

	constructor(public readonly variable: string) {
		super(`Required configuration variable ${variable} is missing or empty`);
		this.name = "MissingConfigurationError";
	}
}

export class InvalidConfigurationError extends Error {
	public readonly code = "CONFIG_INVALID";

	constructor(
		public readonly variable: string,
		reason: string
	) {
		super(`Configuration variable ${variable} is invalid: ${reason}`);
		this.name = "InvalidConfigurationError";
	}
}
