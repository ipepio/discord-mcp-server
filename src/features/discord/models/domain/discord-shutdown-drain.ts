import type { DiscordEventKind } from "./discord-event-kind.enum.js";

/**
 * The bounded drain window of a clean shutdown (spec R6). "Bounded" is the whole point: the window is
 * never extended, so a stuck consumer can hold shutdown open forever. What the window could not deliver
 * is counted per kind and written into the gap ledger, which the next `resync-needed` signal names (R5) —
 * every event is either delivered or part of a declared gap, and the drain never truncates silently.
 *
 * The window is a technical bound of this feature, not a configuration variable: v1 adds no environment
 * item for this feature (spec Prerequisites), so the composition root may override it explicitly.
 */

/** How long shutdown waits for already-normalized events to reach their handlers. */
export const DEFAULT_SHUTDOWN_DRAIN_WINDOW_MS = 5_000;

/** Pacing of the progress checks inside the window; the window bounds the drain, the step only polls. */
export const DRAIN_POLL_STEP_MS = 25;

/** Undelivered events of one kind, as R6 requires them to be counted and logged. */
export interface UndeliveredByKind {
	readonly kind: DiscordEventKind;
	readonly count: number;
}

/** What one bounded drain achieved: delivered, or declared. Nothing else is possible (R6). */
export interface DiscordDrainOutcome {
	readonly windowMs: number;
	/** True when the window closed with events still undelivered. */
	readonly expired: boolean;
	/** Events that reached their handlers during this drain. */
	readonly delivered: number;
	readonly undelivered: readonly UndeliveredByKind[];
}

/** Half of the window still open? The clock arrives from outside, so a test drives the expiry. */
export function isDrainWindowOpen(startInstant: Date, nowInstant: Date, windowMs: number): boolean {
	return nowInstant.getTime() - startInstant.getTime() < windowMs;
}

/** Counts kinds in receipt order: the first occurrence fixes the order the gap is declared in. */
export function countByKind(kinds: readonly DiscordEventKind[]): readonly UndeliveredByKind[] {
	const counts = new Map<DiscordEventKind, number>();
	for (const kind of kinds) {
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}

	return [...counts].map(([kind, count]) => ({ kind, count }));
}
