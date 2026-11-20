import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { GuildStateConfig } from "../config/guild-state-config.interface.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import { isForeignGuildRecord } from "../models/domain/registry-rules.js";
import type { RegistryChannelRemovalResult } from "../models/domain/registry-records.js";
import type { ChannelRegistryRepository } from "../repositories/channel-registry.repository.js";

/**
 * `CHANNEL_DELETE` / `THREAD_DELETE` applied to the registry (docs/features/guild-state.md R6, R9, R14).
 *
 * One registry, one command: a thread deletion and a channel deletion are the same call, and the cascade is
 * the repository's — one transaction removing the overwrite rows of the channel and of every thread under it,
 * the private-thread membership edges of the same rows, the thread rows themselves, and the row named by the
 * event. This command issues that call exactly once per event; re-reading dependents to sweep them by hand
 * would spread the work over several transactions and lose the atomicity R6's "in one transaction" promises.
 *
 * The order is the fail-closed order: the grants are removed with the row that carried them, so there is no
 * window in which an overwrite or a thread-membership edge outlives its channel. Permission state keeps no
 * history (spec "Behavior"), so nothing here leaves a tombstone; a later message naming a removed channel is
 * ingestion's "unknown channel" anomaly, not this registry's memory.
 *
 * R9: deleting a channel the registry does not hold reports zero counts and is not an error — a duplicate
 * delivery, or a deletion a resync already converged, is expected.
 *
 * R14: Guild id, channel id, and the counts the database returned.
 *
 * No emission. R6's sentence about the structure-change event is satisfied by the `discord` feature's own
 * normalized stream, which already publishes `channel-deleted` and `thread-deleted` to every subscriber, and
 * ingestion consumes that stream rather than a registry-owned one (spec Contracts; ingestion R2). Emitting
 * again from here would give one change two sources of truth.
 */

/** One channel or thread deletion: the configured Guild and the row Discord named. */
export interface DeleteChannelEvent {
	readonly guildId: DiscordIdentifier;
	readonly channelId: DiscordIdentifier;
}

export type DeleteChannelOutcome =
	| ({
			readonly status: "applied";
			readonly guildId: DiscordIdentifier;
			readonly channelId: DiscordIdentifier;
	  } & RegistryChannelRemovalResult)
	| {
			readonly status: "dropped";
			readonly guildId: DiscordIdentifier;
			readonly channelId: DiscordIdentifier;
			readonly reason: "foreign-guild";
	  };

export interface DeleteChannelCommandDeps {
	readonly config: GuildStateConfig;
	readonly channelRegistry: ChannelRegistryRepository;
	readonly logger: AppLogger;
}

export class DeleteChannelCommand {
	private readonly guildId: DiscordIdentifier;

	private readonly channelRegistry: ChannelRegistryRepository;

	private readonly logger: AppLogger;

	public constructor(deps: DeleteChannelCommandDeps) {
		this.guildId = deps.config.guildId;
		this.channelRegistry = deps.channelRegistry;
		this.logger = deps.logger;
	}

	public readonly execute = async (event: DeleteChannelEvent): Promise<DeleteChannelOutcome> => {
		if (isForeignGuildRecord(event.guildId, this.guildId)) {
			this.logger.warn("guild-state dropped a channel deletion for another guild", {
				guildId: this.guildId,
				eventGuildId: event.guildId,
				channelId: event.channelId,
				operation: "delete-channel"
			});
			return { status: "dropped", guildId: this.guildId, channelId: event.channelId, reason: "foreign-guild" };
		}

		const channelId = requireDiscordIdentifier("channel.channel_id", event.channelId);
		const removed = await this.channelRegistry.deleteChannelAndDependents(this.guildId, channelId);

		this.logger.info("guild-state channel registry applied a channel deletion", {
			guildId: this.guildId,
			channelId,
			channelRemoved: removed.channelRemoved,
			childThreadsRemoved: removed.childThreadsRemoved,
			overwritesRemoved: removed.overwritesRemoved,
			threadMembershipsRemoved: removed.threadMembershipsRemoved
		});

		return { status: "applied", guildId: this.guildId, channelId, ...removed };
	};
}
