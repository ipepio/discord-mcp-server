import type { DiscordRestOperation } from "../models/domain/discord-rest-operation.enum.js";

/**
 * Named technical failures of the Discord REST boundary (spec R7). A consumer distinguishes "no data"
 * from "could not read" by catching this error and reading its `reason` — the adapter never returns a
 * partially populated result, never a fabricated default and never a silently shortened page.
 *
 * What the error carries is an operation name, a bounded retry count, an HTTP status, a field path and a
 * short technical detail. Never a payload, never message content, never a credential (R11).
 */
export type DiscordRestFailureReason =
	/** A 4xx other than 429: surfaced as it is, never retried (R7). */
	| "client-error"
	/** 401 or 403: the read is not permitted, and nothing else happens (R8 error). */
	| "unauthorized"
	/** 404: the resource is not there. A consumer reads this as absence, never as an empty result (R3). */
	| "not-found"
	/** 5xx: transient, retried until the bounded attempt count ran out. */
	| "server-error"
	/** 429 whose wait no longer fits the budget, or that outlasted the attempt bound. */
	| "rate-limit"
	/** The request timed out on every attempt the bound allowed. */
	| "timeout"
	/** The request never reached Discord. */
	| "transport"
	/** Discord's payload failed validation: `fieldPath` names the offending path (R7 error). */
	| "validation";

export interface DiscordRestFailureDetails {
	readonly operation: DiscordRestOperation;
	readonly reason: DiscordRestFailureReason;
	readonly attempts: number;
	readonly detail: string;
	readonly status?: number;
	readonly fieldPath?: string;
}

/** The base name is part of the boundary contract, so every failure of a read is recognizable. */
export class DiscordRestFailureError extends Error {
	public readonly code = "DISCORD_REST_READ_FAILED";
	public readonly operation: DiscordRestOperation;
	public readonly reason: DiscordRestFailureReason;
	public readonly attempts: number;
	public readonly status?: number;
	/** Present when `reason` is `"validation"`: the path inside the response, never its value. */
	public readonly fieldPath?: string;

	public constructor(details: DiscordRestFailureDetails) {
		super(DiscordRestFailureError.describe(details));
		this.name = "DiscordRestFailureError";
		this.operation = details.operation;
		this.reason = details.reason;
		this.attempts = details.attempts;
		if (details.status !== undefined) {
			this.status = details.status;
		}

		if (details.fieldPath !== undefined) {
			this.fieldPath = details.fieldPath;
		}
	}

	/** Operation, cause, attempt bound and field path — the facts R7 requires and nothing else. */
	private static describe(details: DiscordRestFailureDetails): string {
		const parts = [`${details.operation} failed (${details.reason}) after ${details.attempts} attempt(s)`];
		if (details.status !== undefined) {
			parts.push(`status ${details.status}`);
		}

		if (details.fieldPath !== undefined) {
			parts.push(`field ${details.fieldPath || "<root>"}`);
		}

		parts.push(details.detail);
		return parts.join(": ");
	}
}
