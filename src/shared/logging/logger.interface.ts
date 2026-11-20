/**
 * Narrow logger contract (docs/architecture/shared.md: structured logging through a common contract,
 * no `console.log`). Use cases and adapters depend on this interface through `APP_LOGGER_TOKEN`,
 * never on a concrete transport.
 */

export type LoggerFields = Readonly<Record<string, unknown>>;

export interface AppLogger {
	readonly debug: (message: string, fields?: LoggerFields) => void;
	readonly info: (message: string, fields?: LoggerFields) => void;
	readonly warn: (message: string, fields?: LoggerFields) => void;
	readonly error: (message: string, fields?: LoggerFields) => void;
	/** Returns a logger that adds the given fields to every record (correlation context, feature name). */
	readonly withContext: (fields: LoggerFields) => AppLogger;
}
