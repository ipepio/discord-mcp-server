import { DiscordConnectionGateway } from "../../../../src/features/discord/gateways/discord-connection.gateway.js";
import { DiscordEventIntakeGateway } from "../../../../src/features/discord/gateways/discord-event-intake.gateway.js";
import { DiscordEventStreamGateway } from "../../../../src/features/discord/gateways/discord-event-stream.gateway.js";
import { DiscordResyncGateway } from "../../../../src/features/discord/gateways/discord-resync.gateway.js";
import { DiscordShutdownGateway } from "../../../../src/features/discord/gateways/discord-shutdown.gateway.js";
import type { DiscordConfig } from "../../../../src/features/discord/config/discord-config.interface.js";
import { DiscordDeclaredGaps } from "../../../../src/features/discord/models/domain/discord-declared-gaps.js";
import type { DiscordConnectionSnapshot } from "../../../../src/features/discord/models/domain/discord-connection-status.js";
import type { DiscordEventKind } from "../../../../src/features/discord/models/domain/discord-event-kind.enum.js";
import type { DiscordEventProducer } from "../../../../src/features/discord/models/domain/discord-event-stream.interface.js";
import type { NormalizedDiscordEvent } from "../../../../src/features/discord/models/domain/normalized-discord-event.js";
import { DiscordTransportCounters } from "../../../../src/features/discord/models/domain/discord-transport-counters.js";
import { DEFAULT_RECONNECT_BACKOFF } from "../../../../src/features/discord/models/domain/reconnect-backoff.js";
import type { ReconnectBackoffSettings } from "../../../../src/features/discord/models/domain/reconnect-backoff.js";
import type { RawDiscordEvent } from "../../../../src/features/discord/gateways/discord.gateway.interface.js";
import { FakeDiscordGatewayClientFactory, fakeConfig, fakeTimer } from "./fake-discord-gateway-client.js";
import type { FakeLoginOutcome, FakeResumeOutcome } from "./fake-discord-gateway-client.js";
import { GUILD_ID } from "./normalize.js";
import { RecordingLogger } from "./recording-logger.js";

/**
 * The whole Installation wired the way the composition root will wire it — connection lifecycle, source
 * filter and normalization, delivery stream, resync signaling and clean shutdown — against the fake
 * transport. R4, R5 and R6 are properties of the pieces together, so they are tested together: a signal, a
 * drop and a gap only exist once the lifecycle, the stream and the gap ledger hand facts to one another.
 */

export interface InstallationOptions {
	/** Outcomes queued for the fake client's logins, in order. */
	readonly login?: readonly FakeLoginOutcome[];
	/** Outcomes queued for the fake client's session resumes, in order. */
	readonly resume?: readonly FakeResumeOutcome[];
	/** The Guilds the connection holds; defaults to exactly the configured one. */
	readonly heldGuildIds?: readonly string[];
	readonly backoff?: ReconnectBackoffSettings;
	readonly config?: DiscordConfig;
	/** Drain window of the shutdown path (R6); defaults to the feature's bounded window. */
	readonly drainWindowMs?: number;
}

export interface Installation {
	readonly connection: DiscordConnectionGateway;
	readonly stream: DiscordEventStreamGateway;
	readonly resync: DiscordResyncGateway;
	readonly intake: DiscordEventIntakeGateway;
	readonly shutdown: DiscordShutdownGateway;
	readonly factory: FakeDiscordGatewayClientFactory;
	readonly counters: DiscordTransportCounters;
	readonly gaps: DiscordDeclaredGaps;
	readonly logger: RecordingLogger;
	readonly clock: () => Date;
	readonly advance: (milliseconds: number) => void;
	readonly delays: number[];
	/** Every event the stream was handed, normalization output and signals alike, in publish order. */
	readonly published: () => readonly NormalizedDiscordEvent[];
	readonly kindsPublished: () => readonly DiscordEventKind[];
	/** Pushes one raw payload through the live client, exactly as the transport would. */
	readonly emitRaw: (eventName: string, payload: unknown) => void;
	readonly emitDisconnect: () => void;
	/** Publishes one normalized event straight onto the stream, bypassing normalization. */
	readonly deliver: (event: NormalizedDiscordEvent) => void;
}

