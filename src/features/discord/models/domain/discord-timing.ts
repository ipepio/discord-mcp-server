/**
 * Determinism seams (docs/architecture/testing.md: inject time when determinism needs it). The
 * lifecycle never reads a global clock and never schedules a timer itself, so reconnect backoff,
 * delivery instants and the drain window are all driven by the test.
 */

export type DiscordClock = () => Date;

/** Resolves after the given delay; the production wiring uses `setTimeout`. */
export type DiscordWait = (milliseconds: number) => Promise<void>;

export const systemClock: DiscordClock = () => new Date();

export const waitReal: DiscordWait = (milliseconds) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, milliseconds);
	});
