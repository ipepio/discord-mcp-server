import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { EnvSource } from "../../../shared/config/app-config.interface.js";
import {
	DISCORD_REQUIRED_INTENTS,
	type DiscordConfig,
	type DiscordIntentName
} from "../config/discord-config.interface.js";
import { loadDiscordConfig } from "../config/discord-config.validator.js";
import type {
	DiscordClosureReport,
	DiscordConnectedTransition,
	DiscordConnectionObserver,
	DiscordConnectionSnapshot
} from "../models/domain/discord-connection-status.js";
import { DiscordConnectionStatus } from "../models/domain/discord-connection-status.js";
import type { DiscordDeclaredGaps } from "../models/domain/discord-declared-gaps.js";
import type { DiscordTransportCounters } from "../models/domain/discord-transport-counters.js";
import type { DiscordClock, DiscordWait } from "../models/domain/discord-timing.js";
import type { ReconnectBackoffSettings } from "../models/domain/reconnect-backoff.js";
import {
	computeReconnectDelayMs,
	DEFAULT_RECONNECT_BACKOFF,
	isUnavailableAfter
} from "../models/domain/reconnect-backoff.js";
import { DiscordConnectionAlreadyOpenError, DiscordConnectionStateError } from "./discord-connection.errors.js";
import type {
	DiscordDisconnectNotice,
	DiscordGatewayClient,
	DiscordGatewayClientFactory,
	DiscordLoginRejectionCause,
	RawDiscordEvent
} from "./discord.gateway.interface.js";
import { DiscordLoginRejectedError } from "./discord.gateway.interface.js";

/**
 * Everything the lifecycle needs arrives through this seam: transports come from a client factory, so
 * a test injects a fake and asserts connection ownership without ever touching Discord (spec R1).
 */
export interface DiscordConnectionDependencies {
	readonly config: DiscordConfig;
	readonly clientFactory: DiscordGatewayClientFactory;
	/** Normalization and delivery of one raw payload; supplied by the event intake. */
	readonly onRawEvent: (event: RawDiscordEvent) => void;
	/** One call per transition into a usable connection; turns it into the resync signal (R5). */
	readonly observer: DiscordConnectionObserver;
	readonly counters: DiscordTransportCounters;
	readonly gaps: DiscordDeclaredGaps;
	readonly logger: AppLogger;
	readonly clock: DiscordClock;
	readonly wait: DiscordWait;
	readonly backoff: ReconnectBackoffSettings;
}

interface RejectionSummary {
	readonly cause: DiscordLoginRejectionCause;
	readonly intent?: DiscordIntentName;
}

/**
 * R1 — the single Gateway connection of this Installation: login, session resume and reconnect with
 * backoff, one connection only. The previous client is destroyed before any re-login, a rejected login
 * at startup is an explicit failure with no retry loop, and a connection that cannot be recovered is
 * reported `unavailable` while reconnects continue. No consumer opens a client of its own.
 */
export class DiscordConnectionGateway {
	private status: DiscordConnectionStatus = DiscordConnectionStatus.disconnected;
	private client: DiscordGatewayClient | undefined;
	private reconnectLoop: Promise<void> | undefined;
	private acceptingEvents = true;
	private epoch = 0;
	private attemptsInGap = 0;
	private lastConnectedInstant: Date | undefined;
	private lastDisconnectedInstant: Date | undefined;

	public constructor(private readonly deps: DiscordConnectionDependencies) {}

	/** Opens the connection. A rejected login throws: the process must not run a consumer after it. */
	public async start(): Promise<void> {
		if (this.client !== undefined) {
			throw new DiscordConnectionAlreadyOpenError(this.epoch);
		}

		if (!this.acceptingEvents) {
			throw new DiscordConnectionStateError("this Installation has stopped accepting inbound payloads");
		}

		this.status = DiscordConnectionStatus.connecting;
		this.deps.logger.info("Opening Discord Gateway connection", {
			guildId: this.deps.config.guildId,
			intentCount: this.deps.config.intents.length
		});

		const client = this.openClient();
		this.client = client;

		try {
			await client.login();
		} catch (error) {
			this.client = undefined;
			await this.destroyQuietly(client);
			this.status = DiscordConnectionStatus.unavailable;
			const rejection = describeRejection(error);
			this.deps.logger.error("Discord Gateway startup failed", {
				guildId: this.deps.config.guildId,
				cause: rejection.cause,
				...(rejection.intent === undefined ? {} : { intent: rejection.intent })
			});

			throw new DiscordLoginRejectedError({
				cause: rejection.cause,
				detail: describeError(error),
				...(rejection.intent === undefined ? {} : { intent: rejection.intent })
			});
		}

		this.markConnected();
	}

	public read(): DiscordConnectionSnapshot {
		return Object.freeze({
			status: this.status,
			epoch: this.epoch,
			reconnectAttempts: this.attemptsInGap,
			...(this.lastConnectedInstant === undefined ? {} : { lastConnectedInstant: this.lastConnectedInstant }),
			...(this.lastDisconnectedInstant === undefined
				? {}
				: { lastDisconnectedInstant: this.lastDisconnectedInstant })
		});
	}

