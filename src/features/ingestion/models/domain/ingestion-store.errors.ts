/**
 * The message store's own error vocabulary (docs/architecture/conventions.md: expected failures become named
 * errors). Nothing here carries a driver error, a SQL fragment, a Discord payload or message text: a failure
 * names the operation, the column or the ids involved, which is everything R12 and R14 ask a log line to
 * prove and nothing more.
 *
 * These are technical refusals — a value that could never land in a column, a batch bound that is not a
 * number. What the spec calls a *business* outcome (a foreign-guild event, an edit that would regress newer
 * stored content, a delete for a message the store never saw) is a named case of a command's outcome union,
 * returned rather than thrown, exactly as guild-state returns `refused` and `dropped`.
 */

/** Base class for every ingestion store failure. */
export abstract class IngestionStoreError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/**
 * A value that must land in a `bigint` column is not one, or a number that must land in `size_bytes` is not
 * representable. The store refuses the value instead of discovering the rule inside a PostgreSQL cast, which
 * would name a column and hide the field that produced it (docs/features/guild-state.md R9, same rule here).
 */
export class InvalidMessageIdentifierError extends IngestionStoreError {
	public constructor(
		public readonly field: string,
		public readonly reason:
			"not-a-string" | "not-decimal" | "out-of-bigint-range" | "not-a-whole-number" | "out-of-safe-integer-range"
	) {
		super(`ingestion message store rejected ${field} as a Discord identifier (${reason})`);
	}
}

/**
 * A field value the store cannot hold as Discord reported it: blank text where a name is required, a
 * negative size, a non-integer instant. Refused rather than normalised, because inventing a stored value is
 * how a mirror starts reporting things Discord never said (R4, R11).
 */
export class InvalidMessageFieldValueError extends IngestionStoreError {
	public constructor(
		public readonly field: string,
		public readonly reason: string
	) {
		super(`ingestion message store rejected ${field} (${reason})`);
	}
}

/**
 * A repository was handed a batch or a bound it will not write: an empty id list where a sweep needs
 * targets, a batch size that is not a positive whole number. This is the difference between "nothing to do"
 * and "I refuse to guess what you meant" — an empty channel list handed to a bulk exclusion would otherwise
 * read as "exclude everything in this guild".
 */
export class InvalidMessageBatchError extends IngestionStoreError {
	public constructor(
		public readonly operation: string,
		public readonly reason: string
	) {
		super(`ingestion message store batch for ${operation} was refused (${reason})`);
	}
}
