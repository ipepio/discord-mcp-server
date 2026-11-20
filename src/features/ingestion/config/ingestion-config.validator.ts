import type { EnvSource } from "../../../shared/config/app-config.interface.js";
import { InvalidConfigurationError, MissingConfigurationError } from "../../../shared/config/config.errors.js";
import { requireText } from "../../../shared/config/config.validator.js";
import type { ImportMode, ImportWindow } from "../models/domain/import-window.js";
import { IMPORT_MODES } from "../models/domain/import-window.js";
import { InvalidCatchUpConfigurationError, InvalidImportWindowError } from "./ingestion-config.errors.js";
import type { IngestionConfigurationError } from "./ingestion-config.errors.js";
import { InvalidResyncConfigurationError } from "./ingestion-config.errors.js";
import type { ImportWindowInput, IngestionCatchUpConfig, IngestionResyncConfig } from "./ingestion-config.interface.js";
import {
	DEFAULT_INGESTION_CATCH_UP,
	DEFAULT_INGESTION_RESYNC,
	resolveImportWindow
} from "./ingestion-config.interface.js";

/**
 * The R3 import window, read once from the environment at startup (docs/features/ingestion.md
 * Prerequisites: validated configuration "per the shared/config conventions (no scattered `process.env`
 * reads)", and "invalid or missing configuration fails startup with an explicit error before any network
 * activity").
 *
 * Like DiscordModule, IngestionModule accepts the startup EnvSource as data and validates its feature
 * section before constructing providers. It reuses shared configuration errors/validation and never reads
 * process.env itself; the application composition owns reading the environment once.
 *
 * What the two variables mean together is R3's whole sentence: `IMPORT_MODE=full` asks for all retrievable
 * history and then `IMPORT_DAYS` is not read at all; `IMPORT_MODE=days` asks for what is strictly after
 * `(import start − IMPORT_DAYS days)` and then the number is required. Absent `IMPORT_MODE` is therefore a
 * missing configuration, not a default: the spec lists it among the variables whose absence fails startup, and
 * guessing "full" on an operator's behalf would let a half-configured deployment import a whole Guild's
 * history nobody declared.
 */
export const INGESTION_ENV_VARIABLES = {
	importMode: "IMPORT_MODE",
	importDays: "IMPORT_DAYS",
	/** R14's catch-up: one switch and three bounds, each defaulting when absent. */
	catchUpEnabled: "INGESTION_CATCH_UP_ENABLED",
	catchUpIntervalMs: "INGESTION_CATCH_UP_INTERVAL_MS",
	catchUpChannelsPerTick: "INGESTION_CATCH_UP_CHANNELS_PER_TICK",
	catchUpPagesPerChannelPerTick: "INGESTION_CATCH_UP_PAGES_PER_CHANNEL_PER_TICK",
	/** R9's resync: one page bound per channel per reconnect, defaulting when absent. */
	resyncMaxPagesPerChannel: "INGESTION_RESYNC_MAX_PAGES_PER_CHANNEL"
} as const;

/** The window as the environment declared it, validated. Throws before any client or repository is built. */
export function loadIngestionImportWindow(env: EnvSource): ImportWindow {
	const declaredMode = requireText(env, INGESTION_ENV_VARIABLES.importMode);
	if (!(IMPORT_MODES as readonly string[]).includes(declaredMode)) {
		throw new InvalidConfigurationError(
			INGESTION_ENV_VARIABLES.importMode,
			`must be one of ${IMPORT_MODES.join(", ")}`
		);
	}

	const mode = declaredMode as ImportMode;
	const declared: ImportWindowInput = mode === "full" ? { mode } : { mode, days: requireDeclaredDays(env) };

	try {
		return resolveImportWindow(declared);
	} catch (failure) {
		// The window's own rules live in one place (`resolveImportWindow`); at this boundary they are reported as
		// the startup failure Prerequisites name, against the variable the operator actually wrote.
		if (failure instanceof InvalidImportWindowError) {
			throw new InvalidConfigurationError(INGESTION_ENV_VARIABLES.importDays, failure.reason);
		}

		throw failure;
	}
}

