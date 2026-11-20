import { Module } from "@nestjs/common";
import type { DynamicModule, ModuleMetadata } from "@nestjs/common";
import type { DiscordConfig, DiscordEventConsumer, DiscordGuildStateRestOperations } from "../discord/index.js";
import { DISCORD_CONFIG_TOKEN, DISCORD_EVENT_STREAM_TOKEN, DISCORD_REST_OPERATIONS_TOKEN } from "../discord/index.js";
import { ConfigModule } from "../../shared/config/config.module.js";
import { LoggingModule } from "../../shared/logging/logging.module.js";
import { APP_LOGGER_TOKEN } from "../../shared/logging/logging.tokens.js";
import type { AppLogger } from "../../shared/logging/logger.interface.js";
import { PersistenceModule } from "../../shared/persistence/persistence.module.js";
import { PG_POOL_TOKEN } from "../../shared/persistence/persistence.tokens.js";
import { InMemoryBootstrapStateTracker } from "./bootstrap/in-memory-bootstrap-state.js";
import { InMemoryGuildResyncLedger } from "./bootstrap/in-memory-resync-ledger.js";
import { ApplyGuildBootstrapCommand } from "./commands/apply-guild-bootstrap.command.js";
import { ApplyMemberUpdateCommand } from "./commands/apply-member-update.command.js";
import { ApplyThreadMembershipChangeCommand } from "./commands/apply-thread-membership-change.command.js";
import { DeleteChannelCommand } from "./commands/delete-channel.command.js";
import { DeleteRoleCommand } from "./commands/delete-role.command.js";
import { EndMembershipCommand } from "./commands/end-membership.command.js";
import { ResyncGuildStateCommand } from "./commands/resync-guild-state.command.js";
import { SweepVanishedStateCommand } from "./commands/sweep-vanished-state.command.js";
import { UpsertChannelCommand } from "./commands/upsert-channel.command.js";
import { UpsertRoleCommand } from "./commands/upsert-role.command.js";
import type { GuildStateConfig } from "./config/guild-state-config.interface.js";
import { createGuildStateConfig } from "./config/guild-state-config.interface.js";
import { DiscordGuildStateGateway } from "./gateways/discord-guild-state.gateway.js";
import { GuildStateEventSubscription } from "./gateways/guild-state-event-subscription.gateway.js";
import { ChannelsIngestibilityGainedPort } from "./gateways/channels-ingestibility-gained.port.js";
import type { GuildStateGateway } from "./gateways/guild-state-gateway.interface.js";
import type { GuildBootstrapStateTracker } from "./models/domain/bootstrap-state.js";
import type { GuildResyncStateLedger } from "./models/domain/resync-state.js";
import {
	GUILD_STATE_BOOTSTRAP_COMMAND_TOKEN,
	GUILD_STATE_BOOTSTRAP_STATE_TOKEN,
	GUILD_STATE_CHANNEL_DELETE_COMMAND_TOKEN,
	GUILD_STATE_CHANNEL_REGISTRY_TOKEN,
	GUILD_STATE_CHANNEL_UPSERT_COMMAND_TOKEN,
	GUILD_STATE_CONFIG_TOKEN,
	GUILD_STATE_EVALUATE_EFFECTIVE_PERMISSIONS_QUERY_TOKEN,
	GUILD_STATE_EVENT_SUBSCRIPTION_TOKEN,
	GUILD_STATE_GATEWAY_TOKEN,
	GUILD_STATE_GUILD_IDENTITY_QUERY_TOKEN,
	GUILD_STATE_GUILD_REGISTRY_TOKEN,
	GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN,
	GUILD_STATE_INGESTIBILITY_GAINED_PORT_TOKEN,
	GUILD_STATE_LOGGER_TOKEN,
	GUILD_STATE_MEMBERSHIP_REGISTRY_TOKEN,
	GUILD_STATE_MEMBERSHIP_STATUS_QUERY_TOKEN,
	GUILD_STATE_MEMBER_UPDATE_COMMAND_TOKEN,
	GUILD_STATE_MEMBERSHIP_END_COMMAND_TOKEN,
	GUILD_STATE_PERMISSION_SNAPSHOT_TOKEN,
	GUILD_STATE_ROLE_DELETE_COMMAND_TOKEN,
	GUILD_STATE_ROLE_REGISTRY_TOKEN,
	GUILD_STATE_ROLE_UPSERT_COMMAND_TOKEN,
	GUILD_STATE_RESYNC_COMMAND_TOKEN,
	GUILD_STATE_RESYNC_LEDGER_TOKEN,
	GUILD_STATE_SQL_EXECUTOR_TOKEN,
	GUILD_STATE_STATUS_QUERY_TOKEN,
	GUILD_STATE_THREAD_MEMBERSHIP_CHANGE_COMMAND_TOKEN,
	GUILD_STATE_THREAD_MEMBERSHIP_REGISTRY_TOKEN,
	GUILD_STATE_USER_ACCESSIBLE_CHANNELS_QUERY_TOKEN,
	GUILD_STATE_VANISHED_SWEEP_COMMAND_TOKEN
} from "./guild-state.tokens.js";
import type { ChannelRegistryRepository } from "./repositories/channel-registry.repository.js";
import type { GuildRegistryRepository } from "./repositories/guild-registry.repository.js";
import type { MembershipRegistryRepository } from "./repositories/membership-registry.repository.js";
import type { PermissionSnapshotRepository } from "./repositories/permission-snapshot.repository.js";
import { PostgresChannelRegistryRepository } from "./repositories/postgres-channel-registry.repository.js";
import { PostgresGuildRegistryRepository } from "./repositories/postgres-guild-registry.repository.js";
import { PostgresMembershipRegistryRepository } from "./repositories/postgres-membership-registry.repository.js";
import { PostgresPermissionSnapshotRepository } from "./repositories/postgres-permission-snapshot.repository.js";
import { PostgresRoleRegistryRepository } from "./repositories/postgres-role-registry.repository.js";
import { PostgresThreadMembershipRegistryRepository } from "./repositories/postgres-thread-membership-registry.repository.js";
import type { RoleRegistryRepository } from "./repositories/role-registry.repository.js";
import type { ThreadMembershipRegistryRepository } from "./repositories/thread-membership-registry.repository.js";
import type { SqlClientSource, SqlExecutor } from "./repositories/sql-executor.js";
import { createSqlExecutor } from "./repositories/sql-executor.js";
import { EvaluateEffectivePermissionsQuery } from "./queries/evaluate-effective-permissions.query.js";
import { GetGuildIdentityQuery } from "./queries/get-guild-identity.query.js";
import { GetGuildStateStatusQuery } from "./queries/get-guild-state-status.query.js";
import { GetMembershipStatusQuery } from "./queries/get-membership-status.query.js";
import { ListIngestibleChannelsQuery } from "./queries/list-ingestible-channels.query.js";
import { ListUserAccessibleChannelsQuery } from "./queries/list-user-accessible-channels.query.js";

