import type { DiscordConnectionSnapshot } from "./discord-connection-status.js";
import type { DeclaredGap } from "./discord-declared-gaps.js";
import type { DiscordEventKind } from "./discord-event-kind.enum.js";
import type { DiscordTransportCounterSnapshot } from "./discord-transport-counters.js";

/**
 * The feature's observability contract (spec R11). One read returns the whole in-process picture:
 * connection status with its instants, the counters, the delivery state and the declared gaps. It is the
 * surface a health endpoint or an operator tool reads, and the reason no consumer needs a second way in.
 *
 * Everything here is in-process (R10): a restart rebuilds it from configuration, and nothing on this
 * interface is persisted, replayed or reconstructed from storage.
 */

/** Delivery state of the in-process queue, as the stream reports it. */
export interface DiscordDeliverySnapshot {
	/** Events accepted but not yet handed to a handler. */
	readonly pending: number;
	/** Events handed to at least one handler since the process started. */
	readonly delivered: number;
	/** False once the shutdown path has closed intake (R6). */
	readonly accepting: boolean;
	/** The instant the last successful delivery happened, from the injected clock. */
	readonly lastDeliveredInstant?: Date;
	/** How many handlers a consumer feature registered for a kind: 0 means nothing is listening. */
	readonly handlerCountByKind: Readonly<Record<DiscordEventKind, number>>;
}

/** The whole observable state of one running Installation. */
export interface DiscordFeatureStatus {
	/** The instant this reading was taken, from the injected clock. */
	readonly observedAt: Date;
	readonly connection: DiscordConnectionSnapshot;
	readonly counters: DiscordTransportCounterSnapshot;
	readonly delivery: DiscordDeliverySnapshot;
	/** Gaps recorded and not yet summarized into a `resync-needed` signal (R4, R5, R6). */
	readonly pendingGaps: readonly DeclaredGap[];
}

/**
 * What the status query needs from the delivery queue. `DiscordEventStreamGateway` satisfies it
 * structurally, so the status read never reaches into the stream's internals (R11 boundary).
 */
export interface DiscordDeliveryStatusSource {
	readonly pendingCount: () => number;
	readonly deliveredCount: () => number;
	readonly isAccepting: () => boolean;
	readonly handlerCount: (kind: DiscordEventKind) => number;
	readonly lastDeliveredInstant: () => Date | undefined;
}

/** What the status query needs from the gap ledger (R4, R5, R6). */
export interface DiscordGapLedgerView {
	readonly pending: () => readonly DeclaredGap[];
}

/** Read side of the status. A consumer never needs more than this call. */
export interface DiscordStatusQuery {
	readonly read: () => DiscordFeatureStatus;
}
