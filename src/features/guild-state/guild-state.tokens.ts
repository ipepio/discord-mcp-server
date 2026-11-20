/**
 * Explicit DI tokens of the guild-state feature (docs/architecture/conventions.md: "Dependencies are wired
 * through explicit DI tokens"; docs/features/guild-state.md Contracts: "Repository contracts … injected via
 * Nest modules and explicit tokens"). A consumer injects a token together with the contract interface it
 * names, never a `postgres-*` class.
 */

/** `GuildStateConfig` — the configured Guild and the write bounds (R1, R9). */
export const GUILD_STATE_CONFIG_TOKEN = "GUILD_STATE_CONFIG_TOKEN";

/** The structured logger this feature writes with. Defaults to `APP_LOGGER_TOKEN`, tagged with the feature. */
export const GUILD_STATE_LOGGER_TOKEN = "GUILD_STATE_LOGGER_TOKEN";

/** `SqlExecutor` — the driver-free persistence seam the PostgreSQL repositories run their statements on. */
export const GUILD_STATE_SQL_EXECUTOR_TOKEN = "GUILD_STATE_SQL_EXECUTOR_TOKEN";

/** `GuildRegistryRepository` — the one Guild row (R1, R13). */
export const GUILD_STATE_GUILD_REGISTRY_TOKEN = "GUILD_STATE_GUILD_REGISTRY_TOKEN";

/** `RoleRegistryRepository` — roles, bitfields and the role removal cascade (R3, R10). */
export const GUILD_STATE_ROLE_REGISTRY_TOKEN = "GUILD_STATE_ROLE_REGISTRY_TOKEN";

/** `MembershipRegistryRepository` — membership identity and role sets (R4, R5). */
export const GUILD_STATE_MEMBERSHIP_REGISTRY_TOKEN = "GUILD_STATE_MEMBERSHIP_REGISTRY_TOKEN";

/** `ChannelRegistryRepository` — the channel/thread registry and overwrite sets (R6, R7). */
export const GUILD_STATE_CHANNEL_REGISTRY_TOKEN = "GUILD_STATE_CHANNEL_REGISTRY_TOKEN";

/** `ThreadMembershipRegistryRepository` — private-thread membership edges (R8). */
export const GUILD_STATE_THREAD_MEMBERSHIP_REGISTRY_TOKEN = "GUILD_STATE_THREAD_MEMBERSHIP_REGISTRY_TOKEN";

/**
 * `GuildStateGateway` — the guild-state-shaped REST reads this feature owns the contract for
 * (docs/features/guild-state.md Contracts: the reads "sit behind a narrow `GuildStateGateway` contract owned
 * here"), satisfied by the `discord` feature's adapter. R2's bootstrap source.
 */
export const GUILD_STATE_GATEWAY_TOKEN = "GUILD_STATE_GATEWAY_TOKEN";

/**
 * `GuildBootstrapStateTracker` — which bootstrap parts this process has applied (R2). In memory per process
 * by decision (odd/tasks/guild-state.md T2): the rows are resumable by R9 idempotency and every start
 * re-converges, so this is deliberately not a table. A durable implementation may replace it behind the same
 * token without a repository changing.
 */
export const GUILD_STATE_BOOTSTRAP_STATE_TOKEN = "GUILD_STATE_BOOTSTRAP_STATE_TOKEN";

/** `ApplyGuildBootstrapCommand` — one resumable REST bootstrap pass (R2). */
export const GUILD_STATE_BOOTSTRAP_COMMAND_TOKEN = "GUILD_STATE_BOOTSTRAP_COMMAND_TOKEN";

/**
 * `UpsertRoleCommand` — one role event applied to the role registry: wholesale replacement, `@everyone` stored
 * like any role, and an unknown id converged into a new row (R3, R9, R10).
 */
export const GUILD_STATE_ROLE_UPSERT_COMMAND_TOKEN = "GUILD_STATE_ROLE_UPSERT_COMMAND_TOKEN";

/** `DeleteRoleCommand` — one role deletion with its membership and overwrite cascade (R3, R9). */
export const GUILD_STATE_ROLE_DELETE_COMMAND_TOKEN = "GUILD_STATE_ROLE_DELETE_COMMAND_TOKEN";

/**
 * `ApplyMemberUpdateCommand` — a join or member update: the Membership row and the complete role set the payload
 * carried, replaced rather than merged (R4, R5).
 */
export const GUILD_STATE_MEMBER_UPDATE_COMMAND_TOKEN = "GUILD_STATE_MEMBER_UPDATE_COMMAND_TOKEN";

/** `EndMembershipCommand` — leave, kick or ban: the Membership and everything that depended on it (R4). */
export const GUILD_STATE_MEMBERSHIP_END_COMMAND_TOKEN = "GUILD_STATE_MEMBERSHIP_END_COMMAND_TOKEN";

/**
 * `UpsertChannelCommand` — one channel or thread create/update: the registry row, with the parent R6 makes
 * mandatory for a thread, and the overwrite set the payload reported (R6, R7).
 */
export const GUILD_STATE_CHANNEL_UPSERT_COMMAND_TOKEN = "GUILD_STATE_CHANNEL_UPSERT_COMMAND_TOKEN";

/** `DeleteChannelCommand` — one channel or thread deletion with its overwrite and thread-membership cascade (R6, R9). */
export const GUILD_STATE_CHANNEL_DELETE_COMMAND_TOKEN = "GUILD_STATE_CHANNEL_DELETE_COMMAND_TOKEN";

