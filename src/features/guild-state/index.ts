/**
 * The intentional public surface of the `guild-state` feature (docs/features/guild-state.md Contracts and
 * boundaries: "Its public surface is the intentional `index.ts` exports below, consumed by the authorization
 * and query features"; docs/architecture/structure.md).
 *
 * What is here is what another feature is allowed to ask for: the module and the tokens that compose it, the
 * six read use cases the Contracts section names, the event-subscription binding that is this feature's only
 * way in from the `discord` stream, and the vocabulary those signatures are written in.
 *
 * What is deliberately absent, and why:
 *
 * - **The `postgres-*` repositories, the `SqlExecutor` seam and every SQL string.** A consumer that could reach
 *   one could write past the rules that make a row mean something — the cascades, the bounded batches, the
 *   single-Guild index. Contracts says other features "never import this feature's repositories, SQL or tables",
 *   so no repository token is exported either: the only injected seams here are use cases and the binding.
 * - **The snapshot read model.** `PermissionSnapshotRepository` and `RegistryPermissionSnapshot` exist so the
 *   evaluation has exactly one consistent read; exporting them would invite a second, hand-assembled
 *   derivation of the same decision, which is the one thing a permission authority cannot survive (R12, R13).
 * - **The write commands and the bootstrap/resync machinery.** Registry state changes only from Discord events
 *   and REST reads (R13), and both paths already enter through the binding. A feature that could call
 *   `UpsertRoleCommand` directly could write the registry from outside the event stream, and a feature that
 *   could call the bootstrap command could spend the REST budget of the connection that owns it.
 * - **The gateway contract and the `discord` REST adapter.** The reads are this feature's implementation of
 *   R2, not a capability it offers.
 * - **Names, nicknames, message content, tokens.** Not types at all: the registry stores ids, and the command
 *   inputs that carry a name are reachable only from the binding (R14). `tests/features/guild-state/
 *   guild-state-public-surface.proof.test.ts` asserts this file stays as narrow as this comment claims.
 */

/* Composition: the module a composition root imports, and the tokens it resolves. */
export { GuildStateModule } from "./guild-state.module.js";
export type { GuildStateModuleSettings } from "./guild-state.module.js";
export {
	GUILD_STATE_CONFIG_TOKEN,
	GUILD_STATE_LOGGER_TOKEN,
	GUILD_STATE_EVENT_SUBSCRIPTION_TOKEN,
	GUILD_STATE_EVALUATE_EFFECTIVE_PERMISSIONS_QUERY_TOKEN,
	GUILD_STATE_GUILD_IDENTITY_QUERY_TOKEN,
	GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN,
	GUILD_STATE_INGESTIBILITY_GAINED_PORT_TOKEN,
	GUILD_STATE_MEMBERSHIP_STATUS_QUERY_TOKEN,
	GUILD_STATE_STATUS_QUERY_TOKEN,
	GUILD_STATE_USER_ACCESSIBLE_CHANNELS_QUERY_TOKEN
} from "./guild-state.tokens.js";

/*
 * The outbound port (S3): the composition binds a listener to it, and the registry calls it. It is exported
 * because the other side of the callback lives in another feature and only the composition may join the two;
 * a module that could not name the port would have to import ingestion, which is the one thing it must not do.
 */
export { ChannelsIngestibilityGainedPort } from "./gateways/channels-ingestibility-gained.port.js";
export type { ChannelsIngestibilityGained } from "./gateways/channels-ingestibility-gained.port.js";

/* The event-subscription binding: the only way normalized Discord events enter this feature (Contracts; R1). */
export {
	GuildStateEventSubscription,
	GUILD_STATE_BOUND_COMMANDS,
	GUILD_STATE_BOUND_EVENT_KINDS
} from "./gateways/guild-state-event-subscription.gateway.js";
export type {
	GuildStateBoundCommand,
	GuildStateCommandOutcome,
	GuildStateEventCommand,
	GuildStateEventDisposition,
	GuildStateEventIgnoredReason,
	GuildStateEventSubscriptionDeps,
	GuildStateEventSubscriptionReport
} from "./gateways/guild-state-event-subscription.gateway.js";