	/**
	 * Awaits the in-flight reconnect loop. Deterministic tests and the shutdown path (R6) use it; it is
	 * a no-op when no loop is running.
	 */
	public async settle(): Promise<void> {
		while (this.reconnectLoop !== undefined) {
			await this.reconnectLoop;
		}
	}

	/**
	 * R6 step one: stop accepting inbound payloads. Anything the transport still hands in afterwards is
	 * declared as a gap by `receiveRaw` and never buffered, so a shutdown never keeps ingesting quietly.
	 */
	public stopAcceptingInbound(): void {
		this.acceptingEvents = false;
	}

	/**
	 * R6: closes the one connection this Installation owns and reports whether the client died cleanly. A
	 * client that refuses to close is logged and shutdown proceeds anyway — the next start's signal covers
	 * consumers either way, and a stuck socket never holds the process open.
	 */
	public async close(): Promise<DiscordClosureReport> {
		this.stopAcceptingInbound();
		const client = this.client;
		this.client = undefined;

		if (client === undefined) {
			this.status = DiscordConnectionStatus.disconnected;
			return { closed: true, destroyed: false };
		}

		try {
			await client.destroy();
		} catch (error) {
			this.status = DiscordConnectionStatus.disconnected;
			this.lastDisconnectedInstant = this.deps.clock();
			this.deps.logger.error("Discord connection did not close cleanly", {
				guildId: this.deps.config.guildId,
				reason: describeError(error)
			});

			return { closed: false, destroyed: true, reason: describeError(error) };
		}

		this.status = DiscordConnectionStatus.disconnected;
		this.lastDisconnectedInstant = this.deps.clock();

		return { closed: true, destroyed: true };
	}

	/**
	 * A transport-reported loss: one reconnect loop at a time, always on the client this Installation
	 * already owns. R1 forbids a second concurrent connection, so the loop resumes first and only a
	 * rejected resume replaces the client.
	 */
	public handleDisconnected(notice: DiscordDisconnectNotice): void {
		this.lastDisconnectedInstant = this.deps.clock();
		this.deps.logger.warn("Discord Gateway connection lost", {
			guildId: this.deps.config.guildId,
			cause: notice.cause,
			...(notice.detail === undefined ? {} : { detail: notice.detail })
		});

		if (!this.acceptingEvents || this.reconnectLoop !== undefined) {
			return;
		}

		this.status = DiscordConnectionStatus.connecting;
		this.reconnectLoop = this.runReconnectLoop().finally(() => {
			this.reconnectLoop = undefined;
		});
	}

	/** The transport hands every gateway dispatch here, connected state or not. */
	public receiveRaw(event: RawDiscordEvent): void {
		this.deps.counters.recordRawReceived();

		if (this.status !== DiscordConnectionStatus.connected) {
			// R2 error: while the connection is not usable the stream publishes nothing. The interval is
			// declared as a gap so the next connected transition resynchronizes it (R4, R5).
			this.deps.gaps.record({
				reason: "intake-stopped",
				affectedKinds: [],
				undeliveredCount: 1,
				declaredInstant: this.deps.clock()
			});
			return;
		}

		this.deps.onRawEvent(event);
	}

	private openClient(): DiscordGatewayClient {
		if (this.client !== undefined) {
			throw new DiscordConnectionStateError(
				`refused to open a second Gateway connection while epoch ${this.epoch} is live`
			);
		}

		return this.deps.clientFactory.create(
			{
				botToken: this.deps.config.botToken,
				guildId: this.deps.config.guildId,
				intents: this.deps.config.intents
			},
			{
				onRawEvent: (event) => this.receiveRaw(event),
				onDisconnected: (notice) => this.handleDisconnected(notice)
			}
		);
	}

	private async runReconnectLoop(): Promise<void> {
		while (this.acceptingEvents && this.status !== DiscordConnectionStatus.connected) {
			this.attemptsInGap += 1;
			this.deps.counters.recordReconnectAttempt();
			await this.deps.wait(computeReconnectDelayMs(this.attemptsInGap, this.deps.backoff));
			if (!this.acceptingEvents) {
				return;
			}

			if (await this.attemptRecovery()) {
				return;
			}

			if (isUnavailableAfter(this.attemptsInGap, this.deps.backoff)) {
				this.status = DiscordConnectionStatus.unavailable;
				this.deps.observer.onUnavailable(
					`${this.attemptsInGap} reconnect attempts have failed`,
					this.deps.clock()
				);
			}
		}
	}

