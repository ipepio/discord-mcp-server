/**
 * The named configuration failures of the ingestion feature (docs/architecture/conventions.md: expected
 * failures become named errors; docs/features/ingestion.md Prerequisites: "Invalid or missing configuration
 * fails startup with an explicit error before any network activity").
 *
 * These are deployment conditions rather than store conditions, so they are separate from
 * `../models/domain/ingestion-store.errors.js`: a broken `IMPORT_MODE` never reached a message row, and an
 * error that named the message store would send a reader to the wrong file. Nothing here carries a value a
 * log must not hold — an env variable name, a declared value's shape and a reason are all the facts.
 */

/** Base class for every ingestion configuration refusal. */
export abstract class IngestionConfigurationError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/**
 * A declared import window that is not one R3 admits: an unknown mode, a `days` window without a whole number
 * of days, a zero or negative or fractional bound, or a bound whose cutoff instant no `timestamptz` could
 * hold. The field names what was declared and why it was refused, because a silent fallback to "full" would
 * import history an operator asked not to keep.
 */
export class InvalidImportWindowError extends IngestionConfigurationError {
	public constructor(
		public readonly field: string,
		public readonly reason: string
	) {
		super(`ingestion import configuration refused ${field} (${reason})`);
	}
}

/**
 * A declared catch-up bound that R14 does not admit: a switch that is neither `true` nor `false`, or an
 * interval, channel count or page count that is not a whole positive number. The field is the setting's own
 * name (environment variables are reported against the variable the operator wrote), because a job that runs
 * on its own must be bounded by a value a reader can go and correct.
 */
export class InvalidCatchUpConfigurationError extends IngestionConfigurationError {
	public constructor(
		public readonly field: string,
		public readonly reason: string
	) {
		super(`ingestion catch-up configuration refused ${field} (${reason})`);
	}
}

/**
 * A declared resync page bound that R9 does not admit: anything but a whole positive number. The field is the
 * setting's own name (the environment variable when the value came from the environment), because the bound is
 * the only thing that keeps a reconnect from re-reading a channel's whole mirror.
 */
export class InvalidResyncConfigurationError extends IngestionConfigurationError {
	public constructor(
		public readonly field: string,
		public readonly reason: string
	) {
		super(`ingestion resync configuration refused ${field} (${reason})`);
	}
}
