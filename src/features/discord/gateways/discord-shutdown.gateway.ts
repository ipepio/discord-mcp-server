import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { DiscordConnectionSnapshot, DiscordConnectionStatus } from "../models/domain/discord-connection-status.js";
import type { DiscordClosureReport } from "../models/domain/discord-connection-status.js";
import type { DiscordDrainOutcome, UndeliveredByKind } from "../models/domain/discord-shutdown-drain.js";
import { DEFAULT_SHUTDOWN_DRAIN_WINDOW_MS } from "../models/domain/discord-shutdown-drain.js";
import type {
	DiscordTransportCounters,
	DiscordTransportCounterSnapshot
} from "../models/domain/discord-transport-counters.js";

/**
 * Clean shutdown (spec R6): stop accepting inbound payloads, deliver what is already normalized inside a
 * bounded window, close the connection. Every event is therefore either delivered or counted per kind and
 * written into the gap ledger, which the next start's `resync-needed` signal names — no silent truncation,
 * no unbounded wait for a consumer that never answers, and no connection left open behind a stopped
 * process.
 */

/** What shutdown needs from the connection lifecycle, kept narrow so the order is the tested one. */
export interface ShutdownConnection {
	stopAcceptingInbound: () => void;
	close: () => Promise<DiscordClosureReport>;
	read: () => DiscordConnectionSnapshot;
}

/** What shutdown needs from the delivery stream. */
export interface ShutdownStream {
	stopAccepting: () => void;
	drain: (windowMs: number) => Promise<DiscordDrainOutcome>;
	pendingCount: () => number;
	deliveredCount: () => number;
}

export interface DiscordShutdownDependencies {
	readonly guildId: string;
	readonly connection: ShutdownConnection;
	readonly stream: ShutdownStream;
	readonly counters: DiscordTransportCounters;
	readonly logger: AppLogger;
	/** Override of the bounded window, for a deployment or a test that needs a different bound. */
	readonly drainWindowMs?: number;
}

/** What one shutdown did, in order: what the window delivered, what it declared, how the socket went. */
export interface DiscordShutdownReport {
	readonly windowMs: number;
	readonly drain: DiscordDrainOutcome;
	/** True when events were written off: the next connected transition names their kinds (R5). */
	readonly gapDeclared: boolean;
	readonly connectionClosed: boolean;
	readonly closureReason?: string;
	readonly statusAfter: DiscordConnectionStatus;
}

export class DiscordShutdownGateway {
	public constructor(private readonly deps: DiscordShutdownDependencies) {}

	public async shutdown(): Promise<DiscordShutdownReport> {
		const windowMs = this.deps.drainWindowMs ?? DEFAULT_SHUTDOWN_DRAIN_WINDOW_MS;
		this.deps.logger.info("Discord transport shutting down", {
			guildId: this.deps.guildId,
			windowMs,
			pending: this.deps.stream.pendingCount()
		});

		// R6 order, and it matters: nothing new may enter while the already-normalized events drain.
		this.deps.connection.stopAcceptingInbound();
		this.deps.stream.stopAccepting();

		const drain = await this.deps.stream.drain(windowMs);
		const closure = await this.deps.connection.close();
		const gapDeclared = drain.undelivered.length > 0;

		this.deps.logger.info("Discord event stream drained", {
			guildId: this.deps.guildId,
			windowMs,
			expired: drain.expired,
			delivered: drain.delivered,
			undelivered: summarize(drain.undelivered),
			gapDeclared
		});
		this.flushCounters();

		return {
			windowMs,
			drain,
			gapDeclared,
			connectionClosed: closure.closed,
			...(closure.reason === undefined ? {} : { closureReason: closure.reason }),
			statusAfter: this.deps.connection.read().status
		};
	}

	/** R6 example: the in-process counters reach the log before the process leaves (R10, R11 — counts only). */
	private flushCounters(): void {
		const snapshot: DiscordTransportCounterSnapshot = this.deps.counters.snapshot();
		this.deps.logger.info("Discord transport counters flushed", {
			guildId: this.deps.guildId,
			receivedRawEvents: snapshot.receivedRawEvents,
			normalizedPerKind: summarizeCounts(snapshot.normalizedPerKind),
			deliveryFailuresPerKind: summarizeCounts(snapshot.deliveryFailuresPerKind),
			undeliveredPerKind: summarizeCounts(snapshot.undeliveredPerKind),
			rejectedPayloadPerKind: summarizeCounts(snapshot.rejectedPayloadPerKind),
			droppedAsForeignGuild: snapshot.droppedAsForeignGuild,
			droppedGuildLess: snapshot.droppedGuildLess,
			unknownKindByRawName: JSON.stringify(snapshot.unknownKindByRawName),
			reconnectAttempts: snapshot.reconnectAttempts,
			resyncSignalsPublished: snapshot.resyncSignalsPublished
		});
	}
}

function summarize(undelivered: readonly UndeliveredByKind[]): string {
	return undelivered.length === 0 ? "none" : undelivered.map((entry) => `${entry.kind}=${entry.count}`).join(",");
}

/** Only the non-zero kinds: a flushed counter line stays readable and carries no payload (R11). */
function summarizeCounts(counts: Readonly<Record<string, number>>): string {
	const parts = Object.entries(counts)
		.filter(([, count]) => count > 0)
		.map(([kind, count]) => `${kind}=${count}`);

	return parts.length === 0 ? "none" : parts.join(",");
}