/** `IMPORT_DAYS`: one whole number of days, at least one. Read only when the mode asked for a window. */
function requireDeclaredDays(env: EnvSource): number {
	const declared = env[INGESTION_ENV_VARIABLES.importDays];
	if (declared === undefined || declared.trim() === "") {
		throw new MissingConfigurationError(INGESTION_ENV_VARIABLES.importDays);
	}

	const candidate = declared.trim();
	if (!/^\d+$/.test(candidate)) {
		throw new InvalidConfigurationError(INGESTION_ENV_VARIABLES.importDays, "must be a positive integer of days");
	}

	return Number(candidate);
}

/**
 * R14's catch-up bounds, read once from the environment (docs/features/ingestion.md Prerequisites: validated
 * configuration, no scattered `process.env` reads).
 *
 * Absent and blank are the same fact here — "this deployment declared nothing" — and each variable falls back
 * to its own default, so tightening one bound never erases another. A value that is present and wrong is
 * refused against the variable the operator wrote: a job that retries history on its own must not be started
 * by a guess.
 */
export function loadIngestionCatchUpConfig(env: EnvSource): IngestionCatchUpConfig {
	return {
		catchUpEnabled: requireDeclaredFlag(env),
		catchUpIntervalMs: requireDeclaredBound(
			INGESTION_ENV_VARIABLES.catchUpIntervalMs,
			DEFAULT_INGESTION_CATCH_UP.catchUpIntervalMs,
			env
		),
		catchUpChannelsPerTick: requireDeclaredBound(
			INGESTION_ENV_VARIABLES.catchUpChannelsPerTick,
			DEFAULT_INGESTION_CATCH_UP.catchUpChannelsPerTick,
			env
		),
		catchUpPagesPerChannelPerTick: requireDeclaredBound(
			INGESTION_ENV_VARIABLES.catchUpPagesPerChannelPerTick,
			DEFAULT_INGESTION_CATCH_UP.catchUpPagesPerChannelPerTick,
			env
		)
	};
}

/** `INGESTION_CATCH_UP_ENABLED`: exactly `true` or `false`. Anything else is a guess, and a guess runs a job. */ function requireDeclaredFlag(
	env: EnvSource
): boolean {
	const declared = env[INGESTION_ENV_VARIABLES.catchUpEnabled];
	if (declared === undefined || declared.trim() === "") {
		return DEFAULT_INGESTION_CATCH_UP.catchUpEnabled;
	}

	const candidate = declared.trim();
	if (candidate === "true") return true;
	if (candidate === "false") return false;

	throw new InvalidCatchUpConfigurationError(INGESTION_ENV_VARIABLES.catchUpEnabled, "must be true or false");
}

/** One of R14's numeric bounds: a whole positive number, or the default when the variable is absent. */
function requireDeclaredBound(
	name: string,
	fallback: number,
	env: EnvSource,
	refuse: new (field: string, reason: string) => IngestionConfigurationError = InvalidCatchUpConfigurationError
): number {
	const declared = env[name];
	if (declared === undefined || declared.trim() === "") {
		return fallback;
	}

	const candidate = declared.trim();
	if (!/^\d+$/.test(candidate)) {
		throw new refuse(name, "must be a positive whole number");
	}

	const value = Number(candidate);
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new refuse(name, "must be a positive whole number");
	}

	return value;
}

/**
 * R9's resync page bound, read once from the environment like the catch-up's.
 *
 * Absent and blank stay the documented default; a value that is present and wrong is refused against the
 * variable the operator wrote. The bound is what keeps a restart from re-reading every channel's whole mirror,
 * so a guess in either direction is not a value this loader keeps.
 */
export function loadIngestionResyncConfig(env: EnvSource): IngestionResyncConfig {
	return {
		resyncMaxPagesPerChannel: requireDeclaredBound(
			INGESTION_ENV_VARIABLES.resyncMaxPagesPerChannel,
			DEFAULT_INGESTION_RESYNC.resyncMaxPagesPerChannel,
			env,
			InvalidResyncConfigurationError
		)
	};
}