/* The public use cases (Contracts: "Public use cases … no transport or discord.js types"). */
export { EvaluateEffectivePermissionsQuery } from "./queries/evaluate-effective-permissions.query.js";
export type { EvaluateEffectivePermissionsInput } from "./queries/evaluate-effective-permissions.query.js";
export { GetGuildIdentityQuery } from "./queries/get-guild-identity.query.js";
export { GetMembershipStatusQuery } from "./queries/get-membership-status.query.js";
export type { GetMembershipStatusInput } from "./queries/get-membership-status.query.js";
export { GetGuildStateStatusQuery } from "./queries/get-guild-state-status.query.js";
export type {
	GuildStateBootstrapStatus,
	GuildStateGapStatus,
	GuildStateStatusResult
} from "./queries/get-guild-state-status.query.js";
export { ListIngestibleChannelsQuery } from "./queries/list-ingestible-channels.query.js";
export type {
	IngestibleChannelEntry,
	ListIngestibleChannelsInput,
	ListIngestibleChannelsResult
} from "./queries/list-ingestible-channels.query.js";
export { ListUserAccessibleChannelsQuery } from "./queries/list-user-accessible-channels.query.js";
export type {
	ListUserAccessibleChannelsInput,
	ListUserAccessibleChannelsResult,
	UserAccessibleChannelEntry
} from "./queries/list-user-accessible-channels.query.js";

/* The vocabulary those signatures are written in: ids, bitfields, statuses, reasons. Never a payload.
 * `channelType` on a list entry is `NormalizedChannelType`, which the `discord` feature exports: this file
 * does not re-export another feature's vocabulary, because a name reachable from two barrels is a name two
 * barrels can disagree about. */
export type { EvaluateEffectivePermissionsResult } from "./queries/evaluate-effective-permissions.query.js";
export type { GetGuildIdentityResult } from "./queries/get-guild-identity.query.js";
export type { GetMembershipStatusResult } from "./queries/get-membership-status.query.js";
export type { DiscordIdentifier } from "./models/domain/discord-identifier.js";
export type {
	EffectivePermissionDerivation,
	EffectivePermissionEmptyReason,
	EffectivePermissionSet
} from "./models/domain/effective-permission-rules.js";
export type { PermissionBitfield } from "./models/domain/permission-bitfield.js";
export type { RegistryGuild } from "./models/domain/registry-records.js";
export type { RegistryChannelType } from "./models/domain/channel-capability.js";
export type { DiscordPermission } from "./models/domain/discord-permissions.js";
export { DISCORD_PERMISSION_NAMES } from "./models/domain/discord-permissions.js";
export { GUILD_REGISTRY_STATUSES } from "./models/domain/resync-state.js";
export type { GuildRegistryStatus } from "./models/domain/resync-state.js";
export { GUILD_STATE_ANOMALY_REASONS, REGISTRY_GAP_KINDS, registryGapKey } from "./models/domain/resync-state.js";
export type { GuildStateAnomalyReason, RegistryGapKind, RegistryGapRecord } from "./models/domain/resync-state.js";
export { GUILD_BOOTSTRAP_PARTS } from "./models/domain/bootstrap-state.js";
export type { GuildBootstrapPart } from "./models/domain/bootstrap-state.js";

/* The errors a caller has to be able to tell apart from a deny (R13; the evaluation's own three cases). */
export {
	EffectivePermissionEvaluationError,
	InvalidDiscordIdentifierError,
	InvalidRegistryFieldValueError
} from "./models/domain/guild-state-registry.errors.js";
export { GuildBootstrapUnavailableError } from "./models/domain/bootstrap.errors.js";
