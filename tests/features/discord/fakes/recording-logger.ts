import type { AppLogger, LoggerFields } from "../../../../src/shared/logging/logger.interface.js";

/**
 * The logger contract's test double: records every line with its fields so tests can assert what was
 * reported (ids, kinds, counts) and, later, that no line carries content or a credential (R11).
 */
export interface RecordedLogLine {
	readonly level: "debug" | "info" | "warn" | "error";
	readonly message: string;
	readonly fields: LoggerFields;
}

export class RecordingLogger implements AppLogger {
	public readonly lines: RecordedLogLine[] = [];

	public constructor(private readonly context: LoggerFields = {}) {}

	public debug(message: string, fields?: LoggerFields): void {
		this.record("debug", message, fields);
	}

	public info(message: string, fields?: LoggerFields): void {
		this.record("info", message, fields);
	}

	public warn(message: string, fields?: LoggerFields): void {
		this.record("warn", message, fields);
	}

	public error(message: string, fields?: LoggerFields): void {
		this.record("error", message, fields);
	}

	public withContext(fields: LoggerFields): AppLogger {
		return new RecordingLogger({ ...this.context, ...fields });
	}

	public messagesMatching(needle: string): RecordedLogLine[] {
		return this.lines.filter(
			(line) => line.message.includes(needle) || JSON.stringify(line.fields).includes(needle)
		);
	}

	/** Everything the logger would emit, as one string, for the fixture scans. */
	public transcript(): string {
		return this.lines.map((line) => `${line.message} ${JSON.stringify(line.fields)}`).join("\n");
	}

	public clear(): void {
		this.lines.length = 0;
	}

	private record(level: RecordedLogLine["level"], message: string, fields?: LoggerFields): void {
		this.lines.push({ level, message, fields: { ...this.context, ...(fields ?? {}) } });
	}
}
