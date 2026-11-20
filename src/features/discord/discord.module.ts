import { Inject, Module } from "@nestjs/common";
import type { DynamicModule, OnModuleInit } from "@nestjs/common";
import type { AppConfig, EnvSource } from "../../shared/config/app-config.interface.js";
import { ConfigModule } from "../../shared/config/config.module.js";
import { APP_CONFIG_TOKEN } from "../../shared/config/config.tokens.js";
import { LoggingModule } from "../../shared/logging/logging.module.js";
import { APP_LOGGER_TOKEN } from "../../shared/logging/logging.tokens.js";
import type { AppLogger } from "../../shared/logging/logger.interface.js";
import type { DiscordConfig } from "./config/discord-config.interface.js";
import { DISCORD_REQUIRED_INTENTS } from "./config/discord-config.interface.js";
import { DISCORD_ENV_VARIABLES, loadDiscordConfig } from "./config/discord-config.validator.js";
import {
	DISCORD_CLOCK_TOKEN,
	DISCORD_CONFIG_TOKEN,
	DISCORD_CONNECTION_TOKEN,
	DISCORD_COUNTERS_TOKEN,
	DISCORD_EVENT_STREAM_TOKEN,
	DISCORD_GATEWAY_CLIENT_FACTORY_TOKEN,
	DISCORD_GAP_LEDGER_TOKEN,
	DISCORD_LOGGER_TOKEN,
	DISCORD_REST_OPERATIONS_TOKEN,
	DISCORD_REST_POLICY_TOKEN,
	DISCORD_REST_TRANSPORT_TOKEN,
	DISCORD_RESYNC_TOKEN,
	DISCORD_SHUTDOWN_TOKEN,
	DISCORD_STATUS_TOKEN,
	DISCORD_WAIT_TOKEN
} from "./discord.tokens.js";
import { DiscordConnectionGateway } from "./gateways/discord-connection.gateway.js";
import { DiscordEventIntakeGateway } from "./gateways/discord-event-intake.gateway.js";
import { DiscordEventStreamGateway } from "./gateways/discord-event-stream.gateway.js";
import { DiscordRestGateway } from "./gateways/discord-rest.gateway.js";
import type { DiscordRestTransport } from "./gateways/discord-rest.gateway.interface.js";
import { DiscordJsRestTransport } from "./gateways/discord-rest.transport.gateway.js";
import { DiscordResyncGateway } from "./gateways/discord-resync.gateway.js";
import { DiscordShutdownGateway } from "./gateways/discord-shutdown.gateway.js";
import { DiscordStatusGateway } from "./gateways/discord-status.gateway.js";
import { DiscordJsGatewayClientFactory } from "./gateways/discord.gateway.js";
import type { DiscordConnectionObserver } from "./models/domain/discord-connection-status.js";
import { DiscordDeclaredGaps } from "./models/domain/discord-declared-gaps.js";
import type { DiscordConnectedTransition } from "./models/domain/discord-connection-status.js";
import type {
	DiscordDeliveryDropDeclaration,
	DroppedDelivery
} from "./models/domain/discord-event-stream.interface.js";
import type { DiscordRestReadPolicy } from "./models/domain/discord-rest-policy.js";
import { DEFAULT_DISCORD_REST_READ_POLICY, validateRestReadPolicy } from "./models/domain/discord-rest-policy.js";
import { DiscordTransportCounters } from "./models/domain/discord-transport-counters.js";
import type { DiscordClock, DiscordWait } from "./models/domain/discord-timing.js";
import { systemClock, waitReal } from "./models/domain/discord-timing.js";
import type { ReconnectBackoffSettings } from "./models/domain/reconnect-backoff.js";
import { DEFAULT_RECONNECT_BACKOFF } from "./models/domain/reconnect-backoff.js";

/**
 * Module composition of the Discord transport feature (spec Contracts: "the Nest module provides resolved
 * instances with explicit tokens or factories, never arrays of constructors"). A consumer feature imports
 * `DiscordModule` and injects a token together with its own contract interface; it never imports an
 * adapter, a mapper or the discord.js usage behind them (structure.md).
 *
 * Two seams are bound in `onModuleInit` instead of at construction: the connection lifecycle needs the
 * resync signaling as its observer and the delivery stream needs it as the declaration path for a dropped
 * delivery, while the signaling needs both of them to publish and to read the ledger. The binders below
 * forward to whatever is bound, so the graph stays acyclic and no component reaches around the wire for a
 * concrete adapter. Neither a connection nor a delivery can exist before composition finished, so the
 * binding happens strictly before the first event does; using a binder too early is a wiring bug and throws.
 */

