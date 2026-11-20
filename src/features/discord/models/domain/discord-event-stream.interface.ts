import type { DiscordEventKind } from "./discord-event-kind.enum.js";
import type { DeclaredGapReason } from "./discord-declared-gaps.js";
import type { NormalizedDiscordEvent, NormalizedEventOf } from "./normalized-discord-event.js";

/**
 * Event-stream subscription contract (spec "Contracts and boundaries", R4).
 *
 * A consumer registers one handler per normalized kind at composition time and receives
 * application-typed events only. There is deliberately no raw-payload escape hatch, no "subscribe to
 * everything" method and no way to inspect the connection: the only way to read this stream is a kind.
 * The consumer-facing contract is `DiscordEventConsumer`; `DiscordEventProducer` stays inside this
 * feature, so a subscribing feature cannot publish events of its own invention.
 */

/** One handler for one kind. Delivery is awaited, so a handler may be asynchronous. */
export type DiscordEventHandler<K extends DiscordEventKind = DiscordEventKind> = (
	event: NormalizedEventOf<K>
) => void | Promise<void>;

/** Cancels a registration; resolving a subscription is a composition-root concern, not runtime discovery. */
export interface DiscordEventSubscription {
	readonly unsubscribe: () => void;
}

/** What a subscribing feature receives: registration by kind, nothing else. */
export interface DiscordEventConsumer {
	subscribe<K extends DiscordEventKind>(kind: K, handler: DiscordEventHandler<K>): DiscordEventSubscription;
}

/** What this feature's own intake uses to hand a normalized event to the stream. */
export interface DiscordEventProducer {
	/** Enqueues for at-least-once delivery in receipt order (R4); never throws on a full queue. */
	publish: (event: NormalizedDiscordEvent) => void;
}

/**
 * A delivery that never reached its consumers (spec R4 error, R4 boundary, R6). `ids` carries what a
 * log line may name — ids, kinds and counts — and never content (R11). The reason is the same
 * vocabulary the gap ledger uses, so a drop and the signal that declares it cannot drift apart.
 */
export interface DroppedDelivery {
	readonly reason: DeclaredGapReason;
	readonly kinds: readonly DiscordEventKind[];
	readonly count: number;
	readonly ids?: Readonly<Record<string, string | number>>;
}

/**
 * The single seam every non-delivered event passes through. Whatever dispatch policy O1 finally
 * chooses, no drop is ever silent: the declaration records the gap and announces it as soon as the
 * connection can carry the announcement, or leaves it to the next connected transition (R4, R5, R6).
 */
export interface DiscordDeliveryDropDeclaration {
	declareDroppedDelivery: (drop: DroppedDelivery) => void;
}

/**
 * The delivery instant the `resync-needed` signal names (R5: "the instant of the last event delivered
 * before the gap, absent when there was none"). The stream owns this fact because it is the only
 * component that knows what actually reached a consumer.
 */
export interface DiscordDeliveryLedger {
	readonly lastDeliveredInstant: () => Date | undefined;
}
