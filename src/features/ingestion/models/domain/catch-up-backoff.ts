/**
 * `odd/tasks/ingestion-catchup.md` T3 / docs/features/ingestion.md R14: how long a deferred channel waits
 * before the catch-up asks for another page of it.
 *
 * The rule exists because the two failure shapes need different answers. A rate limit or a 5xx is a
 * condition of the moment, so the channel must be retried — but not immediately, and not in the tick that
 * just failed, or the job spends its whole bound against a limit Discord already asked it to respect. A 4xx
 * is a condition of the channel (permission removed, channel deleted), so it is recorded as `skipped` and
 * gets no delay at all: re-asking once per tick is bounded by the tick interval and is the only way an
 * in-process import ever recovers a channel whose permission came back.
 *
 * The shape is exponential from a base of one minute, capped at an hour. The exponent is the number of
 * **consecutive** deferrals, which is why the ledger resets `attempts` to zero on every outcome that is not a
 * deferral: a channel that advanced a page and then hit a limit starts its wait from the base again, and a
 * permanently failing channel settles at one attempt per hour instead of spinning.
 *
 * Pure arithmetic over an instant the caller observed. Nothing here reads the wall clock, an environment
 * variable or a database row: `now` is the tick's own instant, so the delay is a fact of the run and a test
 * can state it exactly.
 */

/** The wait after the first deferral: one minute. */
export const CATCH_UP_BACKOFF_BASE_MS = 60_000;

/** The ceiling: an hour between attempts, however many deferrals accumulated. */
export const CATCH_UP_BACKOFF_MAX_MS = 3_600_000;

/**
 * When the catch-up may next attempt a channel that has been deferred `attempts` times consecutively.
 *
 * `attempts` is 1 for the first deferral, and a value below 1 (a row that was never attempted) is treated as
 * the first one: the base delay is the shortest wait this rule can state, never zero. The doubling saturates
 * at the ceiling before it can leave the range of a JavaScript date, so no arithmetic here produces an
 * invalid instant.
 */
export function nextAttemptInstant(attempts: number, now: Date): Date {
	const consecutive = Number.isFinite(attempts) ? Math.max(1, Math.trunc(attempts)) : 1;
	const delay = Math.min(CATCH_UP_BACKOFF_BASE_MS * 2 ** (consecutive - 1), CATCH_UP_BACKOFF_MAX_MS);
	return new Date(now.getTime() + delay);
}