/** Internal: the intake adapter the connection hands raw payloads to. No consumer injects it. */
const DISCORD_INTAKE_TOKEN = "DISCORD_INTAKE_TOKEN";

/** Internal: late-bound forwarding of a dropped delivery to the resync signaling (R4, R5). */
const DISCORD_DROP_BINDER_TOKEN = "DISCORD_DROP_BINDER_TOKEN";

/** Internal: late-bound forwarding of a connected transition to the resync signaling (R5). */
const DISCORD_OBSERVER_BINDER_TOKEN = "DISCORD_OBSERVER_BINDER_TOKEN";

/** Forwards to whatever is bound later. Unbound use fails loudly rather than silently dropping a fact. */
abstract class Binder<T> {
	private bound: T | undefined;

	public bind(target: T): void {
		this.bound = target;
	}

	protected forwarded(): T {
		if (this.bound === undefined) {
			throw new Error("Discord module: a transport seam was used before composition finished");
		}

		return this.bound;
	}
}

class DropDeclarationBinder extends Binder<DiscordDeliveryDropDeclaration> implements DiscordDeliveryDropDeclaration {
	public readonly declareDroppedDelivery = (drop: DroppedDelivery): void => {
		this.forwarded().declareDroppedDelivery(drop);
	};
}

class ConnectionObserverBinder extends Binder<DiscordConnectionObserver> implements DiscordConnectionObserver {
	public readonly onConnected = (transition: DiscordConnectedTransition): void => {
		this.forwarded().onConnected(transition);
	};

	public readonly onUnavailable = (reason: string, at: Date): void => {
		this.forwarded().onUnavailable(reason, at);
	};
}

/** Where this Installation's configuration comes from: a parsed block, or the startup environment. */
export type DiscordModuleConfigSource =
	| {
			/** The `discord` section, parsed once at startup by `shared/config` (R9). */
			readonly config: DiscordConfig;
			readonly env?: never;
			readonly declaredIntents?: never;
	  }
	| {
			/** The startup environment, read by the composition root and parsed through the same validator. */
			readonly env: EnvSource;
			readonly declaredIntents?: readonly string[];
			readonly config?: never;
	  };

/** Seams a deployment or a composition test substitutes. Each default is the production adapter. */
export type DiscordModuleSettings = DiscordModuleConfigSource & {
	/** Defaults to the discord.js REST transport; a harness passes the fake REST layer here. */
	readonly restTransport?: DiscordRestTransport;
	/** Defaults to the discord.js Gateway client factory. */
	readonly clientFactory?: DiscordJsGatewayClientFactory;
	/** Defaults to `APP_LOGGER_TOKEN`, the shared structured logger, tagged with this feature. */
	readonly logger?: AppLogger;
	readonly clock?: DiscordClock;
	readonly wait?: DiscordWait;
	/** Defaults to the v1 bounds of R7, validated before any request can be made. */
	readonly restPolicy?: DiscordRestReadPolicy;
	/** Defaults to the bounded backoff R1 describes. */
	readonly reconnectBackoff?: ReconnectBackoffSettings;
};

@Module({ imports: [ConfigModule, LoggingModule] })
export class DiscordModule implements OnModuleInit {
	public constructor(
		@Inject(DISCORD_DROP_BINDER_TOKEN) private readonly drops: DropDeclarationBinder,
		@Inject(DISCORD_OBSERVER_BINDER_TOKEN) private readonly observers: ConnectionObserverBinder,
		@Inject(DISCORD_RESYNC_TOKEN) private readonly resync: DiscordResyncGateway
	) {}

	/** Binds the two forwarding seams to the signaling that owns them (R4, R5). */
	public onModuleInit(): void {
		this.drops.bind(this.resync);
		this.observers.bind(this.resync);
	}

