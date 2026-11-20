import type { LoggerService } from "@nestjs/common";
import { Inject, Injectable } from "@nestjs/common";
import { APP_LOGGER_TOKEN } from "./logging.tokens.js";
import type { AppLogger, LoggerFields } from "./logger.interface.js";
import type { LogLevel } from "../config/app-config.interface.js";

type NestLogLevel = "debug" | "error" | "fatal" | "log" | "verbose" | "warn";

function toAppLogLevel(level: NestLogLevel): LogLevel {
	switch (level) {
		case "debug":
			return "debug";
		case "error":
		case "fatal":
			return "error";
		case "warn":
			return "warn";
		case "log":
		case "verbose":
			return "info";
	}
}

function toText(message: unknown): string {
	if (typeof message === "string") {
		return message;
	}

	if (message instanceof Error) {
		return `${message.name}: ${message.message}`;
	}

	return "framework message";
}

function toFields(message: unknown, optionalParams: readonly unknown[]): LoggerFields {
	const context = optionalParams.find((param): param is string => typeof param === "string");
	const rest = optionalParams.filter((param) => typeof param !== "string");
	const fields: Record<string, unknown> = {};

	if (typeof message !== "string") {
		fields["detail"] = message;
	}

	if (context !== undefined) {
		fields["context"] = context;
	}

	if (rest.length > 0) {
		fields["details"] = rest;
	}

	return fields;
}

/**
 * Bridges NestJS framework logging into the application's structured logger contract so the process
 * has exactly one log format (docs/architecture/shared.md: avoid competing Nest/custom logger types).
 */
@Injectable()
export class NestLoggerAdapter implements LoggerService {
	public constructor(@Inject(APP_LOGGER_TOKEN) private readonly logger: AppLogger) {}

	public log(message: unknown, ...optionalParams: unknown[]): void {
		this.emit("log", message, optionalParams);
	}

	public error(message: unknown, ...optionalParams: unknown[]): void {
		this.emit("error", message, optionalParams);
	}

	public warn(message: unknown, ...optionalParams: unknown[]): void {
		this.emit("warn", message, optionalParams);
	}

	public debug(message: unknown, ...optionalParams: unknown[]): void {
		this.emit("debug", message, optionalParams);
	}

	public verbose(message: unknown, ...optionalParams: unknown[]): void {
		this.emit("verbose", message, optionalParams);
	}

	private emit(level: NestLogLevel, message: unknown, optionalParams: readonly unknown[]): void {
		this.logger[toAppLogLevel(level)](toText(message), toFields(message, optionalParams));
	}
}
