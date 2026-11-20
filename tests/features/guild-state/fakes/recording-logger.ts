import type { AppLogger, LoggerFields } from "../../../../src/shared/logging/logger.interface.js";

/**
 * The logger contract's guild-state test double: every line with its fields, so a test can assert what a
 * bootstrap reported (part, ids, counts) and — for R14 — scan the whole transcript for anything it must never
 * carry: a token, a payload, a member's display data. Mirrors `tests/features/discord/fakes/recording-logger.ts`
 * deliberately, keeping this feature's tests independent of another feature's harness.
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

	public linesAt(level: RecordedLogLine["level"]): RecordedLogLine[] {
		return this.lines.filter((line) => line.level === level);
	}

	public messagesMatching(needle: string): RecordedLogLine[] {
		return this.lines.filter((line) => this.transcriptOf(line).includes(needle));
	}

	/** Everything the feature would emit, as one string, for the R14 scans. */
	public transcript(): string {
		return this.lines.map(transcriptOfLine).join("\n");
	}

	private transcriptOf(line: RecordedLogLine): string {
		return transcriptOfLine(line);
	}

	private record(level: RecordedLogLine["level"], message: string, fields?: LoggerFields): void {
		this.lines.push({ level, message, fields: { ...this.context, ...(fields ?? {}) } });
	}
}

function transcriptOfLine(line: RecordedLogLine): string {
	return `${line.level} ${line.message} ${JSON.stringify(line.fields)}`;
}