	public static forRoot(settings: DiscordModuleSettings): DynamicModule {
		const policy = settings.restPolicy ?? DEFAULT_DISCORD_REST_READ_POLICY;
		// R7: a bound outside Discord's ceilings cannot be composed into a running application.
		validateRestReadPolicy(policy);

		return {
			module: DiscordModule,
			providers: [
				{
					provide: DISCORD_CONFIG_TOKEN,
					// One validator for both paths: a parsed block is re-validated through the same rules, so a
					// broken deployment throws here and never reaches the transport (R9).
					useFactory: (app: AppConfig): DiscordConfig =>
						settings.config ??
						loadDiscordConfig(
							settings.env ?? discordEnvFrom(appConfigDiscord(app)),
							settings.declaredIntents ?? DISCORD_REQUIRED_INTENTS
						),
					inject: [APP_CONFIG_TOKEN]
				},
				{
					provide: DISCORD_LOGGER_TOKEN,
					useFactory: (logger: AppLogger): AppLogger =>
						settings.logger ?? logger.withContext({ feature: "discord" }),
					inject: [APP_LOGGER_TOKEN]
				},
				{ provide: DISCORD_CLOCK_TOKEN, useValue: settings.clock ?? systemClock },
				{ provide: DISCORD_WAIT_TOKEN, useValue: settings.wait ?? waitReal },
				{ provide: DISCORD_COUNTERS_TOKEN, useFactory: () => new DiscordTransportCounters() },
				{ provide: DISCORD_GAP_LEDGER_TOKEN, useFactory: () => new DiscordDeclaredGaps() },
				{ provide: DISCORD_DROP_BINDER_TOKEN, useFactory: () => new DropDeclarationBinder() },
				{ provide: DISCORD_OBSERVER_BINDER_TOKEN, useFactory: () => new ConnectionObserverBinder() },
				{
					provide: DISCORD_GATEWAY_CLIENT_FACTORY_TOKEN,
					useFactory: () => settings.clientFactory ?? new DiscordJsGatewayClientFactory()
				},
				{
					provide: DISCORD_EVENT_STREAM_TOKEN,
					useFactory: (
						counters: DiscordTransportCounters,
						logger: AppLogger,
						clock: DiscordClock,
						wait: DiscordWait,
						drops: DropDeclarationBinder
					) => new DiscordEventStreamGateway({ counters, logger, clock, wait, onDroppedDelivery: drops }),
					inject: [
						DISCORD_COUNTERS_TOKEN,
						DISCORD_LOGGER_TOKEN,
						DISCORD_CLOCK_TOKEN,
						DISCORD_WAIT_TOKEN,
						DISCORD_DROP_BINDER_TOKEN
					]
				},
				{
					provide: DISCORD_INTAKE_TOKEN,
					useFactory: (
						config: DiscordConfig,
						stream: DiscordEventStreamGateway,
						counters: DiscordTransportCounters,
						logger: AppLogger
					) =>
						new DiscordEventIntakeGateway({
							configuredGuildId: config.guildId,
							producer: stream,
							counters,
							logger
						}),
					inject: [
						DISCORD_CONFIG_TOKEN,
						DISCORD_EVENT_STREAM_TOKEN,
						DISCORD_COUNTERS_TOKEN,
						DISCORD_LOGGER_TOKEN
					]
				},
				{
					provide: DISCORD_CONNECTION_TOKEN,
					useFactory: (
						config: DiscordConfig,
						clientFactory: DiscordJsGatewayClientFactory,
						intake: DiscordEventIntakeGateway,
						observer: ConnectionObserverBinder,
						counters: DiscordTransportCounters,
						gaps: DiscordDeclaredGaps,
						logger: AppLogger,
						clock: DiscordClock,
						wait: DiscordWait
					) =>
						new DiscordConnectionGateway({
							config,
							clientFactory,
							// R2, R3: every inbound payload goes through the source filter and normalization first.
							onRawEvent: (event) => intake.handle(event),
							observer,
							counters,
							gaps,
							logger,
							clock,
							wait,
							backoff: settings.reconnectBackoff ?? DEFAULT_RECONNECT_BACKOFF
						}),
					inject: [
						DISCORD_CONFIG_TOKEN,
						DISCORD_GATEWAY_CLIENT_FACTORY_TOKEN,
						DISCORD_INTAKE_TOKEN,
						DISCORD_OBSERVER_BINDER_TOKEN,
						DISCORD_COUNTERS_TOKEN,
						DISCORD_GAP_LEDGER_TOKEN,
						DISCORD_LOGGER_TOKEN,
						DISCORD_CLOCK_TOKEN,
						DISCORD_WAIT_TOKEN
					]
				},
				{
					provide: DISCORD_RESYNC_TOKEN,
					useFactory: (
						config: DiscordConfig,
						stream: DiscordEventStreamGateway,
						connection: DiscordConnectionGateway,
						counters: DiscordTransportCounters,
						gaps: DiscordDeclaredGaps,
						logger: AppLogger,
						clock: DiscordClock
					) =>
						new DiscordResyncGateway({
							guildId: config.guildId,
							producer: stream,
							ledger: stream,
							gaps,
							counters,
							// The signaling reads the connection's status and never drives it (R5).
							connection: { read: () => connection.read() },
							logger,
							clock
						}),
					inject: [
						DISCORD_CONFIG_TOKEN,
						DISCORD_EVENT_STREAM_TOKEN,
						DISCORD_CONNECTION_TOKEN,
						DISCORD_COUNTERS_TOKEN,
						DISCORD_GAP_LEDGER_TOKEN,
						DISCORD_LOGGER_TOKEN,
						DISCORD_CLOCK_TOKEN
					]
				},
				{
					provide: DISCORD_STATUS_TOKEN,
					useFactory: (
						connection: DiscordConnectionGateway,
						counters: DiscordTransportCounters,
						stream: DiscordEventStreamGateway,
						gaps: DiscordDeclaredGaps,
						clock: DiscordClock,
						logger: AppLogger
					) => new DiscordStatusGateway({ connection, counters, delivery: stream, gaps, clock, logger }),
					inject: [
						DISCORD_CONNECTION_TOKEN,
						DISCORD_COUNTERS_TOKEN,
						DISCORD_EVENT_STREAM_TOKEN,
						DISCORD_GAP_LEDGER_TOKEN,
						DISCORD_CLOCK_TOKEN,
						DISCORD_LOGGER_TOKEN
					]
				},
				{
					provide: DISCORD_SHUTDOWN_TOKEN,
					useFactory: (
						config: DiscordConfig,
						connection: DiscordConnectionGateway,
						stream: DiscordEventStreamGateway,
						counters: DiscordTransportCounters,
						logger: AppLogger
					) => new DiscordShutdownGateway({ guildId: config.guildId, connection, stream, counters, logger }),
					inject: [
						DISCORD_CONFIG_TOKEN,
						DISCORD_CONNECTION_TOKEN,
						DISCORD_EVENT_STREAM_TOKEN,
						DISCORD_COUNTERS_TOKEN,
						DISCORD_LOGGER_TOKEN
					]
				},
				{ provide: DISCORD_REST_POLICY_TOKEN, useValue: policy },
				{
					provide: DISCORD_REST_TRANSPORT_TOKEN,
					// The seam a harness replaces; the default is the only file that touches discord.js REST.
					useFactory: (config: DiscordConfig): DiscordRestTransport =>
						settings.restTransport ?? new DiscordJsRestTransport(config),
					inject: [DISCORD_CONFIG_TOKEN]
				},
				{
					provide: DISCORD_REST_OPERATIONS_TOKEN,
					useFactory: (
						transport: DiscordRestTransport,
						config: DiscordConfig,
						boundPolicy: DiscordRestReadPolicy,
						logger: AppLogger,
						clock: DiscordClock,
						wait: DiscordWait
					) =>
						new DiscordRestGateway({
							transport,
							guildId: config.guildId,
							policy: boundPolicy,
							logger,
							clock,
							wait
						}),
					inject: [
						DISCORD_REST_TRANSPORT_TOKEN,
						DISCORD_CONFIG_TOKEN,
						DISCORD_REST_POLICY_TOKEN,
						DISCORD_LOGGER_TOKEN,
						DISCORD_CLOCK_TOKEN,
						DISCORD_WAIT_TOKEN
					]
				}
			],
			// The intentional surface: contracts a consumer feature injects, and nothing else (R8).
			exports: [
				DISCORD_CONFIG_TOKEN,
				DISCORD_COUNTERS_TOKEN,
				DISCORD_EVENT_STREAM_TOKEN,
				DISCORD_CONNECTION_TOKEN,
				DISCORD_RESYNC_TOKEN,
				DISCORD_STATUS_TOKEN,
				DISCORD_SHUTDOWN_TOKEN,
				DISCORD_REST_OPERATIONS_TOKEN,
				DISCORD_REST_POLICY_TOKEN
			]
		};
	}
}

/**
 * `AppConfig` carries no `discord` section yet — adding one belongs to `shared/config`, outside this
 * feature's paths. Until it does, a composition root that has already parsed the block passes it through
 * `DiscordModuleSettings.config`; this reader is the forward-compatible path only.
 */
function appConfigDiscord(config: AppConfig): DiscordConfig | undefined {
	return (config as AppConfig & { readonly discord?: DiscordConfig }).discord;
}

/** Rebuilds the environment shape from an already-parsed block so one validator covers both paths. */
function discordEnvFrom(config: DiscordConfig | undefined): EnvSource {
	return {
		[DISCORD_ENV_VARIABLES.botToken]: config?.botToken,
		[DISCORD_ENV_VARIABLES.guildId]: config?.guildId
	};
}
