import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { DiscordConnectionStatusSource } from "../models/domain/discord-connection-status.js";
import { DISCORD_EVENT_KINDS } from "../models/domain/discord-event-kind.enum.js";
import type {
	DiscordDeliveryStatusSource,
	DiscordFeatureStatus,
	DiscordGapLedgerView,
	DiscordStatusQuery
} from "../models/domain/discord-status.interface.js";
import type { DiscordClock } from "../models/domain/discord-timing.js";
import type { DiscordTransportCounters } from "../models/domain/discord-transport-counters.js";

/**
 * The connection-status query of the spec's affected paths (R11): one read of the whole in-process
 * picture — status with its connect/disconnect instants, the counters, the queue's delivery state and the
 * gaps not yet summarized into a signal.
 *
 * It composes only the narrow read sides of the pieces it reports on, so an operator or a consumer feature
 * never needs the connection adapter, the stream's internals or a second way in. What it returns is ids,
 * kinds, counts and instants: never message content, never a credential, never a response body — the same
 * rule every log line this feature writes follows (R11).
 */
export interface DiscordStatusDependencies {
	readonly connection: DiscordConnectionStatusSource;
	readonly counters: DiscordTransportCounters;
	readonly delivery: DiscordDeliveryStatusSource;
	readonly gaps: DiscordGapLedgerView;
	readonly clock: DiscordClock;
	readonly logger: AppLogger;
}

export class DiscordStatusGateway implements DiscordStatusQuery {
	public constructor(private readonly deps: DiscordStatusDependencies) {}

	/**
	 * Assembled on the fly from the live accumulators: nothing here is stored, so nothing here can go
	 * stale, and a restart finds this read empty (R10).
	 */
	public readonly read = (): DiscordFeatureStatus => {
		const connection = this.deps.connection.read();
		const counters = this.deps.counters.snapshot();
		const handlerCountByKind: Record<string, number> = {};
		for (const kind of DISCORD_EVENT_KINDS) {
			handlerCountByKind[kind] = this.deps.delivery.handlerCount(kind);
		}

		const lastDelivered = this.deps.delivery.lastDeliveredInstant();
		const pendingGaps = this.deps.gaps.pending();
		const delivery = {
			pending: this.deps.delivery.pendingCount(),
			delivered: this.deps.delivery.deliveredCount(),
			accepting: this.deps.delivery.isAccepting(),
			...(lastDelivered === undefined ? {} : { lastDeliveredInstant: lastDelivered }),
			handlerCountByKind: Object.freeze(handlerCountByKind)
		};

		const status: DiscordFeatureStatus = Object.freeze({
			observedAt: this.deps.clock(),
			connection,
			counters,
			delivery: Object.freeze(delivery),
			pendingGaps
		});

		// Reading status is itself observable, and it reports ids and counts only (R11).
		this.deps.logger.debug("Discord feature status read", {
			status: connection.status,
			epoch: connection.epoch,
			reconnectAttempts: connection.reconnectAttempts,
			pending: delivery.pending,
			delivered: delivery.delivered,
			receivedRawEvents: counters.receivedRawEvents,
			droppedAsForeignGuild: counters.droppedAsForeignGuild,
			pendingGaps: pendingGaps.length,
			observedAt: status.observedAt.toISOString()
		});

		return status;
	};
}
