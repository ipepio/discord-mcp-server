import { DISCORD_EVENT_KINDS, type DiscordEventKind } from "./discord-event-kind.enum.js";

/**
 * In-process counters for every anomaly and delivery fact spec R11 lists. They reset on restart and
 * are never persisted (R10) — where a consumer wants durable proof, it stores it. Only ids, kinds,
 * raw event names and counts appear here; never content and never a credential.
 */
export interface DiscordTransportCounterSnapshot {
	readonly receivedRawEvents: number;
	readonly normalizedPerKind: Readonly<Record<DiscordEventKind, number>>;
	readonly droppedAsForeignGuild: number;
	readonly droppedForeignGuildIds: readonly string[];
	readonly droppedGuildLess: number;
	readonly rejectedPayloadPerKind: Readonly<Record<DiscordEventKind, number>>;
	readonly unknownKindByRawName: Readonly<Record<string, number>>;
	readonly deliveryFailuresPerKind: Readonly<Record<DiscordEventKind, number>>;
	readonly undeliveredPerKind: Readonly<Record<DiscordEventKind, number>>;
	readonly reconnectAttempts: number;
	readonly resyncSignalsPublished: number;
}

function zeroByKind(): Record<DiscordEventKind, number> {
	const counts: Record<string, number> = {};
	for (const kind of DISCORD_EVENT_KINDS) {
		counts[kind] = 0;
	}

	return counts as Record<DiscordEventKind, number>;
}

function bump(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}

/** A plain mutable accumulator: the intake, the stream and the lifecycle all report into it. */
export class DiscordTransportCounters {
	private receivedRawEvents = 0;
	private readonly normalizedPerKind = zeroByKind();
	private readonly rejectedPayloadPerKind = zeroByKind();
	private readonly deliveryFailuresPerKind = zeroByKind();
	private readonly undeliveredPerKind = zeroByKind();
	private readonly unknownKindByRawName: Record<string, number> = {};
	private droppedAsForeignGuild = 0;
	private readonly droppedForeignGuildIds = new Set<string>();
	private droppedGuildLess = 0;
	private reconnectAttempts = 0;
	private resyncSignalsPublished = 0;

	public recordRawReceived(): void {
		this.receivedRawEvents += 1;
	}

	public recordNormalized(kind: DiscordEventKind): void {
		bump(this.normalizedPerKind, kind);
	}

	/** R2: a payload of another Guild, or one carrying no Guild id at all. */
	public recordForeignGuildDrop(guildId: string | undefined): void {
		if (guildId === undefined) {
			this.droppedGuildLess += 1;
			return;
		}

		this.droppedAsForeignGuild += 1;
		this.droppedForeignGuildIds.add(guildId);
	}

	/** R3 boundary: a known kind whose payload failed validation. */
	public recordRejectedPayload(kind: DiscordEventKind): void {
		bump(this.rejectedPayloadPerKind, kind);
	}

	/** R3: an event kind outside the enumerated set, keyed by its raw event name. */
	public recordUnknownKind(rawEventName: string): void {
		bump(this.unknownKindByRawName, rawEventName);
	}

	/** R4 error: a consumer handler threw; the delivery is not retried here. */
	public recordDeliveryFailure(kind: DiscordEventKind): void {
		bump(this.deliveryFailuresPerKind, kind);
	}

	/** R6 / R4: events declared as a gap because they were never delivered. */
	public recordUndelivered(kind: DiscordEventKind, count: number): void {
		this.undeliveredPerKind[kind] = (this.undeliveredPerKind[kind] ?? 0) + count;
	}

	public recordReconnectAttempt(): void {
		this.reconnectAttempts += 1;
	}

	public recordResyncSignalPublished(): void {
		this.resyncSignalsPublished += 1;
	}

	public snapshot(): DiscordTransportCounterSnapshot {
		return Object.freeze({
			receivedRawEvents: this.receivedRawEvents,
			normalizedPerKind: Object.freeze({ ...this.normalizedPerKind }),
			droppedAsForeignGuild: this.droppedAsForeignGuild,
			droppedForeignGuildIds: Object.freeze([...this.droppedForeignGuildIds]),
			droppedGuildLess: this.droppedGuildLess,
			rejectedPayloadPerKind: Object.freeze({ ...this.rejectedPayloadPerKind }),
			unknownKindByRawName: Object.freeze({ ...this.unknownKindByRawName }),
			deliveryFailuresPerKind: Object.freeze({ ...this.deliveryFailuresPerKind }),
			undeliveredPerKind: Object.freeze({ ...this.undeliveredPerKind }),
			reconnectAttempts: this.reconnectAttempts,
			resyncSignalsPublished: this.resyncSignalsPublished
		});
	}
}
