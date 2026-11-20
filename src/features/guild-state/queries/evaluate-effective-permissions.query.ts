import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { GuildStateConfig } from "../config/guild-state-config.interface.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import type { EffectivePermissionDerivation } from "../models/domain/effective-permission-rules.js";
import { deriveEffectivePermissions } from "../models/domain/effective-permission-rules.js";
import { EffectivePermissionEvaluationError } from "../models/domain/guild-state-registry.errors.js";
import type { PermissionSnapshotRepository } from "../repositories/permission-snapshot.repository.js";

/**
 * The effective-permission decision for one (User, Channel or thread) pair — the security core of the hub
 * (docs/features/guild-state.md R12, R13; Contracts; docs/adr/0005).
 *
 * The whole rule sits in `models/domain/effective-permission-rules.ts`; this use case is deliberately thin,
 * because a decision with logic in two places is a decision with two places to get wrong. What lives here:
 *
 * - **Guild scoping (R1).** The input carries no Guild id. The configured one is the only scope a decision
 *   is taken under, so an id from another Guild cannot be asked about — the projection simply holds no row
 *   for it, which is the fail-closed answer Contracts asks for.
 * - **One snapshot (spec Contracts).** One call to the snapshot read model, so the base, the overwrite sets
 *   and the thread-membership fact all describe one instant. Two calls would be a torn read with a name
 *   that sounds like a permission decision.
 * - **Read-only (R13).** The only injected capability is a read, and it has no write method to call. No
 *   REST, no event emission, no resync trigger, no state mutation.
 * - **Caller-supplied inputs are ids only.** A caller supplies no permissions, roles, overwrites or
 *   membership state; everything the decision uses is what the registry stored from Discord (R5's
 *   never-infer rule, at the read boundary).
 *
 * Errors are separated exactly as the spec's three fail-closed cases require: an absent channel, an absent
 * membership or an ungated private thread is a *result* — the empty set, with the reason named — while a
 * read that failed or a bitfield that could not be parsed is `EffectivePermissionEvaluationError`. An
 * evaluation that broke is never reported as a decision to deny, because "you may not see it" and "we could
 * not decide" are different facts and the query surface must be able to tell them apart.
 */

/** Who is asking about what. Both ids are validated before anything is read (R9). */
export interface EvaluateEffectivePermissionsInput {
	readonly userId: DiscordIdentifier;
	readonly channelId: DiscordIdentifier;
}

/** The derivation's answer: the exact decimal bitfield text plus the named lookups the spec promises. */
export type EvaluateEffectivePermissionsResult = EffectivePermissionDerivation;

export interface EvaluateEffectivePermissionsDeps {
	readonly config: GuildStateConfig;
	readonly snapshot: PermissionSnapshotRepository;
	readonly logger: AppLogger;
}

export class EvaluateEffectivePermissionsQuery {
	private readonly guildId: DiscordIdentifier;

	private readonly snapshot: PermissionSnapshotRepository;

	private readonly logger: AppLogger;

	public constructor(deps: EvaluateEffectivePermissionsDeps) {
		this.guildId = deps.config.guildId;
		this.snapshot = deps.snapshot;
		this.logger = deps.logger;
	}

	public readonly execute = async (
		input: EvaluateEffectivePermissionsInput
	): Promise<EvaluateEffectivePermissionsResult> => {
		const userId = requireDiscordIdentifier("guild_membership.user_id", input.userId);
		const channelId = requireDiscordIdentifier("channel.channel_id", input.channelId);

		const read = await this.readSnapshot(userId, channelId);
		const derived = this.derive(read, userId, channelId);

		this.report(derived);
		return derived;
	};

	/** One projection read, one snapshot. A failure is named as technical and never answered as an empty set. */
	private async readSnapshot(
		userId: DiscordIdentifier,
		channelId: DiscordIdentifier
	): Promise<Awaited<ReturnType<PermissionSnapshotRepository["loadSnapshot"]>>> {
		try {
			return await this.snapshot.loadSnapshot({ guildId: this.guildId, userId, channelId });
		} catch (failure) {
			this.logger.error("guild-state effective-permission evaluation could not read its snapshot", {
				guildId: this.guildId,
				userId,
				channelId,
				operation: "evaluate",
				failure: failure instanceof Error ? failure.name : typeof failure
			});
			throw new EffectivePermissionEvaluationError("evaluate", this.guildId, userId, channelId, failure);
		}
	}

	/** The derivation is pure, so a stored value it cannot represent is a technical failure too (R3). */
	private derive(
		snapshot: Awaited<ReturnType<PermissionSnapshotRepository["loadSnapshot"]>>,
		userId: DiscordIdentifier,
		channelId: DiscordIdentifier
	): EffectivePermissionDerivation {
		try {
			return deriveEffectivePermissions({ guildId: this.guildId, userId, channelId, snapshot });
		} catch (failure) {
			this.logger.error("guild-state effective-permission evaluation could not derive a decision", {
				guildId: this.guildId,
				userId,
				channelId,
				operation: "evaluate",
				failure: failure instanceof Error ? failure.name : typeof failure
			});
			throw new EffectivePermissionEvaluationError("evaluate", this.guildId, userId, channelId, failure);
		}
	}

	/**
	 * R14's shape for a decision log: ids, the reason, and counts. The bitfield text itself is not logged —
	 * it is derivable from the ids and the registry, and a log that carries permission values is a log that
	 * can leak a grant nobody asked about.
	 */
	private report(derived: EffectivePermissionDerivation): void {
		if (derived.status === "empty") {
			this.logger.warn("guild-state effective-permission evaluation failed closed", {
				guildId: derived.guildId,
				userId: derived.userId,
				channelId: derived.channelId,
				reason: derived.reason,
				permissionCount: 0
			});
			return;
		}
		this.logger.debug("guild-state effective-permission evaluation decided", {
			guildId: derived.guildId,
			userId: derived.userId,
			channelId: derived.channelId,
			administratorBypass: derived.administratorBypass,
			overwriteLevelCount: derived.overwriteLevels.length,
			permissionCount: derived.permissions.granted.length
		});
	}
}
