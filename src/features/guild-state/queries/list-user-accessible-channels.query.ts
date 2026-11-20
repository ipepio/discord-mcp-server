import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { GuildStateConfig } from "../config/guild-state-config.interface.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import type { RegistryChannelType } from "../models/domain/channel-capability.js";
import type {
	EffectivePermissionDerivation,
	EffectivePermissionEmptyReason,
	RegistryChannelDerivation
} from "../models/domain/effective-permission-rules.js";
import {
	distinctRefusalReasons,
	scanEffectivePermissionsAcrossRegistry
} from "../models/domain/effective-permission-rules.js";
import { EffectivePermissionEvaluationError } from "../models/domain/guild-state-registry.errors.js";
import type { RegistryChannel, RegistryPermissionSnapshot } from "../models/domain/registry-records.js";
import { registryChannelIsThread } from "../models/domain/registry-rules.js";
import type { PermissionSnapshotRepository } from "../repositories/permission-snapshot.repository.js";

/**
 * The channels one User may see (docs/features/guild-state.md Contracts: `ListUserAccessibleChannelsQuery` —
 * "the registry's channel/thread ids where that User holds `VIEW_CHANNEL`, each entry carrying whether
 * `READ_MESSAGE_HISTORY` also holds, computed with the evaluation above in one bounded set read (never a
 * per-channel round-trip loop)"). Consumed by the query feature for `list_channels` and as the accessible-id
 * set its read repositories are parameterized with (query R2).
 *
 * The bounded pass is why the snapshot is read in its wide form (`channelId: null`): one read transaction at
 * `REPEATABLE READ` returns every channel row and every overwrite set of the Guild, and the derivation then
 * runs per channel **in memory** over that one snapshot (R13). Looping the point read would be both the round
 * trip the spec forbids and a different snapshot per iteration — a torn answer dressed up as a list.
 *
 * The filter is a lookup on the derived set, not a second rule: `view-channel` is what the same five-stage
 * derivation produced, so a channel cannot be listed here and refused by `EvaluateEffectivePermissionsQuery`
 * for the same User and channel from the same state (R12).
 */

/** One accessible channel with registry display metadata and the history permission fact. */
export interface UserAccessibleChannelEntry {
	readonly channelId: DiscordIdentifier;
	readonly channelType: RegistryChannelType;
	readonly name: string | null;
	readonly position: number | null;
	/** Threads are in the same list as channels, because the registry is one registry (R6). */
	readonly isThread: boolean;
	/** The parent a thread was evaluated under, `null` for a top-level channel (Contracts' thread rule). */
	readonly parentChannelId: DiscordIdentifier | null;
	/** Whether `READ_MESSAGE_HISTORY` holds as well, which is what decides whether content can be read. */
	readonly canReadMessageHistory: boolean;
}

export interface ListUserAccessibleChannelsResult {
	readonly guildId: DiscordIdentifier;
	readonly userId: DiscordIdentifier;
	readonly channels: readonly UserAccessibleChannelEntry[];
	/** Every stored channel the scan judged, for a caller that needs the denominator (R14 counts). */
	readonly evaluatedChannelCount: number;
	/**
	 * Why the list is empty when nothing was judged at all: the distinct fail-closed reasons behind the scan
	 * (`membership-not-registered`, `everyone-role-not-registered`, …). Empty whenever at least one channel
	 * produced a real decision, because then the list itself is the answer.
	 */
	readonly refusalReasons: readonly EffectivePermissionEmptyReason[];
}

export interface ListUserAccessibleChannelsInput {
	readonly userId: DiscordIdentifier;
}

export interface ListUserAccessibleChannelsDeps {
	readonly config: GuildStateConfig;
	readonly snapshot: PermissionSnapshotRepository;
	readonly logger: AppLogger;
}

export class ListUserAccessibleChannelsQuery {
	private readonly guildId: DiscordIdentifier;

	private readonly snapshot: PermissionSnapshotRepository;

	private readonly logger: AppLogger;

	public constructor(deps: ListUserAccessibleChannelsDeps) {
		this.guildId = deps.config.guildId;
		this.snapshot = deps.snapshot;
		this.logger = deps.logger;
	}

	public readonly execute = async (
		input: ListUserAccessibleChannelsInput
	): Promise<ListUserAccessibleChannelsResult> => {
		const userId = requireDiscordIdentifier("guild_membership.user_id", input.userId);
		const loaded = await this.loadSnapshot(userId);
		const scanned = scanEffectivePermissionsAcrossRegistry({ guildId: this.guildId, userId, snapshot: loaded });

		const result: ListUserAccessibleChannelsResult = {
			guildId: this.guildId,
			userId,
			channels: scanned.filter(accessible).map(toAccessibleEntry),
			evaluatedChannelCount: scanned.length,
			refusalReasons: distinctRefusalReasons(scanned.map((entry) => entry.derivation))
		};

		// R14: ids and counts only — no channel names, no bitfield text.
		this.logger.debug("guild-state accessible-channel list read", {
			guildId: result.guildId,
			userId,
			operation: "list-user-accessible-channels",
			accessibleChannelCount: result.channels.length,
			evaluatedChannelCount: result.evaluatedChannelCount,
			refusalReasonCount: result.refusalReasons.length
		});
		return result;
	};

	/** A read that broke is a named technical failure, never an empty list pretending to be a decision (R6). */
	private async loadSnapshot(userId: DiscordIdentifier): Promise<RegistryPermissionSnapshot> {
		try {
			return await this.snapshot.loadSnapshot({ guildId: this.guildId, userId, channelId: null });
		} catch (failure) {
			this.logger.error("guild-state accessible-channel list could not read its snapshot", {
				guildId: this.guildId,
				userId,
				operation: "list-user-accessible-channels",
				failure: failure instanceof Error ? failure.name : typeof failure
			});
			throw new EffectivePermissionEvaluationError("scan", this.guildId, userId, null, failure);
		}
	}
}

function accessible(entry: RegistryChannelDerivation): boolean {
	return entry.derivation.permissions.has("view-channel");
}

function toAccessibleEntry(entry: RegistryChannelDerivation): UserAccessibleChannelEntry {
	const channel: RegistryChannel = entry.channel;
	const derivation: EffectivePermissionDerivation = entry.derivation;
	return {
		channelId: channel.channelId,
		channelType: channel.channelType,
		name: channel.name,
		position: channel.position,
		isThread: registryChannelIsThread(channel),
		parentChannelId: channel.parentChannelId,
		canReadMessageHistory: derivation.permissions.has("read-message-history")
	};
}