const MESSAGE_CREATED_PAYLOAD = {
	id: "500",
	channel_id: "400",
	guild_id: GUILD_ID,
	author: { id: "300", username: "someone", bot: false },
	content: "hello there",
	timestamp: "2026-11-05T10:00:00.000Z",
	type: 0
};

/** Reconnect settings that keep a failed-attempt loop short enough to assert on without waiting. */
export const FAST_BACKOFF: ReconnectBackoffSettings = Object.freeze({
	baseDelayMs: 10,
	factor: 2,
	maxDelayMs: 40,
	unavailableAfterAttempts: 3
});

export function composeInstallation(options: InstallationOptions = {}): Installation {
	const config = options.config ?? fakeConfig({ guildId: GUILD_ID });
	const factory = new FakeDiscordGatewayClientFactory({ guildIds: options.heldGuildIds });
	for (const outcome of options.login ?? []) {
		factory.queueLogin(outcome);
	}

	for (const outcome of options.resume ?? []) {
		factory.queueResume(outcome);
	}

	const counters = new DiscordTransportCounters();
	const gaps = new DiscordDeclaredGaps();
	const logger = new RecordingLogger();
	const timing = fakeTimer();
	const published: NormalizedDiscordEvent[] = [];

	const stream = new DiscordEventStreamGateway({
		counters,
		logger,
		clock: timing.clock,
		wait: timing.wait,
		// Lazily bound: the stream and the signaling need each other, exactly as the composition root wires them.
		onDroppedDelivery: {
			declareDroppedDelivery: (drop) => resync.declareDroppedDelivery(drop)
		}
	});

	/** Records what reached the stream, then forwards it: the assertions read the publish order here. */
	const producer: DiscordEventProducer = {
		publish: (event) => {
			published.push(event);
			stream.publish(event);
		}
	};

	/**
	 * Explicitly annotated: the stream, the signaling and the lifecycle form a deliberate lazy cycle (each
	 * one hands the next to the composition root), and without a written type TypeScript's inference would
	 * stop at `any` on `resync`, `connection` and the status read below.
	 */
	const resync: DiscordResyncGateway = new DiscordResyncGateway({
		guildId: config.guildId,
		producer,
		ledger: stream,
		gaps,
		counters,
		connection: { read: (): DiscordConnectionSnapshot => connection.read() },
		logger,
		clock: timing.clock
	});

	const intake = new DiscordEventIntakeGateway({
		configuredGuildId: config.guildId,
		producer,
		counters,
		logger
	});

	const connection: DiscordConnectionGateway = new DiscordConnectionGateway({
		config,
		clientFactory: factory,
		onRawEvent: (event: RawDiscordEvent) => intake.handle(event),
		observer: resync,
		counters,
		gaps,
		logger,
		clock: timing.clock,
		wait: timing.wait,
		backoff: options.backoff ?? DEFAULT_RECONNECT_BACKOFF
	});

	const shutdown = new DiscordShutdownGateway({
		guildId: config.guildId,
		connection,
		stream,
		counters,
		logger,
		...(options.drainWindowMs === undefined ? {} : { drainWindowMs: options.drainWindowMs })
	});

	return {
		connection,
		stream,
		resync,
		intake,
		shutdown,
		factory,
		counters,
		gaps,
		logger,
		clock: timing.clock,
		advance: timing.advance,
		delays: timing.delays,
		published: () => published,
		kindsPublished: () => published.map((event) => event.kind),
		emitRaw: (eventName, payload) => factory.emitRaw(eventName, payload),
		emitDisconnect: () => factory.emitDisconnect({ cause: "network" }),
		deliver: (event) => stream.publish(event)
	};
}

/** A fixture message payload: content only ever lives here, never in a log line (R11). */
export function messageFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { ...MESSAGE_CREATED_PAYLOAD, ...overrides };
}