/**
 * The permission-registry module (docs/features/guild-state.md Contracts: "Repository contracts … injected
 * via Nest modules and explicit tokens"; docs/architecture/features.md: a feature exposes capabilities
 * through providers, and the composition root wires tokens).
 *
 * Every provider below is a resolved instance behind a named token — no arrays of constructors, and no
 * consumer can reach a `postgres-*` class. The module does not start anything, and T9 kept that promise rather
 * than narrowing it: the event binding is *provided*, and nothing is subscribed until the composition root
 * calls `subscribe()`. Its trigger for R2's first read is the `discord` feature's own first `resync-needed`
 * signal (docs/features/discord.md R5), which arrives only once that feature has been started elsewhere — and
 * nothing here reaches the Gateway wire.
 *
 * `imports` must supply the `discord` feature's exported tokens, because the Guild this registry serves is
 * the Guild the connection serves (R1). Passing a different id here would be two sources of truth about one
 * Installation, so the value is read from `DISCORD_CONFIG_TOKEN` and validated once more on the way in.
 */

/** Overrides a composition or a harness needs; every default is the production adapter. */
export interface GuildStateModuleSettings {
	/** Modules providing `DISCORD_CONFIG_TOKEN` and `DISCORD_EVENT_STREAM_TOKEN` — normally `DiscordModule.forRoot(...)`. */
	readonly imports: NonNullable<ModuleMetadata["imports"]>;
	/**
	 * The bot's own Membership id, learned from the connection (docs/features/discord.md R5) and not from a new
	 * environment variable. Supplying it enables the channel-access trigger: the one channel event that turns the
	 * bot from "cannot view" into "can view" is then evaluated and reported through the outbound port below.
	 * Omitting it leaves the command as the plain registry write it was, which is what a harness wants.
	 */
	readonly botUserId?: string;
	/** Bounds for this Installation's bootstrap passes and write batches. */
	readonly bootstrap?: Partial<GuildStateConfig["bootstrap"]>;
	/** Defaults to `APP_LOGGER_TOKEN`, tagged with this feature. */
	readonly logger?: AppLogger;
}

