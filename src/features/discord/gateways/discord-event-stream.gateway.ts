import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import { DiscordEventKind } from "../models/domain/discord-event-kind.enum.js";
import type {
	DiscordDeliveryDropDeclaration,
	DiscordDeliveryLedger,
	DiscordEventConsumer,
	DiscordEventHandler,
	DiscordEventProducer,
	DiscordEventSubscription
} from "../models/domain/discord-event-stream.interface.js";
import {
	describeEventIds,
	type NormalizedDiscordEvent,
	type NormalizedEventOf
} from "../models/domain/normalized-discord-event.js";
import {
	countByKind,
	DRAIN_POLL_STEP_MS,
	isDrainWindowOpen,
	type DiscordDrainOutcome,
	type UndeliveredByKind
} from "../models/domain/discord-shutdown-drain.js";
import type { DiscordClock, DiscordWait } from "../models/domain/discord-timing.js";
import type { DiscordTransportCounters } from "../models/domain/discord-transport-counters.js";

/**
 * Delivery of the normalized stream (spec R4). At-least-once, in the order the connection received the
 * events, one delivery at a time: a queue and a single worker. No deduplication, no reordering, no
 * retry and no convergence promise — consumers own those (guild-state R9/R10, ingestion R7/R8) and are
 * written to be replayed safely. A handler that throws is isolated: the failure is logged with ids,
 * counted per kind and declared as a dropped delivery, and it never stops the other handlers, the
 * later events or the connection. Nothing survives a restart: what a shutdown could not deliver is
 * counted and declared, never truncated in silence (R6).
 *
 * Open-decision note (O1): the queue is deliberately unbounded, so no backpressure policy is chosen
 * here. Whatever O1 finally decides, an event that cannot be delivered must pass through
 * `DiscordDeliveryDropDeclaration` — that single seam is what keeps "no drop is ever silent" true.
 */

/** What the stream needs; every fact it reports is in-process only (R10). */
export interface DiscordEventStreamDependencies {
	readonly counters: DiscordTransportCounters;
	readonly logger: AppLogger;
	readonly clock: DiscordClock;
	/** The drain's pacing seam (R6): a test drives the window instead of sleeping through it. */
	readonly wait: DiscordWait;
	readonly onDroppedDelivery: DiscordDeliveryDropDeclaration;
}

/** A handler as the registry stores it: the union in, narrowed by the registry key on the way out. */
type StoredHandler = (event: NormalizedDiscordEvent) => void | Promise<void>;

/**
 * The queue unit. `declared` records that a bounded drain already wrote the delivery off: an event that
 * was counted as a gap must not later present itself as the last delivered event, or the shutdown would
 * report the loss it just declared.
 */
interface DeliveryAttempt {
	readonly event: NormalizedDiscordEvent;
	declared: boolean;
}

export class DiscordEventStreamGateway implements DiscordEventProducer, DiscordEventConsumer, DiscordDeliveryLedger {
	private readonly handlers = new Map<DiscordEventKind, Set<StoredHandler>>();
	private readonly queue: DeliveryAttempt[] = [];
	private worker: Promise<void> | undefined;
	private inFlight: DeliveryAttempt | undefined;
	private accepting = true;
	private deliveredEvents = 0;
	private lastDelivered: Date | undefined;

	public constructor(private readonly deps: DiscordEventStreamDependencies) {}

	/**
	 * R4: registration by kind, resolved at composition time. The stored handler is widened to the event
	 * union because the registry key is the only dispatcher — `deliver` hands an event exclusively to the
	 * handlers registered under its own kind, which is the invariant `narrowTo` re-checks at runtime.
	 */
	public subscribe<K extends DiscordEventKind>(kind: K, handler: DiscordEventHandler<K>): DiscordEventSubscription {
		const stored: StoredHandler = (event) => {
			const typed = narrowTo(kind, event);
			return handler(typed);
		};

		const registered = this.handlers.get(kind) ?? new Set<StoredHandler>();
		registered.add(stored);
		this.handlers.set(kind, registered);

		return {
			unsubscribe: (): void => {
				registered.delete(stored);
				if (registered.size === 0) {
					this.handlers.delete(kind);
				}
			}
		};
	}

