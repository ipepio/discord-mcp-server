/**
 * Reconnect backoff for the single Gateway connection (spec R1). Pure arithmetic with no timer and no
 * environment dependency, so the growth, the ceiling and the `unavailable` threshold are testable
 * without waiting; the lifecycle owns when it is applied.
 */
export interface ReconnectBackoffSettings {
	/** Delay before the first reconnect attempt. */
	readonly baseDelayMs: number;
	readonly factor: number;
	/** Ceiling: a pathological loop stays visible through the attempt count, never through a wait. */
	readonly maxDelayMs: number;
	/** Consecutive failed attempts after which the connection is reported `unavailable` (R1, R11). */
	readonly unavailableAfterAttempts: number;
}

export const DEFAULT_RECONNECT_BACKOFF: ReconnectBackoffSettings = Object.freeze({
	baseDelayMs: 1_000,
	factor: 2,
	maxDelayMs: 60_000,
	unavailableAfterAttempts: 5
});

/** Attempt numbers start at 1; attempt 0 (or a negative one) waits nothing at all. */
export function computeReconnectDelayMs(attempt: number, settings: ReconnectBackoffSettings): number {
	if (attempt <= 0) {
		return 0;
	}

	const grown = settings.baseDelayMs * settings.factor ** (attempt - 1);
	return Math.min(Math.round(grown), settings.maxDelayMs);
}

export function isUnavailableAfter(attempt: number, settings: ReconnectBackoffSettings): boolean {
	return attempt >= settings.unavailableAfterAttempts;
}