/**
 * `ApplyThreadMembershipChangeCommand` — one private-thread membership edge added or removed, deferred when the
 * thread is not in the registry (R8, R9).
 */
export const GUILD_STATE_THREAD_MEMBERSHIP_CHANGE_COMMAND_TOKEN = "GUILD_STATE_THREAD_MEMBERSHIP_CHANGE_COMMAND_TOKEN";

/**
 * `PermissionSnapshotRepository` — the one consistent-snapshot read the evaluation is built on
 * (docs/features/guild-state.md Contracts: "Evaluation reads its inputs in one consistent snapshot"; R12).
 * Read-only by construction: the contract has no write method (R13).
 */
export const GUILD_STATE_PERMISSION_SNAPSHOT_TOKEN = "GUILD_STATE_PERMISSION_SNAPSHOT_TOKEN";

/**
 * `EvaluateEffectivePermissionsQuery` — the feature's public security contract: the fixed five-stage
 * derivation over stored state, as an exact bitfield with named lookups (R12, R13; Contracts).
 */
export const GUILD_STATE_EVALUATE_EFFECTIVE_PERMISSIONS_QUERY_TOKEN =
	"GUILD_STATE_EVALUATE_EFFECTIVE_PERMISSIONS_QUERY_TOKEN";

/** `GetGuildIdentityQuery` — the Installation's Guild id and name, from the registry row (Contracts). */
export const GUILD_STATE_GUILD_IDENTITY_QUERY_TOKEN = "GUILD_STATE_GUILD_IDENTITY_QUERY_TOKEN";

/** `GetMembershipStatusQuery` — `present`/`absent` for one User in the configured Guild (Contracts; R4). */
export const GUILD_STATE_MEMBERSHIP_STATUS_QUERY_TOKEN = "GUILD_STATE_MEMBERSHIP_STATUS_QUERY_TOKEN";

/**
 * `ListUserAccessibleChannelsQuery` — the channels one User holds `VIEW_CHANNEL` on, computed in one bounded
 * pass over the registry snapshot (Contracts; query R2).
 */
export const GUILD_STATE_USER_ACCESSIBLE_CHANNELS_QUERY_TOKEN = "GUILD_STATE_USER_ACCESSIBLE_CHANNELS_QUERY_TOKEN";

/**
 * `GuildResyncStateLedger` — the resync half of the registry status: whether a resync is in flight, whether the
 * Guild was lost, which gaps remain open and how many anomalies each reason counts (R11, R2 status rules).
 * In memory per process, by the same decision as the bootstrap tracker (`odd/tasks/guild-state.md` T2).
 */
export const GUILD_STATE_RESYNC_LEDGER_TOKEN = "GUILD_STATE_RESYNC_LEDGER_TOKEN";

/**
 * `ResyncGuildStateCommand` — the post-reconnect / post-anomaly convergence: reset the tracker, re-run the
 * bootstrap path, sweep the state a complete read no longer reports, then complete the gaps the event path could
 * not (R11, with R2, R9, R10).
 */
export const GUILD_STATE_RESYNC_COMMAND_TOKEN = "GUILD_STATE_RESYNC_COMMAND_TOKEN";

/**
 * `SweepVanishedStateCommand` — R11's remove-half of convergence: the memberships, roles and channels the
 * registry still holds after a resync read that no longer names them, routed through the R3/R4/R6 cascades in
 * bounded batches, and never swept from a truncated roster. Only the resync command reaches it.
 */
export const GUILD_STATE_VANISHED_SWEEP_COMMAND_TOKEN = "GUILD_STATE_VANISHED_SWEEP_COMMAND_TOKEN";

/**
 * `GetGuildStateStatusQuery` — `current`/`incomplete`/`stale`/`unavailable`, derived from the bootstrap tracker
 * and the resync ledger, with the open gaps and the anomaly counts by reason (R2, R11; Contracts).
 */
export const GUILD_STATE_STATUS_QUERY_TOKEN = "GUILD_STATE_STATUS_QUERY_TOKEN";

/**
 * `ListIngestibleChannelsQuery` — the registry contract ingestion consumes: registered, text-capable channels
 * and threads the bot itself can view, with bot visibility and registry absence kept as distinct facts
 * (Contracts; ingestion R2).
 */
export const GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN = "GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN";

/**
 * `ChannelsIngestibilityGained` — the outbound port this feature calls when an applied channel event turned the
 * bot from "cannot view" into "can view" (`odd/tasks/ingestion-channel-access-trigger.md` S1, S3).
 *
 * It is the one dependency that points out of this feature, and it points at nothing in particular: a one-method
 * callback the composition satisfies with ingestion's one-channel backfill, bound and unbound by
 * `application-lifecycle.ts`. Nothing here imports the consumer, and the consumer never re-derives the
 * permission decision — which is the whole reason the fact crosses as a port instead of as an event.
 */
export const GUILD_STATE_INGESTIBILITY_GAINED_PORT_TOKEN = "GUILD_STATE_INGESTIBILITY_GAINED_PORT_TOKEN";

/**
 * `GuildStateEventSubscription` — the normalized-event binding (docs/features/guild-state.md Contracts:
 * "Event-stream subscription"), which maps each bound kind onto the command that owns it, asserts R1 at the
 * event edge, and hands `resync-needed` to {@link ResyncGuildStateCommand}. Resolution builds the binding; it
 * subscribes nothing until the composition root calls `subscribe()`.
 */
export const GUILD_STATE_EVENT_SUBSCRIPTION_TOKEN = "GUILD_STATE_EVENT_SUBSCRIPTION_TOKEN";