	public readonly publish = (event: NormalizedDiscordEvent): void => {
		if (!this.accepting) {
			// R6 boundary: nothing is buffered once the shutdown has begun, and nothing is truncated
			// silently — the event is counted and declared as a gap the next start's signal covers (R4).
			this.deps.counters.recordUndelivered(event.kind, 1);
			this.deps.logger.warn("Discord event refused: the stream has stopped accepting", {
				...describeEventIds(event)
			});
			this.deps.onDroppedDelivery.declareDroppedDelivery({
				reason: "intake-stopped",
				kinds: [event.kind],
				count: 1,
				ids: describeEventIds(event)
			});

			return;
		}

		this.queue.push({ event, declared: false });
		this.schedule();
	};

	/** R5: the instant of the last event that reached its handlers, absent when nothing ever did. */
	public readonly lastDeliveredInstant = (): Date | undefined => this.lastDelivered;

	/** Events queued or in flight: what a bounded drain (R6) races against. */
	public pendingCount(): number {
		return this.queue.length + (this.inFlight === undefined ? 0 : 1);
	}

	/** Cumulative deliveries, so a caller can report what a drain window managed to finish. */
	public deliveredCount(): number {
		return this.deliveredEvents;
	}

	/** Handlers registered for a kind. */
	public handlerCount(kind: DiscordEventKind): number {
		return this.handlers.get(kind)?.size ?? 0;
	}

	public isAccepting(): boolean {
		return this.accepting;
	}

	/** Awaits the in-flight delivery chain: tests and the drain use it instead of sleeping. */
	public async settle(): Promise<void> {
		while (this.worker !== undefined) {
			await this.worker;
		}
	}

	/** R6 step one: stop taking anything new. Already queued events still get their window. */
	public stopAccepting(): void {
		this.accepting = false;
	}

	/**
	 * R6: deliver what is already normalized inside the window, then declare the rest by kind. The window
	 * is never extended, and the events it wrote off stay declared even if a slow handler finishes after
	 * it — the alternative is a shutdown that waits for a consumer that never answers.
	 */
	public async drain(windowMs: number): Promise<DiscordDrainOutcome> {
		const startedAt = this.deps.clock();
		const deliveredAtStart = this.deliveredEvents;

		while (this.pendingCount() > 0 && isDrainWindowOpen(startedAt, this.deps.clock(), windowMs)) {
			await this.deps.wait(DRAIN_POLL_STEP_MS);
		}

		const expired = this.pendingCount() > 0;
		const stranded = this.writeOff();
		const undelivered = this.declareStranded(stranded, windowMs);

		return {
			windowMs,
			expired,
			delivered: this.deliveredEvents - deliveredAtStart,
			undelivered
		};
	}

	private schedule(): void {
		if (this.worker !== undefined) {
			return;
		}

		const worker = this.runQueue();
		this.worker = worker;
		void worker.finally(() => {
			if (this.worker === worker) {
				this.worker = undefined;
			}

			// An event published while the worker was finishing must still be delivered, in order (R4).
			if (this.queue.length > 0 && this.worker === undefined) {
				this.schedule();
			}
		});
	}

	private async runQueue(): Promise<void> {
		for (;;) {
			const attempt = this.queue.shift();
			if (attempt === undefined) {
				return;
			}

			await this.deliver(attempt);
		}
	}