	private async attemptRecovery(): Promise<boolean> {
		const client = this.client;
		if (client === undefined) {
			return this.identifyFresh();
		}

		try {
			await client.resumeSession();
		} catch (error) {
			this.deps.logger.warn("Discord session resume rejected; a fresh identify follows", {
				guildId: this.deps.config.guildId,
				attempt: this.attemptsInGap,
				reason: describeError(error)
			});

			// R1: the previous client is fully destroyed before any re-login is attempted.
			this.client = undefined;
			await client.destroy();
			if (!this.acceptingEvents) {
				return false;
			}

			return this.identifyFresh();
		}

		this.markConnected();
		return this.status === DiscordConnectionStatus.connected;
	}

	private async identifyFresh(): Promise<boolean> {
		let client: DiscordGatewayClient;
		try {
			client = this.openClient();
		} catch (error) {
			this.deps.logger.error("Discord reconnect could not create a client", { reason: describeError(error) });
			return false;
		}

		this.client = client;

		try {
			await client.login();
		} catch (error) {
			this.client = undefined;
			await this.destroyQuietly(client);
			this.deps.logger.error("Discord re-identify rejected; reconnects continue with backoff", {
				guildId: this.deps.config.guildId,
				cause: describeRejection(error).cause,
				attempt: this.attemptsInGap
			});
			return false;
		}

		this.markConnected();
		return this.status === DiscordConnectionStatus.connected;
	}

	/** A connection is usable only when it holds the configured Guild (R1 ownership, R2 filter). */
	private markConnected(): void {
		const client = this.client;
		if (client === undefined) {
			throw new DiscordConnectionStateError("a connected transition happened without a client");
		}

		// R6: a reconnect that lands after shutdown began opens no epoch and publishes no signal.
		if (!this.acceptingEvents) {
			this.deps.logger.warn("Discord connection regained after shutdown began; no epoch opened", {
				guildId: this.deps.config.guildId
			});
			return;
		}

		const at = this.deps.clock();
		const attempts = this.attemptsInGap;

		if (!client.readGuildIds().includes(this.deps.config.guildId)) {
			this.status = DiscordConnectionStatus.unavailable;
			this.deps.logger.error("Configured Discord Guild is absent from this connection", {
				guildId: this.deps.config.guildId,
				reconnectAttempts: attempts
			});
			this.deps.observer.onUnavailable(`Guild ${this.deps.config.guildId} is absent`, at);
			return;
		}

		this.epoch += 1;
		this.attemptsInGap = 0;
		this.lastConnectedInstant = at;
		this.status = DiscordConnectionStatus.connected;

		const transition: DiscordConnectedTransition = { epoch: this.epoch, reconnectAttempts: attempts, at };
		this.deps.observer.onConnected(transition);
	}

	/**
	 * Releases the client without letting a teardown failure mask the reason startup is failing. R1
	 * requires the previous client destroyed; a client that refuses to die is logged and left so.
	 */
	private async destroyQuietly(client: DiscordGatewayClient): Promise<void> {
		try {
			await client.destroy();
		} catch (error) {
			this.deps.logger.error("Discord client did not close cleanly", { reason: describeError(error) });
		}
	}
}

function describeRejection(error: unknown): RejectionSummary {
	if (error instanceof DiscordLoginRejectedError) {
		return {
			cause: error.rejectionCause,
			...(error.intent === undefined ? {} : { intent: error.intent })
		};
	}

	return { cause: "unknown" };
}

/** Error identity only: a transport message never reaches a log line as payload content (R11). */
function describeError(error: unknown): string {
	return error instanceof Error ? error.name : "unknown";
}

/** Everything the composition root supplies to build one Installation's connection. */
export interface DiscordConnectionAssembly {
	/** The startup environment: validation happens here, before any client exists (R9). */
	readonly env: EnvSource;
	readonly declaredIntents?: readonly string[];
	readonly clientFactory: DiscordGatewayClientFactory;
	readonly onRawEvent: (event: RawDiscordEvent) => void;
	readonly observer: DiscordConnectionObserver;
	readonly counters: DiscordTransportCounters;
	readonly gaps: DiscordDeclaredGaps;
	readonly logger: AppLogger;
	readonly clock: DiscordClock;
	readonly wait: DiscordWait;
	readonly backoff?: ReconnectBackoffSettings;
}

/**
 * Builds the connection from validated configuration only: a missing or malformed item throws here,
 * so a broken deployment never reaches the transport and never opens a socket (R9). The returned
 * lifecycle still has to be started explicitly.
 */
export function createDiscordConnection(assembly: DiscordConnectionAssembly): DiscordConnectionGateway {
	const config: DiscordConfig = loadDiscordConfig(assembly.env, assembly.declaredIntents ?? DISCORD_REQUIRED_INTENTS);

	return new DiscordConnectionGateway({
		config,
		clientFactory: assembly.clientFactory,
		onRawEvent: assembly.onRawEvent,
		observer: assembly.observer,
		counters: assembly.counters,
		gaps: assembly.gaps,
		logger: assembly.logger,
		clock: assembly.clock,
		wait: assembly.wait,
		backoff: assembly.backoff ?? DEFAULT_RECONNECT_BACKOFF
	});
}
