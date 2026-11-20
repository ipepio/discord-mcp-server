/**
 * R3's import window, as data rather than as an environment string (docs/features/ingestion.md R3).
 *
 * The window is one of exactly two things, and the type says which: `full` imports all retrievable history of
 * a registered channel and therefore has **no** lower bound, `days` imports only what is strictly after
 * `(import start − IMPORT_DAYS days)` and therefore has one. A third shape — `days` with no number, or `full`
 * with one ignored — is refused by `../config/ingestion-config.interface.js` before a window value like these
 * can exist, so nothing here has to defend against it.
 *
 * Two rules are stated once in this file and reused by every walk of a channel's history:
 *
 * - **Strictly after.** R3's wording is exact — "strictly after (import start − `IMPORT_DAYS` days)" — so a
 *   message whose Discord creation timestamp names the cutoff instant itself is *outside* the window. That is
 *   the spec's own boundary example, and the reason the comparison is `>` and not `>=`.
 * - **The comparison is Discord's timestamp, never the hub's clock.** R8 states the rule for edits and
 *   deletions and it applies here too: the window's bound is computed from one injected instant (the import
 *   start) and every message is then judged against `createdInstant`, the field Discord named. A message's
 *   arrival order, its id or a local read time never enters the decision.
 */

/** The two modes `IMPORT_MODE` admits. */
export type ImportMode = "full" | "days";

/** Every admitted mode, in declaration order: the vocabulary a configuration error names. */
export const IMPORT_MODES: readonly ImportMode[] = Object.freeze(["full", "days"] as const);

/** All retrievable history: no lower bound at all. */
export interface FullImportWindow {
	readonly mode: "full";
}

/** Only messages strictly newer than `(import start − days)`. */
export interface DaysImportWindow {
	readonly mode: "days";
	/** Whole days, at least one, validated as configuration. */
	readonly days: number;
}

/** The window a run imports under. */
export type ImportWindow = FullImportWindow | DaysImportWindow;

/** One day in milliseconds: the unit `IMPORT_DAYS` counts. */
export const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * The largest instant a PostgreSQL `timestamptz` parameter can hold, in the same epoch milliseconds the driver
 * uses. A `days` value beyond this would compute a cutoff the database could not store and that `Date` would
 * turn into `Invalid Date`, so configuration refuses it rather than discovering it mid-import.
 */
export const MAX_STORABLE_EPOCH_MS = 8.64e15;

/** The largest `IMPORT_DAYS` whose cutoff is still a storable instant. */
export const MAX_IMPORT_DAYS = Math.floor(MAX_STORABLE_EPOCH_MS / MILLISECONDS_PER_DAY);

/**
 * R3's lower bound for one run. `full` has none, which is `null` and not a very old date: a sentinel instant
 * would become a second, unstated window rule the day someone compares against it.
 *
 * `startedInstant` is the import start — the run's own injected instant, taken once before the first page is
 * asked for. A resumed run therefore computes its own bound, which is what R3 says (the window is measured
 * from the import start) and is safe in both directions: nothing newer is excluded, and anything re-read from
 * an older run's window is applied through R7's idempotent store write.
 */
export function resolveImportCutoff(window: ImportWindow, startedInstant: Date): Date | null {
	if (window.mode === "full") {
		return null;
	}

	return new Date(startedInstant.getTime() - window.days * MILLISECONDS_PER_DAY);
}

/**
 * R3, the membership test. A window with no bound admits every message; a bounded window admits only messages
 * strictly after its cutoff, so a message exactly at the cutoff is outside.
 */
export function messageIsInsideWindow(createdInstant: Date, cutoff: Date | null): boolean {
	return cutoff === null || createdInstant.getTime() > cutoff.getTime();
}

/**
 * The stop rule for a newest-first page: did this page reach the cutoff?
 *
 * Discord pages a channel newest-first, and a snowflake id carries the instant its message was created, so the
 * pages ahead of this one are older than everything in it. Once the first message at or before the cutoff is reached,
 * the window's boundary is behind us and an older page cannot hold a message R3 wants. The walk stops.
 *
 * Discord's history contract preserves newest-first order; no extra request past the boundary is needed.
 */
export function pageLiesOutsideWindow(createdInstants: readonly Date[], cutoff: Date | null): boolean {
	if (cutoff === null || createdInstants.length === 0) {
		return false;
	}

	return createdInstants.some((createdInstant) => !messageIsInsideWindow(createdInstant, cutoff));
}
