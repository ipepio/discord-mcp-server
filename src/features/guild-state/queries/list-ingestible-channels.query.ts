import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { GuildStateConfig } from "../config/guild-state-config.interface.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import type { RegistryChannelType } from "../models/domain/channel-capability.js";
import { channelRowIsTextCapable } from "../models/domain/channel-capability.js";
import type {
	EffectivePermissionEmptyReason,
	RegistryChannelDerivation
} from "../models/domain/effective-permission-rules.js";
import {
	distinctRefusalReasons,
	grantsViewChannel,
	scanEffectivePermissionsAcrossRegistry
} from "../models/domain/effective-permission-rules.js";
import { EffectivePermissionEvaluationError } from "../models/domain/guild-state-registry.errors.js";
import type { RegistryPermissionSnapshot } from "../models/domain/registry-records.js";
import { registryChannelIsThread } from "../models/domain/registry-rules.js";
import type { PermissionSnapshotRepository } from "../repositories/permission-snapshot.repository.js";

/**
 * The registry contract ingestion consumes (docs/features/guild-state.md Contracts: `ListIngestibleChannelsQuery`
 * — "registered, non-deleted, text-capable channels and threads the bot itself can view, computed with the same
 * evaluation applied to the bot's own Membership. Absence from the registry and lack of bot visibility are
 * reported as distinct facts rather than assumed to be the same thing"; ingestion R2).
 *
 * Three facts are kept separate, because collapsing any two of them is how a backfill quietly skips a channel:
 *
 * - **Registered and text-capable** — the rows the registry holds whose stored channel type can carry text
 *   (`models/domain/channel-capability.ts`). A deleted channel has no row at all, which is the spec's
 *   "non-deleted" half: R6's deletion removes the row, so nothing here filters a tombstone.
 * - **Bot can view** — the same five-stage derivation, run for the bot's own Membership, filtered on
 *   `view-channel`. The bot is a member like any other (R4), so there is no special-casing of its id.
 * - **Bot visibility is unknown** — reported as `botMembershipRegistered: false` with
 *   `membership-not-registered` in `refusalReasons`. A registry that has never stored the bot's own Membership
 *   yields an empty set for **every** channel (R4, fail closed), and an empty list read as "the bot can see
 *   nothing" would stop ingestion on a registry that is merely incomplete. That is R2's "never consume a
 *   partial registry as authoritative" showing up in a contract shape.
 *
 * A channel that is not in the registry cannot be enumerated here at all — there is no row to name it — so the
 * two absences a caller might conflate are distinguishable by their counts: `registeredTextCapableCount` of 0
 * means an empty or unconverged registry, while a positive count with an empty `channels` list means the bot
 * genuinely cannot view what is registered. Registry completeness itself is `GetGuildStateStatusQuery` (T8).
 *
 * Like the User-facing list, this is one wide snapshot read and one in-memory pass (spec Contracts: "one
 * bounded set read, never a per-channel round-trip loop"; R13).
 */

/** The bot's own Membership: whose access is being computed. Ids only, never a permission set (R13). */
export interface ListIngestibleChannelsInput {
	readonly botUserId: DiscordIdentifier;
}

/** One channel or thread ingestion may read. */
export interface IngestibleChannelEntry {
	readonly channelId: DiscordIdentifier;
	readonly channelType: RegistryChannelType;
	readonly isThread: boolean;
	readonly parentChannelId: DiscordIdentifier | null;
}

export interface ListIngestibleChannelsResult {
	readonly guildId: DiscordIdentifier;
	readonly botUserId: DiscordIdentifier;
	/** Registered, text-capable and bot-viewable: exactly what ingestion is allowed to enumerate (ingestion R2). */
	readonly channels: readonly IngestibleChannelEntry[];
	/** Registered text-capable rows the bot cannot view — the distinct fact, never folded into `channels`. */
	readonly botCannotViewChannelIds: readonly DiscordIdentifier[];
	/** How many text-capable rows the registry holds at all: the denominator of the two facts above. */
	readonly registeredTextCapableCount: number;
	/** Whether the registry holds the bot's own Membership row; false makes every evaluation fail closed (R4). */
	readonly botMembershipRegistered: boolean;
	readonly refusalReasons: readonly EffectivePermissionEmptyReason[];
}

export interface ListIngestibleChannelsDeps {
	readonly config: GuildStateConfig;
	readonly snapshot: PermissionSnapshotRepository;
	readonly logger: AppLogger;
}

export class ListIngestibleChannelsQuery {
	private readonly guildId: DiscordIdentifier;

	private readonly snapshot: PermissionSnapshotRepository;

	private readonly logger: AppLogger;

	public constructor(deps: ListIngestibleChannelsDeps) {
		this.guildId = deps.config.guildId;
		this.snapshot = deps.snapshot;
		this.logger = deps.logger;
	}

	public readonly execute = async (input: ListIngestibleChannelsInput): Promise<ListIngestibleChannelsResult> => {
		const botUserId = requireDiscordIdentifier("guild_membership.user_id", input.botUserId);
		const loaded = await this.loadSnapshot(botUserId);
		const scanned = scanEffectivePermissionsAcrossRegistry({
			guildId: this.guildId,
			userId: botUserId,
			snapshot: loaded
		});
		const textCapable = scanned.filter((entry) => channelRowIsTextCapable(entry.channel));

		const result: ListIngestibleChannelsResult = {
			guildId: this.guildId,
			botUserId,
			channels: textCapable.filter((entry) => grantsViewChannel(entry.derivation)).map(toEntry),
			botCannotViewChannelIds: textCapable
				.filter((entry) => !grantsViewChannel(entry.derivation))
				.map((entry) => entry.channel.channelId),
			registeredTextCapableCount: textCapable.length,
			botMembershipRegistered: loaded.membership !== null && loaded.membership.userId === botUserId,
			refusalReasons: distinctRefusalReasons(scanned.map((entry) => entry.derivation))
		};

		// R14: ids and counts. No channel names, no bitfields, no member data.
		this.logger.debug("guild-state ingestible-channel list computed", {
			guildId: result.guildId,
			botUserId,
			operation: "list-ingestible-channels",
			ingestibleChannelCount: result.channels.length,
			botCannotViewChannelCount: result.botCannotViewChannelIds.length,
			registeredTextCapableCount: result.registeredTextCapableCount,
			botMembershipRegistered: result.botMembershipRegistered
		});
		return result;
	};

	private async loadSnapshot(botUserId: DiscordIdentifier): Promise<RegistryPermissionSnapshot> {
		try {
			return await this.snapshot.loadSnapshot({ guildId: this.guildId, userId: botUserId, channelId: null });
		} catch (failure) {
			this.logger.error("guild-state ingestible-channel list could not read its snapshot", {
				guildId: this.guildId,
				botUserId,
				operation: "list-ingestible-channels",
				failure: failure instanceof Error ? failure.name : typeof failure
			});
			throw new EffectivePermissionEvaluationError("scan", this.guildId, botUserId, null, failure);
		}
	}
}

function toEntry(entry: RegistryChannelDerivation): IngestibleChannelEntry {
	const { channel } = entry;
	return {
		channelId: channel.channelId,
		channelType: channel.channelType,
		isThread: registryChannelIsThread(channel),
		parentChannelId: channel.parentChannelId
	};
}
