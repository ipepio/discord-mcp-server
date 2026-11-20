import type { EnvSource } from "./app-config.interface.js";
import { InvalidConfigurationError } from "./config.errors.js";

export interface QueryConfig {
	readonly maxMessageChars: number;
	readonly maxResponseBytes: number;
}
export const QUERY_CONFIG_DEFAULTS: QueryConfig = Object.freeze({ maxMessageChars: 4000, maxResponseBytes: 262144 });
/** Called at composition with the already captured startup environment. */
export function loadQueryConfig(env: EnvSource): QueryConfig {
	return Object.freeze({
		maxMessageChars: positiveInteger(env, "QUERY_MAX_MESSAGE_CHARS", QUERY_CONFIG_DEFAULTS.maxMessageChars, 1),
		maxResponseBytes: positiveInteger(env, "QUERY_MAX_RESPONSE_BYTES", QUERY_CONFIG_DEFAULTS.maxResponseBytes, 2048)
	});
}
function positiveInteger(env: EnvSource, name: string, fallback: number, minimum: number): number {
	const raw = env[name];
	if (raw === undefined) return fallback;
	if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < minimum)
		throw new InvalidConfigurationError(name, `must be a safe integer of at least ${minimum}`);
	return Number(raw);
}
