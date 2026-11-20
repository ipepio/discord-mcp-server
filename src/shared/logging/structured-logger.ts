import type { LogLevel } from "../config/app-config.interface.js";
import type { AppLogger, LoggerFields } from "./logger.interface.js";

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40
};

/** Field names whose values must never reach the log transport (docs/architecture/shared.md). */
const SECRET_FIELD_PATTERN =
	/(authorization|credential|password|secret|token|api[-_]?key|database[-_]?url|connection[-_]?string|dsn)/i;

export const REDACTED_FIELD_VALUE = "[redacted]";

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Transport seam: the logger never touches `console` and never decides where bytes go. */
export type LogWriter = (line: string, level: LogLevel) => void;

export const writeStdout: LogWriter = (line, level) => {
	const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
	stream.write(`${line}\n`);
};

interface LogRecord {
	timestamp: string;
	level: LogLevel;
	message: string;
	fields?: Record<string, JsonValue>;
}

function sanitizeValue(value: unknown): JsonValue {
	if (value instanceof Error) {
		return { name: value.name, message: value.message };
	}

	if (Array.isArray(value)) {
		return value.map(sanitizeValue);
	}

	if (typeof value === "bigint") {
		return value.toString();
	}

	if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		return value;
	}

	if (value === null) {
		return null;
	}

	if (typeof value === "object") {
		return sanitizeFields(value as Readonly<Record<string, unknown>>);
	}

	return null;
}

function sanitizeFields(fields: Readonly<Record<string, unknown>>): Record<string, JsonValue> {
	const sanitized: Record<string, JsonValue> = {};

	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) {
			continue;
		}

		sanitized[key] = SECRET_FIELD_PATTERN.test(key) ? REDACTED_FIELD_VALUE : sanitizeValue(value);
	}

	return sanitized;
}

/**
 * One-line JSON records: `{ timestamp, level, message, fields }`.
 * Deliberately framework-free — it imports no NestJS, `pg` or HTTP dependency.
 */
export class StructuredLogger implements AppLogger {
	public constructor(
		private readonly level: LogLevel,
		private readonly writer: LogWriter,
		private readonly context: Readonly<Record<string, unknown>> = {},
		private readonly clock: () => Date = () => new Date()
	) {}

	public debug(message: string, fields?: LoggerFields): void {
		this.write("debug", message, fields);
	}

	public info(message: string, fields?: LoggerFields): void {
		this.write("info", message, fields);
	}

	public warn(message: string, fields?: LoggerFields): void {
		this.write("warn", message, fields);
	}

	public error(message: string, fields?: LoggerFields): void {
		this.write("error", message, fields);
	}

	public withContext(fields: LoggerFields): AppLogger {
		return new StructuredLogger(this.level, this.writer, { ...this.context, ...fields }, this.clock);
	}

	private write(level: LogLevel, message: string, fields?: LoggerFields): void {
		const threshold = LEVEL_WEIGHT[this.level];
		const weight = LEVEL_WEIGHT[level];
		if (threshold === undefined || weight === undefined || weight < threshold) {
			return;
		}

		const merged = { ...this.context, ...(fields ?? {}) };
		const sanitized = sanitizeFields(merged);
		const record: LogRecord = {
			timestamp: this.clock().toISOString(),
			level,
			message
		};

		if (Object.keys(sanitized).length > 0) {
			record.fields = sanitized;
		}

		this.writer(JSON.stringify(record), level);
	}
}
