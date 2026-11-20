/**
 * Explicit DI tokens of the Discord feature. The spec's composition note is precise about this: the Nest
 * module provides resolved instances through tokens or factories, never arrays of constructors, and a
 * consumer feature depends on a token plus its contract interface — never on this feature's adapter class.
 *
 * Each token below names the contract it resolves to, so the wiring reads as a list of promises rather
 * than as a graph of implementation details.
 */

/** `DiscordConfig` — validated once at composition; the token, Guild id and intent set (R9). */
export const DISCORD_CONFIG_TOKEN = "DISCORD_CONFIG_TOKEN";

/** The structured logger this Installation writes with. Defaults to `APP_LOGGER_TOKEN`. */
export const DISCORD_LOGGER_TOKEN = "DISCORD_LOGGER_TOKEN";

/** `DiscordTransportCounters` — the in-process counters of R11. Never persisted (R10). */
export const DISCORD_COUNTERS_TOKEN = "DISCORD_COUNTERS_TOKEN";

/** `DiscordDeclaredGaps` — the gap ledger behind `resync-needed` (R4, R5, R6). Never persisted (R10). */
export const DISCORD_GAP_LEDGER_TOKEN = "DISCORD_GAP_LEDGER_TOKEN";

/** `DiscordGatewayClientFactory` — the discord.js Gateway seam; the only transport seam a test replaces. */
export const DISCORD_GATEWAY_CLIENT_FACTORY_TOKEN = "DISCORD_GATEWAY_CLIENT_FACTORY_TOKEN";

/** `DiscordEventConsumer` and `DiscordEventProducer`: the normalized delivery stream (R3, R4). */
export const DISCORD_EVENT_STREAM_TOKEN = "DISCORD_EVENT_STREAM_TOKEN";

/** `DiscordConnectionLifecycle`: start the one connection and read its status (R1, R2, R11). */
export const DISCORD_CONNECTION_TOKEN = "DISCORD_CONNECTION_TOKEN";

/** `DiscordResyncGateway`: the connection observer that turns gaps into one signal per connect (R5). */
export const DISCORD_RESYNC_TOKEN = "DISCORD_RESYNC_TOKEN";

/** `DiscordStatusQuery`: the single status and counters read (R11). */
export const DISCORD_STATUS_TOKEN = "DISCORD_STATUS_TOKEN";

/** The clean-shutdown path (R6): drain, declare, close. Called by the application's shutdown hook. */
export const DISCORD_SHUTDOWN_TOKEN = "DISCORD_SHUTDOWN_TOKEN";

/** `DiscordRestTransport` — the read-only transport seam the discord.js REST client implements (R7, R8). */
export const DISCORD_REST_TRANSPORT_TOKEN = "DISCORD_REST_TRANSPORT_TOKEN";

/** `DiscordRestOperations` — the bounded, validated REST reads a consumer feature imports (R7, R8). */
export const DISCORD_REST_OPERATIONS_TOKEN = "DISCORD_REST_OPERATIONS_TOKEN";

/** The bounded-read policy the REST adapter runs with (R7). */
export const DISCORD_REST_POLICY_TOKEN = "DISCORD_REST_POLICY_TOKEN";

/** `DiscordClock` — the time source every instant in this feature comes from. Injectable in tests. */
export const DISCORD_CLOCK_TOKEN = "DISCORD_CLOCK_TOKEN";

/** `DiscordWait` — the pacing seam of reconnect backoff, the drain window and REST retries. */
export const DISCORD_WAIT_TOKEN = "DISCORD_WAIT_TOKEN";
