import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { DiscordEventKind } from "../models/domain/discord-event-kind.enum.js";
import type { DiscordEventProducer } from "../models/domain/discord-event-stream.interface.js";
import type { NormalizedDiscordEvent } from "../models/domain/normalized-discord-event.js";
import { decideSourceGuild } from "../models/domain/source-guild-filter.js";
import type { DiscordTransportCounters } from "../models/domain/discord-transport-counters.js";
import { mapRawEvent } from "../models/mappers/discord-event.mapper.js";
import type { RawDiscordEvent } from "./discord.gateway.interface.js";

/**
 * The intake path: filter by source Guild, then normalize, then hand the application events to the
 * stream (spec R2, R3). It performs no delivery itself and holds no state: what it decides is visible
 * through the counters it reports and the events it publishes.
 */
export interface DiscordEventIntakeDependencies {
	readonly configuredGuildId: string;
	readonly producer: DiscordEventProducer;
	readonly counters: DiscordTransportCounters;
	readonly logger: AppLogger;
}

export class DiscordEventIntakeGateway {
	public constructor(private readonly deps: DiscordEventIntakeDependencies) {}

	public handle(raw: RawDiscordEvent): void {
		// R2: the filter runs before normalization, so a foreign payload is never even looked at as data.
		const decision = decideSourceGuild(raw.eventName, raw.payload, this.deps.configuredGuildId);
		if (decision.outcome !== "configured") {
			this.reportDropped(
				raw.eventName,
				decision.outcome,
				decision.outcome === "foreign" ? decision.guildId : undefined
			);
			return;
		}

		const result = mapRawEvent(raw.eventName, raw.payload, decision.guildId);

		if (result.outcome === "unknown-kind") {
			this.reportUnknownKind(raw.eventName);
			return;
		}

		if (result.outcome === "malformed") {
			this.reportRejectedPayload(raw.eventName, result.kind, result.fieldPath, result.reason);
			return;
		}

		this.publishAll(result.events);
	}

	private publishAll(events: readonly NormalizedDiscordEvent[]): void {
		for (const event of events) {
			this.deps.counters.recordNormalized(event.kind);
			this.deps.producer.publish(event);
		}
	}

	/** R2 anomaly: the Guild id when present and the raw event name — never the payload, never content. */
	private reportDropped(rawEventName: string, outcome: "foreign" | "guild-less", guildId: string | undefined): void {
		this.deps.counters.recordForeignGuildDrop(guildId);
		this.deps.logger.warn("Discord event dropped by the source Guild filter", {
			reason: outcome,
			rawEventName,
			...(guildId === undefined ? {} : { guildId })
		});
	}

	/** R3: an enumerated set that does not contain the kind is visible as a counter, never as silence. */
	private reportUnknownKind(rawEventName: string): void {
		this.deps.counters.recordUnknownKind(rawEventName);
		this.deps.logger.warn("Unknown Discord event kind", { rawEventName });
	}

	/** R3 error: ids, kind and the failing field path only. A normalization failure never aborts anything. */
	private reportRejectedPayload(
		rawEventName: string,
		kind: DiscordEventKind,
		fieldPath: string,
		reason: string
	): void {
		this.deps.counters.recordRejectedPayload(kind);
		this.deps.logger.error("Discord payload rejected by normalization", {
			kind,
			rawEventName,
			fieldPath,
			guildId: this.deps.configuredGuildId,
			reason
		});
	}
}