@Module({ imports: [ConfigModule, LoggingModule, PersistenceModule] })
export class GuildStateModule {
	public static forRoot(settings: GuildStateModuleSettings): DynamicModule {
		const providers = [
			{
				provide: GUILD_STATE_CONFIG_TOKEN,
				useFactory: (discord: DiscordConfig): GuildStateConfig =>
					createGuildStateConfig({
						guildId: discord.guildId,
						// Only when the composition named bounds: an absent block must not become an explicit undefined.
						...(settings.bootstrap === undefined ? {} : { bootstrap: settings.bootstrap })
					}),
				inject: [DISCORD_CONFIG_TOKEN]
			},
			{
				provide: GUILD_STATE_LOGGER_TOKEN,
				useFactory: (logger: AppLogger): AppLogger =>
					settings.logger ?? logger.withContext({ feature: "guild-state" }),
				inject: [APP_LOGGER_TOKEN]
			},
			{
				provide: GUILD_STATE_SQL_EXECUTOR_TOKEN,
				// The managed pool from `shared/persistence` is the connection source. The token is the seam:
				// this feature never imports the driver, it consumes the driver-free contract (persistence.md),
				// and `createSqlExecutor` owns BEGIN/COMMIT/ROLLBACK/release so no repository has to.
				useFactory: (pool: SqlClientSource): SqlExecutor => createSqlExecutor(pool),
				inject: [PG_POOL_TOKEN]
			},
			{
				provide: GUILD_STATE_GUILD_REGISTRY_TOKEN,
				useFactory: (executor: SqlExecutor): GuildRegistryRepository =>
					new PostgresGuildRegistryRepository({ executor }),
				inject: [GUILD_STATE_SQL_EXECUTOR_TOKEN]
			},
			{
				provide: GUILD_STATE_ROLE_REGISTRY_TOKEN,
				useFactory: (executor: SqlExecutor, config: GuildStateConfig): RoleRegistryRepository =>
					new PostgresRoleRegistryRepository({ executor, writeBatchSize: config.bootstrap.writeBatchSize }),
				inject: [GUILD_STATE_SQL_EXECUTOR_TOKEN, GUILD_STATE_CONFIG_TOKEN]
			},
			{
				provide: GUILD_STATE_MEMBERSHIP_REGISTRY_TOKEN,
				useFactory: (executor: SqlExecutor, config: GuildStateConfig): MembershipRegistryRepository =>
					new PostgresMembershipRegistryRepository({
						executor,
						writeBatchSize: config.bootstrap.writeBatchSize
					}),
				inject: [GUILD_STATE_SQL_EXECUTOR_TOKEN, GUILD_STATE_CONFIG_TOKEN]
			},
			{
				provide: GUILD_STATE_CHANNEL_REGISTRY_TOKEN,
				useFactory: (executor: SqlExecutor, config: GuildStateConfig): ChannelRegistryRepository =>
					new PostgresChannelRegistryRepository({
						executor,
						writeBatchSize: config.bootstrap.writeBatchSize
					}),
				inject: [GUILD_STATE_SQL_EXECUTOR_TOKEN, GUILD_STATE_CONFIG_TOKEN]
			},
			{
				provide: GUILD_STATE_THREAD_MEMBERSHIP_REGISTRY_TOKEN,
				useFactory: (executor: SqlExecutor): ThreadMembershipRegistryRepository =>
					new PostgresThreadMembershipRegistryRepository({ executor }),
				inject: [GUILD_STATE_SQL_EXECUTOR_TOKEN]
			},
			{
				provide: GUILD_STATE_PERMISSION_SNAPSHOT_TOKEN,
				// The evaluation's only read (docs/features/guild-state.md Contracts: "one consistent snapshot"). It is
				// a separate adapter rather than a chain of the T1 projections because six point reads on the pool are
				// six snapshots: a role updated between two of them would be combined with overwrite rows from before
				// it, and the mixed answer would be logged as a decision. Read-only by contract (R13).
				useFactory: (executor: SqlExecutor): PermissionSnapshotRepository =>
					new PostgresPermissionSnapshotRepository({ executor }),
				inject: [GUILD_STATE_SQL_EXECUTOR_TOKEN]
			},
			{
				provide: GUILD_STATE_GATEWAY_TOKEN,
				// The contract is guild-state's; the instance is the `discord` feature's REST adapter, injected through
				// the token that feature exports and satisfying this contract structurally. No discord.js type and no
				// discord.js call site reaches a guild-state use case (spec Contracts; docs/architecture/structure.md).
				useFactory: (rest: DiscordGuildStateRestOperations): GuildStateGateway =>
					new DiscordGuildStateGateway({ rest }),
				inject: [DISCORD_REST_OPERATIONS_TOKEN]
			},
			{
				provide: GUILD_STATE_BOOTSTRAP_STATE_TOKEN,
				// One tracker per process, which is the whole of R2's completion bookkeeping in v1: a restart leaves
				// every part pending and the next pass re-applies idempotent writes (R9) until it is genuinely complete.
				useFactory: (config: GuildStateConfig): GuildBootstrapStateTracker =>
					new InMemoryBootstrapStateTracker({ guildId: config.guildId }),
				inject: [GUILD_STATE_CONFIG_TOKEN]
			},
			{
				provide: GUILD_STATE_BOOTSTRAP_COMMAND_TOKEN,
				// Resolved instance, not a constructor array (docs/architecture/shared.md). Nothing is started here:
				// deciding when a bootstrap runs and on what trigger is the composition's call, not the module's.
				useFactory: (
					config: GuildStateConfig,
					gateway: GuildStateGateway,
					tracker: GuildBootstrapStateTracker,
					guildRegistry: GuildRegistryRepository,
					roleRegistry: RoleRegistryRepository,
					channelRegistry: ChannelRegistryRepository,
					membershipRegistry: MembershipRegistryRepository,
					threadMembershipRegistry: ThreadMembershipRegistryRepository,
					logger: AppLogger
				): ApplyGuildBootstrapCommand =>
					new ApplyGuildBootstrapCommand({
						config,
						gateway,
						tracker,
						guildRegistry,
						roleRegistry,
						channelRegistry,
						membershipRegistry,
						threadMembershipRegistry,
						logger
					}),
				inject: [
					GUILD_STATE_CONFIG_TOKEN,
					GUILD_STATE_GATEWAY_TOKEN,
					GUILD_STATE_BOOTSTRAP_STATE_TOKEN,
					GUILD_STATE_GUILD_REGISTRY_TOKEN,
					GUILD_STATE_ROLE_REGISTRY_TOKEN,
					GUILD_STATE_CHANNEL_REGISTRY_TOKEN,
					GUILD_STATE_MEMBERSHIP_REGISTRY_TOKEN,
					GUILD_STATE_THREAD_MEMBERSHIP_REGISTRY_TOKEN,
					GUILD_STATE_LOGGER_TOKEN
				]
			},
			{
				provide: GUILD_STATE_RESYNC_LEDGER_TOKEN,
				// The resync half of the same T2 decision: in memory, per process. A restart begins with nothing in
				// flight and nothing open, and the first resync-needed signal re-converges the registry (R5 + R11).
				useFactory: (config: GuildStateConfig): GuildResyncStateLedger =>
					new InMemoryGuildResyncLedger({ guildId: config.guildId }),
				inject: [GUILD_STATE_CONFIG_TOKEN]
			},
			{
				provide: GUILD_STATE_RESYNC_COMMAND_TOKEN,
				// R11 converges through R2's path, so the bootstrap command is a dependency of this one and is never
				// duplicated; the role command plays the same part for a completed role description (R3).
				useFactory: (
					config: GuildStateConfig,
					gateway: GuildStateGateway,
					tracker: GuildBootstrapStateTracker,
					ledger: GuildResyncStateLedger,
					bootstrapCommand: ApplyGuildBootstrapCommand,
					upsertRoleCommand: UpsertRoleCommand,
					sweepCommand: SweepVanishedStateCommand,
					roleRegistry: RoleRegistryRepository,
					channelRegistry: ChannelRegistryRepository,
					logger: AppLogger
				): ResyncGuildStateCommand =>
					new ResyncGuildStateCommand({
						config,
						gateway,
						tracker,
						ledger,
						bootstrapCommand,
						upsertRoleCommand,
						sweepCommand,
						roleRegistry,
						channelRegistry,
						logger
					}),
				inject: [
					GUILD_STATE_CONFIG_TOKEN,
					GUILD_STATE_GATEWAY_TOKEN,
					GUILD_STATE_BOOTSTRAP_STATE_TOKEN,
					GUILD_STATE_RESYNC_LEDGER_TOKEN,
					GUILD_STATE_BOOTSTRAP_COMMAND_TOKEN,
					GUILD_STATE_ROLE_UPSERT_COMMAND_TOKEN,
					GUILD_STATE_VANISHED_SWEEP_COMMAND_TOKEN,
					GUILD_STATE_ROLE_REGISTRY_TOKEN,
					GUILD_STATE_CHANNEL_REGISTRY_TOKEN,
					GUILD_STATE_LOGGER_TOKEN
				]
			},
			{
				provide: GUILD_STATE_VANISHED_SWEEP_COMMAND_TOKEN,
				// R11's remove-half of convergence. It reuses the two delete commands rather than writing a cascade of
				// its own, so a swept role and a swept channel lose exactly what the event path makes them lose (R3, R6).
				useFactory: (
					config: GuildStateConfig,
					membershipRegistry: MembershipRegistryRepository,
					roleRegistry: RoleRegistryRepository,
					channelRegistry: ChannelRegistryRepository,
					deleteRoleCommand: DeleteRoleCommand,
					deleteChannelCommand: DeleteChannelCommand,
					logger: AppLogger
				): SweepVanishedStateCommand =>
					new SweepVanishedStateCommand({
						config,
						membershipRegistry,
						roleRegistry,
						channelRegistry,
						deleteRoleCommand,
						deleteChannelCommand,
						logger
					}),
				inject: [
					GUILD_STATE_CONFIG_TOKEN,
					GUILD_STATE_MEMBERSHIP_REGISTRY_TOKEN,
					GUILD_STATE_ROLE_REGISTRY_TOKEN,
					GUILD_STATE_CHANNEL_REGISTRY_TOKEN,
					GUILD_STATE_ROLE_DELETE_COMMAND_TOKEN,
					GUILD_STATE_CHANNEL_DELETE_COMMAND_TOKEN,
					GUILD_STATE_LOGGER_TOKEN
				]
			},
			{
				provide: GUILD_STATE_ROLE_UPSERT_COMMAND_TOKEN,
				// The four event-application use cases below are pure `execute(event)` units: the subscription
				// binding that maps a normalized kind onto each one is T9's wiring, not a dependency here
				// (docs/features/guild-state.md Contracts: "use cases see normalized application events").
				useFactory: (
					config: GuildStateConfig,
					roleRegistry: RoleRegistryRepository,
					logger: AppLogger
				): UpsertRoleCommand => new UpsertRoleCommand({ config, roleRegistry, logger }),
				inject: [GUILD_STATE_CONFIG_TOKEN, GUILD_STATE_ROLE_REGISTRY_TOKEN, GUILD_STATE_LOGGER_TOKEN]
			},
			{
				provide: GUILD_STATE_ROLE_DELETE_COMMAND_TOKEN,
				// The cascade is the repository's single transaction; this command issues it once per event (R3).
				useFactory: (
					config: GuildStateConfig,
					roleRegistry: RoleRegistryRepository,
					logger: AppLogger
				): DeleteRoleCommand => new DeleteRoleCommand({ config, roleRegistry, logger }),
				inject: [GUILD_STATE_CONFIG_TOKEN, GUILD_STATE_ROLE_REGISTRY_TOKEN, GUILD_STATE_LOGGER_TOKEN]
			},
			{
				provide: GUILD_STATE_MEMBER_UPDATE_COMMAND_TOKEN,
				// The role registry is injected here on purpose: a member set is bounded by the role rows the
				// foreign key can resolve, so the command has to ask which ids exist before it replaces the set.
				useFactory: (
					config: GuildStateConfig,
					roleRegistry: RoleRegistryRepository,
					membershipRegistry: MembershipRegistryRepository,
					logger: AppLogger
				): ApplyMemberUpdateCommand =>
					new ApplyMemberUpdateCommand({ config, roleRegistry, membershipRegistry, logger }),
				inject: [
					GUILD_STATE_CONFIG_TOKEN,
					GUILD_STATE_ROLE_REGISTRY_TOKEN,
					GUILD_STATE_MEMBERSHIP_REGISTRY_TOKEN,
					GUILD_STATE_LOGGER_TOKEN
				]
			},
			{
				provide: GUILD_STATE_MEMBERSHIP_END_COMMAND_TOKEN,
				useFactory: (
					config: GuildStateConfig,
					membershipRegistry: MembershipRegistryRepository,
					logger: AppLogger
				): EndMembershipCommand => new EndMembershipCommand({ config, membershipRegistry, logger }),
				inject: [GUILD_STATE_CONFIG_TOKEN, GUILD_STATE_MEMBERSHIP_REGISTRY_TOKEN, GUILD_STATE_LOGGER_TOKEN]
			},
			{
				provide: GUILD_STATE_INGESTIBILITY_GAINED_PORT_TOKEN,
				// The outbound port, provided as an instance so the composition can bind its listener to it (S3). It
				// starts bound to nothing: an unbound port reports nothing rather than failing a channel event, and the
				// application lifecycle is what connects it to ingestion's one-channel backfill.
				useFactory: (): ChannelsIngestibilityGainedPort => new ChannelsIngestibilityGainedPort(),
				inject: []
			},
			{
				provide: GUILD_STATE_CHANNEL_UPSERT_COMMAND_TOKEN,
				// Channels and threads are one registry, so one use case serves both normalized kinds; which of
				// them is a thread is derived from the channel type, never declared by the caller (R6). The snapshot
				// read and the port are what let the same use case answer S1's question from the state its own write
				// left behind, and both are injected unconditionally: only `botUserId` decides whether the trigger runs.
				useFactory: (
					config: GuildStateConfig,
					channelRegistry: ChannelRegistryRepository,
					snapshot: PermissionSnapshotRepository,
					channelsIngestibilityGained: ChannelsIngestibilityGainedPort,
					logger: AppLogger
				): UpsertChannelCommand =>
					new UpsertChannelCommand({
						config,
						channelRegistry,
						logger,
						...(settings.botUserId === undefined
							? {}
							: {
									accessTrigger: {
										botUserId: settings.botUserId,
										snapshot,
										channelsIngestibilityGained
									}
								})
					}),
				inject: [
					GUILD_STATE_CONFIG_TOKEN,
					GUILD_STATE_CHANNEL_REGISTRY_TOKEN,
					GUILD_STATE_PERMISSION_SNAPSHOT_TOKEN,
					GUILD_STATE_INGESTIBILITY_GAINED_PORT_TOKEN,
					GUILD_STATE_LOGGER_TOKEN
				]
			},
			{
				provide: GUILD_STATE_CHANNEL_DELETE_COMMAND_TOKEN,
				// The overwrite and thread-membership cascade is the repository's single transaction; this command
				// issues it once per event (R6).
				useFactory: (
					config: GuildStateConfig,
					channelRegistry: ChannelRegistryRepository,
					logger: AppLogger
				): DeleteChannelCommand => new DeleteChannelCommand({ config, channelRegistry, logger }),
				inject: [GUILD_STATE_CONFIG_TOKEN, GUILD_STATE_CHANNEL_REGISTRY_TOKEN, GUILD_STATE_LOGGER_TOKEN]
			},
			{
				provide: GUILD_STATE_THREAD_MEMBERSHIP_CHANGE_COMMAND_TOKEN,
				// The channel registry is injected here on purpose: R8's error case is decided by whether the
				// registry holds a thread row for the id the event named, so the deferral cannot be left to the
				// foreign key to discover mid-write.
				useFactory: (
					config: GuildStateConfig,
					channelRegistry: ChannelRegistryRepository,
					threadMembershipRegistry: ThreadMembershipRegistryRepository,
					logger: AppLogger
				): ApplyThreadMembershipChangeCommand =>
					new ApplyThreadMembershipChangeCommand({
						config,
						channelRegistry,
						threadMembershipRegistry,
						logger
					}),
				inject: [
					GUILD_STATE_CONFIG_TOKEN,
					GUILD_STATE_CHANNEL_REGISTRY_TOKEN,
					GUILD_STATE_THREAD_MEMBERSHIP_REGISTRY_TOKEN,
					GUILD_STATE_LOGGER_TOKEN
				]
			},
			{
				provide: GUILD_STATE_EVALUATE_EFFECTIVE_PERMISSIONS_QUERY_TOKEN,
				// The feature's public security contract. Its only dependency is the snapshot read, so no caller can
				// reach a write, a REST call or a resync through it (R13, R12).
				useFactory: (
					config: GuildStateConfig,
					snapshot: PermissionSnapshotRepository,
					logger: AppLogger
				): EvaluateEffectivePermissionsQuery =>
					new EvaluateEffectivePermissionsQuery({ config, snapshot, logger }),
				inject: [GUILD_STATE_CONFIG_TOKEN, GUILD_STATE_PERMISSION_SNAPSHOT_TOKEN, GUILD_STATE_LOGGER_TOKEN]
			},
			{
				provide: GUILD_STATE_GUILD_IDENTITY_QUERY_TOKEN,
				useFactory: (
					config: GuildStateConfig,
					guildRegistry: GuildRegistryRepository,
					logger: AppLogger
				): GetGuildIdentityQuery => new GetGuildIdentityQuery({ config, guildRegistry, logger }),
				inject: [GUILD_STATE_CONFIG_TOKEN, GUILD_STATE_GUILD_REGISTRY_TOKEN, GUILD_STATE_LOGGER_TOKEN]
			},
			{
				provide: GUILD_STATE_MEMBERSHIP_STATUS_QUERY_TOKEN,
				useFactory: (
					config: GuildStateConfig,
					membershipRegistry: MembershipRegistryRepository,
					logger: AppLogger
				): GetMembershipStatusQuery => new GetMembershipStatusQuery({ config, membershipRegistry, logger }),
				inject: [GUILD_STATE_CONFIG_TOKEN, GUILD_STATE_MEMBERSHIP_REGISTRY_TOKEN, GUILD_STATE_LOGGER_TOKEN]
			},
			{
				provide: GUILD_STATE_USER_ACCESSIBLE_CHANNELS_QUERY_TOKEN,
				// The two list queries take the wide snapshot form (`channelId: null`), which is what makes each of
				// them one bounded pass instead of a per-channel round trip (spec Contracts).
				useFactory: (
					config: GuildStateConfig,
					snapshot: PermissionSnapshotRepository,
					logger: AppLogger
				): ListUserAccessibleChannelsQuery => new ListUserAccessibleChannelsQuery({ config, snapshot, logger }),
				inject: [GUILD_STATE_CONFIG_TOKEN, GUILD_STATE_PERMISSION_SNAPSHOT_TOKEN, GUILD_STATE_LOGGER_TOKEN]
			},
			{
				provide: GUILD_STATE_STATUS_QUERY_TOKEN,
				// The status is derived from the tracker and the ledger on every call: no stored status column, no
				// clock, no TTL — which is R12's "applied state is authoritative immediately" (R2, R11; Contracts).
				useFactory: (
					config: GuildStateConfig,
					tracker: GuildBootstrapStateTracker,
					ledger: GuildResyncStateLedger,
					guildRegistry: GuildRegistryRepository,
					logger: AppLogger
				): GetGuildStateStatusQuery =>
					new GetGuildStateStatusQuery({ config, tracker, ledger, guildRegistry, logger }),
				inject: [
					GUILD_STATE_CONFIG_TOKEN,
					GUILD_STATE_BOOTSTRAP_STATE_TOKEN,
					GUILD_STATE_RESYNC_LEDGER_TOKEN,
					GUILD_STATE_GUILD_REGISTRY_TOKEN,
					GUILD_STATE_LOGGER_TOKEN
				]
			},
			{
				provide: GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN,
				useFactory: (
					config: GuildStateConfig,
					snapshot: PermissionSnapshotRepository,
					logger: AppLogger
				): ListIngestibleChannelsQuery => new ListIngestibleChannelsQuery({ config, snapshot, logger }),
				inject: [GUILD_STATE_CONFIG_TOKEN, GUILD_STATE_PERMISSION_SNAPSHOT_TOKEN, GUILD_STATE_LOGGER_TOKEN]
			},
			{
				provide: GUILD_STATE_EVENT_SUBSCRIPTION_TOKEN,
				// The event-subscription binding (T9): it holds the commands, the configured Guild, the stream and the
				// ledger, and it starts nothing — the composition root calls `subscribe()` when it wants events applied
				// and `unsubscribe()` when it does not. The stream token is the `discord` feature's exported consumer,
				// so this feature never reaches the intake, the raw payload seam or the publish path.
				useFactory: (
					config: GuildStateConfig,
					logger: AppLogger,
					consumer: DiscordEventConsumer,
					ledger: GuildResyncStateLedger,
					guildRegistry: GuildRegistryRepository,
					upsertRole: UpsertRoleCommand,
					deleteRole: DeleteRoleCommand,
					applyMemberUpdate: ApplyMemberUpdateCommand,
					endMembership: EndMembershipCommand,
					upsertChannel: UpsertChannelCommand,
					deleteChannel: DeleteChannelCommand,
					applyThreadMembershipChange: ApplyThreadMembershipChangeCommand,
					resync: ResyncGuildStateCommand
				): GuildStateEventSubscription =>
					new GuildStateEventSubscription({
						config,
						logger,
						consumer,
						ledger,
						guildRegistry,
						upsertRole,
						deleteRole,
						applyMemberUpdate,
						endMembership,
						upsertChannel,
						deleteChannel,
						applyThreadMembershipChange,
						resync
					}),
				inject: [
					GUILD_STATE_CONFIG_TOKEN,
					GUILD_STATE_LOGGER_TOKEN,
					DISCORD_EVENT_STREAM_TOKEN,
					GUILD_STATE_RESYNC_LEDGER_TOKEN,
					GUILD_STATE_GUILD_REGISTRY_TOKEN,
					GUILD_STATE_ROLE_UPSERT_COMMAND_TOKEN,
					GUILD_STATE_ROLE_DELETE_COMMAND_TOKEN,
					GUILD_STATE_MEMBER_UPDATE_COMMAND_TOKEN,
					GUILD_STATE_MEMBERSHIP_END_COMMAND_TOKEN,
					GUILD_STATE_CHANNEL_UPSERT_COMMAND_TOKEN,
					GUILD_STATE_CHANNEL_DELETE_COMMAND_TOKEN,
					GUILD_STATE_THREAD_MEMBERSHIP_CHANGE_COMMAND_TOKEN,
					GUILD_STATE_RESYNC_COMMAND_TOKEN
				]
			}
		];

		return {
			module: GuildStateModule,
			imports: settings.imports,
			providers,
			exports: providers.map((provider) => provider.provide)
		};
	}
}
