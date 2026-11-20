import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import { DiscordConnectionStatus } from "../models/domain/discord-connection-status.js";
import type {
	DiscordConnectedTransition,
	DiscordConnectionObserver,
	DiscordConnectionStatusSource
} from "../models/domain/discord-connection-status.js";
import type { DiscordDeclaredGaps } from "../models/domain/discord-declared-gaps.js";
import { DiscordEventKind } from "../models/domain/discord-event-kind.enum.js";
import type {
	DiscordDeliveryDropDeclaration,
	DiscordDeliveryLedger,
	DiscordEventProducer,
	DroppedDelivery
} from "../models/domain/discord-event-stream.interface.js";
import { describeEventIds, type ResyncNeededEvent } from "../models/domain/normalized-discord-event.js";
import type { DiscordClock } from "../models/domain/discord-timing.js";
import type { DiscordTransportCounters } from "../models/domain/discord-transport-counters.js";

/**
 * The `resync-needed` signal (spec R5) and the declaration of every dropped delivery (R4). One
 * transition into a connected state produces exactly one signal — including the first connection after
 * process start, because nothing can be known about the interval while the process was not connected.
 * Many failed attempts summarize into the single signal of the transition that finally succeeded, and
 * their count keeps a pathological loop visible. No signal is ever published while disconnected: the
 * absence is reported through `unavailable`, never disguised as "nothing changed".
 */
export interface DiscordResyncDependencies {
	readonly guildId: string;
	readonly producer: DiscordEventProducer;
	readonly ledger: DiscordDeliveryLedger;
	readonly gaps: DiscordDeclaredGaps;
	readonly counters: DiscordTransportCounters;
	readonly connection: DiscordConnectionStatusSource;
	readonly logger: AppLogger;
	readonly clock: DiscordClock;
}

export class DiscordResyncGateway implements DiscordConnectionObserver, DiscordDeliveryDropDeclaration {
	public constructor(private readonly deps: DiscordResyncDependencies) {}

	/** R5: one signal per connected transition, summarizing every gap that accumulated before it. */
	public readonly onConnected = (transition: DiscordConnectedTransition): void => {
		// Consuming the ledger is what makes one signal per transition rather than one per gap or attempt.
		const summary = this.deps.gaps.consumeSummary();
		const event = this.signal(
			transition.epoch,
			transition.reconnectAttempts,
			summary.narrowed,
			summary.affectedKinds
		);

		this.publish(event, summary.narrowed ? "declared gap" : "connection gap", summary.undeliveredCount);
	};

	/** R5 error: an unusable connection is reported, and no signal stands in for it. */
	public readonly onUnavailable = (reason: string, at: Date): void => {
		this.deps.logger.warn("Discord connection unavailable; no resync-needed signal published", {
			guildId: this.deps.guildId,
			reason,
			unavailableInstant: at.toISOString()
		});
	};

	/**
	 * R4 hardening: a delivery that never reached its consumers is declared, never silent. While the
	 * connection is usable the declaration is announced immediately, so a consumer repairs the named
	 * kinds instead of waiting for a reconnect; otherwise it joins the gap ledger and the next connected
	 * transition names it. Either way it is counted and logged with ids only.
	 */
	public readonly declareDroppedDelivery = (drop: DroppedDelivery): void => {
		const announced = this.announceNow(drop);
		if (announced) {
			return;
		}

		this.deps.gaps.record({
			reason: drop.reason,
			affectedKinds: drop.kinds,
			undeliveredCount: drop.count,
			declaredInstant: this.deps.clock()
		});

		this.deps.logger.warn("Discord delivery dropped and declared as a gap", {
			...(drop.ids ?? {}),
			reason: drop.reason,
			kinds: drop.kinds.join(","),
			count: drop.count
		});
	};

	/**
	 * True when the announcement went out. A `dropped-delivery` gap is the only one the connection can
	 * carry in real time: a drain expiry or a stopped intake belongs to the next start's signal (R6), and
	 * the signal kind itself is never announced live, because a failing `resync-needed` handler would
	 * otherwise re-trigger itself on every failed delivery.
	 */
	private announceNow(drop: DroppedDelivery): boolean {
		if (drop.reason !== "dropped-delivery" || drop.kinds.includes(DiscordEventKind.resyncNeeded)) {
			return false;
		}

		const snapshot = this.deps.connection.read();
		if (snapshot.status !== DiscordConnectionStatus.connected) {
			return false;
		}

		const event = this.signal(snapshot.epoch, snapshot.reconnectAttempts, true, drop.kinds);
		this.publish(event, drop.reason, drop.count);

		return true;
	}

	private signal(
		epoch: number,
		reconnectAttempts: number,
		narrowed: boolean,
		affectedKinds: readonly DiscordEventKind[]
	): ResyncNeededEvent {
		const lastDelivered = this.deps.ledger.lastDeliveredInstant();

		return {
			kind: DiscordEventKind.resyncNeeded,
			guildId: this.deps.guildId,
			epoch,
			reconnectAttempts,
			...(lastDelivered === undefined ? {} : { lastDeliveredInstant: lastDelivered }),
			// R3: absent is never conflated with empty. An unscoped gap names no kind, so consumers
			// resynchronize everything; a narrowed one names exactly the affected kinds.
			...(narrowed ? { affectedKinds } : {})
		};
	}

	private publish(event: ResyncNeededEvent, reason: string, undeliveredCount: number): void {
		this.deps.counters.recordResyncSignalPublished();
		this.deps.producer.publish(event);
		this.deps.logger.info("Discord resync-needed signal published", {
			...describeEventIds(event),
			reason,
			undeliveredCount,
			...(event.affectedKinds === undefined ? {} : { affectedKinds: event.affectedKinds.join(",") })
		});
	}
}
