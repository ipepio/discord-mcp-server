import type { ChannelPermissionOverwrite } from "../../discord/index.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import type {
	RegistryBatchWriteResult,
	RegistryChannel,
	RegistryChannelOverwriteSet,
	RegistryChannelRemovalResult,
	RegistryOverwriteReplacementResult
} from "../models/domain/registry-records.js";

/**
 * The single channel/thread registry and its overwrite sets (docs/features/guild-state.md R6, R7;
 * Contracts: "batch upsert channels/threads", "delete a channel and its dependents", "replace a channel's
 * overwrite set", "a channel's overwrite set" read).
 *
 * Channel and thread are one registry: permission evaluation for a thread needs its parent, and a thread
 * is a channel with a parent. The registry rejects a thread row with no parent (R6) rather than storing
 * one evaluation could never resolve.
 */
export interface ChannelRegistryRepository {
	/**
	 * Create or replace channel and thread rows in bounded batches, one transaction per batch, parents
	 * before their threads. A thread whose parent is not in the registry and not in the same batch is
	 * refused (R6).
	 */
	readonly upsertChannels: (channels: readonly RegistryChannel[]) => Promise<RegistryBatchWriteResult>;

	/**
	 * R6: remove the row with its overwrite rows, its private-thread membership edges and — for a parent
	 * channel — the thread rows under it, in one transaction. No tombstone: a later message id naming a
	 * removed channel is an ingestion "unknown channel" anomaly, which is ingestion's rule to report.
	 */
	readonly deleteChannelAndDependents: (
		guildId: DiscordIdentifier,
		channelId: DiscordIdentifier
	) => Promise<RegistryChannelRemovalResult>;

	/**
	 * R6: replace the whole overwrite set of one channel or thread in one transaction, so a grant that
	 * disappeared from Discord's payload cannot survive as a stale row. An empty set means the channel has
	 * no overwrites — the difference between "empty" and "never sent" belongs to the read boundary, which
	 * does not call this method for a payload that carried no list (docs/features/discord.md R3).
	 */
	readonly replaceChannelOverwrites: (
		overwrite: RegistryChannelOverwriteSet
	) => Promise<RegistryOverwriteReplacementResult>;

	/** Every stored channel and thread. Bounded by Discord's own per-Guild channel ceiling. */
	readonly findChannels: (guildId: DiscordIdentifier) => Promise<readonly RegistryChannel[]>;

	/** One channel or thread row — the parent resolution `GetEffectivePermissionsQuery` walks (R12). */
	readonly findChannel: (guildId: DiscordIdentifier, channelId: DiscordIdentifier) => Promise<RegistryChannel | null>;

	/** The stored overwrite set of one channel or thread, in Discord's own target vocabulary. */
	readonly findChannelOverwrites: (
		guildId: DiscordIdentifier,
		channelId: DiscordIdentifier
	) => Promise<readonly ChannelPermissionOverwrite[]>;
}
