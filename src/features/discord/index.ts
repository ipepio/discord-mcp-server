/**
 * The intentional public surface of the `discord` feature (spec Contracts and boundaries; structure.md).
 * A consumer feature — `guild-state`, `ingestion` — imports exactly these names: the normalized event
 * kinds it subscribes to, the event-stream subscription contract, the connection-status and counter reads,
 * the REST operation contracts with their application-typed results, the configuration requirements this
 * feature declares, and the module plus its tokens.
 *
 * What is deliberately absent: the raw event seam, the discord.js client and REST transports, the mappers,
 * the intake, the delivery stream's publish path and any write of any kind. No consumer can pull a raw
 * payload, publish an event, inspect the client instance or reach a Discord write through this file — the
 * absence is the point, and a test asserts it (R8, R11).
 */

/* Composition: the one module a consuming feature imports, and the tokens it injects. */
export { resolveBotIdentity } from "./resolve-bot-identity.js";
export { DiscordModule } from "./discord.module.js";
export type { DiscordModuleConfigSource, DiscordModuleSettings } from "./discord.module.js";
export {
	DISCORD_CONFIG_TOKEN,
	DISCORD_CONNECTION_TOKEN,
	DISCORD_COUNTERS_TOKEN,
	DISCORD_EVENT_STREAM_TOKEN,
	DISCORD_GATEWAY_CLIENT_FACTORY_TOKEN,
	DISCORD_GAP_LEDGER_TOKEN,
	DISCORD_LOGGER_TOKEN,
	DISCORD_REST_OPERATIONS_TOKEN,
	DISCORD_REST_POLICY_TOKEN,
	DISCORD_RESYNC_TOKEN,
	DISCORD_SHUTDOWN_TOKEN,
	DISCORD_STATUS_TOKEN
} from "./discord.tokens.js";

/* Configuration requirements this Installation declares (R9). */
export type { DiscordConfig, DiscordIntentName } from "./config/discord-config.interface.js";
export { DISCORD_KNOWN_INTENTS, DISCORD_REQUIRED_INTENTS } from "./config/discord-config.interface.js";
export { DISCORD_ENV_VARIABLES, loadDiscordConfig, resolveDiscordIntents } from "./config/discord-config.validator.js";
export { DiscordIntentConfigurationError } from "./config/discord-config.errors.js";

/* The normalized event vocabulary (R3): kinds, and the application-typed payloads a handler receives. */
export { DiscordEventKind, DISCORD_EVENT_KINDS, isDiscordEventKind } from "./models/domain/discord-event-kind.enum.js";
export { describeEventIds } from "./models/domain/normalized-discord-event.js";
export type {
	ChannelCreatedEvent,
	ChannelDeletedEvent,
	ChannelPermissionOverwrite,
	ChannelUpdatedEvent,
	GuildUpdatedEvent,
	MemberAddedEvent,
	MemberRemovedEvent,
	MemberUpdatedEvent,
	MessageAttachmentMetadata,
	MessageBulkDeletedEvent,
	MessageCreatedEvent,
	MessageDeletedEvent,
	MessageUpdatedEvent,
	NormalizedDiscordEvent,
	NormalizedEventOf,
	NormalizedEventBase,
	NormalizedReplyReference,
	ResyncNeededEvent,
	RoleCreatedEvent,
	RoleDeletedEvent,
	RoleUpdatedEvent,
	ThreadCreatedEvent,
	ThreadDeletedEvent,
	ThreadMemberAddedEvent,
	ThreadMemberRemovedEvent,
	ThreadUpdatedEvent
} from "./models/domain/normalized-discord-event.js";
export type {
	NormalizedChannelType,
	NormalizedMessageType,
	NormalizedOverwriteTargetType
} from "./models/domain/discord-resource-types.js";

/* The delivery contract a consumer subscribes through (R4). Subscription only: no publish path. */
export type {
	DiscordEventConsumer,
	DiscordEventHandler,
	DiscordEventSubscription
} from "./models/domain/discord-event-stream.interface.js";

/* Connection status, counters and gaps — the observability read (R11). All in-process (R10). */
export type {
	DiscordClosureReport,
	DiscordConnectionLifecycle,
	DiscordConnectionSnapshot,
	DiscordConnectionStatusSource
} from "./models/domain/discord-connection-status.js";
export { DiscordConnectionStatus } from "./models/domain/discord-connection-status.js";
export type {
	DiscordDeliverySnapshot,
	DiscordFeatureStatus,
	DiscordStatusQuery
} from "./models/domain/discord-status.interface.js";
export type { DiscordTransportCounterSnapshot } from "./models/domain/discord-transport-counters.js";
export type { DeclaredGap, DeclaredGapReason, GapSummary } from "./models/domain/discord-declared-gaps.js";
export type { DiscordShutdownReport } from "./gateways/discord-shutdown.gateway.js";

/* The REST read contracts and their application-typed results (R7, R8). Reads only, by construction. */
export type {
	DiscordGuildStateRestOperations,
	DiscordMessageHistoryRestOperations,
	DiscordRestOperations,
	MemberRosterRead,
	MessageHistoryRead,
	ThreadMemberRead
} from "./models/domain/discord-rest-gateway.interface.js";
export type {
	DiscordChannelRecord,
	DiscordGuildSnapshot,
	DiscordMemberRecord,
	DiscordMemberRoster,
	DiscordMessageHistoryPage,
	DiscordMessageRecord,
	DiscordRoleRecord,
	DiscordThreadMemberPage,
	DiscordThreadMemberRecord,
	RosterTruncation
} from "./models/domain/discord-rest-results.js";
export { DiscordRestOperation } from "./models/domain/discord-rest-operation.enum.js";
export { DiscordRestFailureError } from "./gateways/discord-rest.errors.js";
export type { DiscordRestFailureDetails, DiscordRestFailureReason } from "./gateways/discord-rest.errors.js";
export type { DiscordRestReadPolicy, DiscordRestStatusClass } from "./models/domain/discord-rest-policy.js";
export {
	DEFAULT_DISCORD_REST_READ_POLICY,
	DISCORD_MEMBER_PAGE_SIZE_MAX,
	DISCORD_MESSAGE_PAGE_SIZE_MAX,
	DISCORD_THREAD_MEMBER_PAGE_SIZE_MAX,
	validateRestReadPolicy
} from "./models/domain/discord-rest-policy.js";