	private async deliver(attempt: DeliveryAttempt): Promise<void> {
		const event = attempt.event;
		this.inFlight = attempt;
		try {
			for (const handler of this.registeredFor(event.kind)) {
				await this.invoke(event, handler);
			}
		} finally {
			if (this.inFlight === attempt) {
				this.inFlight = undefined;
			}
		}

		this.deliveredEvents += 1;

		// The signal this feature generates is not an inbound fact: R5 names the last event delivered
		// before the gap, so a signal never becomes its own evidence. A written-off delivery (R6) is
		// already declared as lost and never claims the ledger either.
		if (!attempt.declared && event.kind !== DiscordEventKind.resyncNeeded) {
			this.lastDelivered = this.deps.clock();
		}
	}

	/**
	 * Writes off everything the window did not deliver — queued events and the one delivery a stuck
	 * handler still holds — and returns the events themselves, so the loss is counted rather than lost.
	 */
	private writeOff(): readonly NormalizedDiscordEvent[] {
		const stranded = this.queue.splice(0, this.queue.length);
		const inFlight = this.inFlight;
		if (inFlight !== undefined) {
			stranded.unshift(inFlight);
		}

		for (const attempt of stranded) {
			attempt.declared = true;
		}

		return stranded.map((attempt) => attempt.event);
	}

	/** R6: counted per kind, logged per kind, declared once as a gap naming those kinds. */
	private declareStranded(events: readonly NormalizedDiscordEvent[], windowMs: number): readonly UndeliveredByKind[] {
		if (events.length === 0) {
			return [];
		}

		const undelivered = countByKind(events.map((event) => event.kind));
		// Every stranded event carries the configured Guild: the source filter ran before normalization (R2).
		const guildId = events[0]?.guildId;
		for (const entry of undelivered) {
			this.deps.counters.recordUndelivered(entry.kind, entry.count);
			this.deps.logger.warn("Discord event undelivered at shutdown", {
				...(guildId === undefined ? {} : { guildId }),
				kind: entry.kind,
				count: entry.count,
				windowMs
			});
		}

		this.deps.onDroppedDelivery.declareDroppedDelivery({
			reason: "drain-expiry",
			kinds: undelivered.map((entry) => entry.kind),
			count: events.length
		});

		return undelivered;
	}

	/**
	 * A snapshot, so an unsubscribe from inside a handler cannot change the set being delivered to
	 * mid-event. Handlers run in registration order.
	 */
	private registeredFor(kind: DiscordEventKind): readonly StoredHandler[] {
		const registered = this.handlers.get(kind);
		return registered === undefined ? [] : [...registered];
	}

	/**
	 * R4 error: one handler failure is contained. The other handlers of this event still run, later
	 * events still deliver, the connection is untouched, and the failed delivery is not retried here —
	 * the consumer's own error path and resync recover it.
	 */
	private async invoke(event: NormalizedDiscordEvent, handler: StoredHandler): Promise<void> {
		try {
			await handler(event);
		} catch (error) {
			this.deps.counters.recordDeliveryFailure(event.kind);
			this.deps.logger.error("Discord event delivery failed", {
				...describeEventIds(event),
				reason: errorName(error)
			});

			// R4 hardening: the drop is declared with its kind, so it turns into a resync and not a hole.
			this.deps.onDroppedDelivery.declareDroppedDelivery({
				reason: "dropped-delivery",
				kinds: [event.kind],
				count: 1,
				ids: describeEventIds(event)
			});
		}
	}
}

/**
 * Carries the kind/key relationship TypeScript cannot express through a stored generic: the registry key
 * is the proof, and a mismatch is a programming error in this feature, not input from outside it. It
 * throws rather than handing a consumer an event of the wrong shape (R3's "never invent a shape").
 */
function narrowTo<K extends DiscordEventKind>(kind: K, event: NormalizedDiscordEvent): NormalizedEventOf<K> {
	if (event.kind !== kind) {
		throw new Error(`Discord stream dispatch error: event of kind ${event.kind} for handler of kind ${kind}`);
	}

	return event as NormalizedEventOf<K>;
}

/** Error identity only: a consumer's message may carry content, so it never reaches a log line (R11). */
function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown";
}
