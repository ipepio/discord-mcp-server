import type { AppConfig, EnvSource } from "./app-config.interface.js";
import { loadBrandConfig } from "./brand-config.js";
import { loadAuthorizationConfig } from "./authorization-config.js";
import { ENV_VARIABLES, optionalLogLevel, optionalPort, requireText } from "./config.validator.js";

export const CONFIG_DEFAULTS = {
	appPort: 3000,
	logLevel: "info"
} as const;

/** The only place the process environment is read. Call it once, at composition time. */
export function readProcessEnv(): EnvSource {
	return process.env;
}

/**
 * Parses and validates the whole application configuration once, at startup.
 * Unknown variables are ignored on purpose; a future Discord section adds fields here without
 * changing how callers consume the returned frozen contract.
 */
export function loadAppConfig(env: EnvSource): AppConfig {
	const config: AppConfig = {
		authorization: loadAuthorizationConfig(env),
		brand: loadBrandConfig(env),
		database: {
			url: requireText(env, ENV_VARIABLES.databaseUrl)
		},
		http: {
			port: optionalPort(env, ENV_VARIABLES.appPort, CONFIG_DEFAULTS.appPort)
		},
		logging: {
			level: optionalLogLevel(env, ENV_VARIABLES.logLevel, CONFIG_DEFAULTS.logLevel)
		}
	};

	return Object.freeze({
		authorization: config.authorization,
		database: Object.freeze(config.database),
		http: Object.freeze(config.http),
		logging: Object.freeze(config.logging),
		...(config.brand ? { brand: config.brand } : {})
	});
}
