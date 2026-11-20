import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { GuildStateConfig } from "../config/guild-state-config.interface.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { isForeignGuildRecord } from "../models/domain/registry-rules.js";
import type {
	VanishedStateReadSets,
	VanishedStateSkip,
	VanishedStateSkipReason,
	VanishedStateSweepReport,
	VanishedStateTarget
} from "../models/domain/vanished-state.js";
import {
	VANISHED_STATE_TARGETS,
	emptyVanishedStateSweepReport,
	vanishedFromRead
} from "../models/domain/vanished-state.js";
import type { ChannelRegistryRepository } from "../repositories/channel-registry.repository.js";
import type { MembershipRegistryRepository } from "../repositories/membership-registry.repository.js";
import type { RoleRegistryRepository } from "../repositories/role-registry.repository.js";
import { splitWriteBatch } from "../repositories/registry-write-batch.js";
import type { DeleteChannelCommand } from "./delete-channel.command.js";
import type { DeleteRoleCommand } from "./delete-role.command.js";

/**
 * The resync convergence sweep (docs/features/guild-state.md R11, with R2's bound, R10's wholesale replacement,
 * R3/R4/R6's cascades and R14's logging rule).
 *
 * R11's sentence is the security one: a state change the event stream never delivered has to be converged by the
 * same replace-and-converge path, "so a revoked role or a departed member does not keep grants because the event
 * was never delivered". The bootstrap pass writes what Discord reported; on its own it never removes what Discord
 * *stopped* reporting. So a row the registry still holds and a complete read no longer names — the Membership of a
 * member who left, a deleted role, a deleted channel — survives as an authorization the provider has already
 * withdrawn. This command is the half that closes that window, and only a resync asks for it.
 *
 * The rules it holds to:
 *
 * - **A complete read, or nothing.** A diff only means something against a read the provider finished. The role
 *   and channel reads are unpaginated, so a list that arrived is the whole list; the roster is not, and a roster
 *   that stopped at its page bound is a *partial* set — diffing it would end every member past the bound, a mass
 *   revocation invented out of a pagination limit (R2, R11). So a truncated roster sweeps no memberships at all:
 *   the refusal is reported and logged, and the `roster-truncated` gap the bootstrap pass already recorded is what
 *   keeps the status out of `current` until a pass reads the roster to its end.
 * - **The cascades, not a hand-written delete.** A vanished role goes through {@link DeleteRoleCommand} and a
 *   vanished channel through {@link DeleteChannelCommand}, so the role assignments, overwrite rows and thread
 *   edges that named them go in the same transactions the event path uses (R3, R6), with the same observable
 *   counts. A vanished membership goes through the repository's own `deleteMembershipAndDependents` — the same
 *   call `EndMembershipCommand` issues for a kick — so member-targeted overwrites and private-thread edges go
 *   with it (R4).
 * - **Bounded.** The ids to remove are grouped by `config.bootstrap.writeBatchSize` and each cascade is one
 *   transaction, so a sweep's write cost is bounded by the batch size this feature already declares
 *   (docs/architecture/persistence.md) rather than by how much the outage took.
 * - **Idempotent, and inert when there is nothing to converge** (R9). The diff is recomputed from the stored rows
 *   every time, so a replayed resync removes nothing the first pass did not already remove. Over an empty
 *   registry the stored side is empty, so the sweep is a no-op by construction — which is why a first bootstrap
 *   needs no branch: it does not run a sweep at all, and running one there would find nothing.
 * - **R14.** Every line carries the Guild id, the ids removed and the counts the cascades returned. Never a name,
 *   a nickname, a message or a credential.
 */

/** The whole sets the resync's bootstrap pass read, as the provider reported them (R10, R11). */
export interface SweepVanishedStateInput {
	/** The Guild the sweep belongs to. Anything else is refused whole, before a single row is diffed (R1). */
	readonly guildId: DiscordIdentifier;
	readonly reads: VanishedStateReadSets;
}

export interface SweepVanishedStateCommandDeps {
	readonly config: GuildStateConfig;
	readonly membershipRegistry: MembershipRegistryRepository;
	readonly roleRegistry: RoleRegistryRepository;
	readonly channelRegistry: ChannelRegistryRepository;
	/** R3's cascade, reused rather than reimplemented: a swept role loses its links and its overwrites. */
	readonly deleteRoleCommand: DeleteRoleCommand;
	/** R6's cascade, reused: a swept channel loses its overwrite set, its child threads and its thread edges. */
	readonly deleteChannelCommand: DeleteChannelCommand;
	readonly logger: AppLogger;
}

/** One target's sweep result, kept internal so the three of them add up into the reported outcome. */
interface TargetSweep {
	readonly removed: number;
	readonly dependentRows: number;
	readonly batches: number;
}

/** Nothing swept: the shape a target reports when the diff was empty or the read refused it. */
const NOTHING_SWEPT: TargetSweep = Object.freeze({ removed: 0, dependentRows: 0, batches: 0 });

export class SweepVanishedStateCommand {
	private readonly guildId: DiscordIdentifier;

	private readonly membershipRegistry: MembershipRegistryRepository;

	private readonly roleRegistry: RoleRegistryRepository;

	private readonly channelRegistry: ChannelRegistryRepository;

	private readonly deleteRoleCommand: DeleteRoleCommand;

	private readonly deleteChannelCommand: DeleteChannelCommand;

	private readonly logger: AppLogger;

	/** The bound every registry write in this feature declares, applied to the sweep's cascades (R9). */
	private readonly writeBatchSize: number;

	public constructor(deps: SweepVanishedStateCommandDeps) {
		this.guildId = deps.config.guildId;
		this.membershipRegistry = deps.membershipRegistry;
		this.roleRegistry = deps.roleRegistry;
		this.channelRegistry = deps.channelRegistry;
		this.deleteRoleCommand = deps.deleteRoleCommand;
		this.deleteChannelCommand = deps.deleteChannelCommand;
		this.logger = deps.logger;
		this.writeBatchSize = deps.config.bootstrap.writeBatchSize;
	}

	public readonly execute = async (input: SweepVanishedStateInput): Promise<VanishedStateSweepReport> => {
		// R1 at the use-case edge, the same shape every other write in this feature has: a sweep asked about
		// another Guild removes nothing and says so, rather than reading that Guild's rows and deleting this one's.
		if (isForeignGuildRecord(input.guildId, this.guildId)) {
			this.logger.warn("guild-state resync sweep refused a read set for another guild", {
				guildId: this.guildId,
				eventGuildId: input.guildId,
				operation: "sweep-vanished-state",
				reason: "foreign-guild"
			});
			return {
				...emptyVanishedStateSweepReport(),
				skipped: VANISHED_STATE_TARGETS.map((target) => ({ target, reason: "foreign-guild" as const }))
			};
		}

		const skipped: VanishedStateSkip[] = [];
		const memberships = await this.sweepMemberships(input.reads, skipped);
		const roles = await this.sweepRoles(input.reads, skipped);
		const channels = await this.sweepChannels(input.reads, skipped);

		return {
			removedMemberships: memberships.removed,
			removedRoles: roles.removed,
			removedChannels: channels.removed,
			dependentRowsRemoved: memberships.dependentRows + roles.dependentRows + channels.dependentRows,
			batches: memberships.batches + roles.batches + channels.batches,
			skipped
		};
	};

	/* ------------------------------------------------------------------------ memberships */

	/**
	 * R4's cascade, once per vanished member. The read is the only authority on who is in the Guild, and R2's
	 * bound says a roster that stopped early is not an authority — hence the refusal before any diff.
	 */
	private async sweepMemberships(reads: VanishedStateReadSets, skipped: VanishedStateSkip[]): Promise<TargetSweep> {
		const roster = reads.roster;
		if (roster === undefined) {
			this.refuse(skipped, "memberships", "not-read-in-this-pass");
			return NOTHING_SWEPT;
		}
		if (!roster.complete) {
			this.refuse(skipped, "memberships", "roster-truncated");
			return NOTHING_SWEPT;
		}

		const stored = await this.membershipRegistry.findMembershipUserIds(this.guildId);
		const vanished = vanishedFromRead(stored, roster.userIds);
		if (vanished.length === 0) {
			// The common case, and the one that makes a first resync over an empty registry or a quiet reconnect
			// inert: nothing to remove, so no cascade runs and no delete transaction is opened (R9).
			this.logger.debug("guild-state resync sweep found no membership to converge", {
				guildId: this.guildId,
				target: "memberships",
				storedMembershipCount: stored.length,
				rosterSize: roster.userIds.length
			});
			return NOTHING_SWEPT;
		}

		let removed = 0;
		let dependentRows = 0;
		let batches = 0;
		for (const batch of splitWriteBatch(vanished, this.writeBatchSize)) {
			batches += 1;
			for (const userId of batch) {
				const result = await this.membershipRegistry.deleteMembershipAndDependents(this.guildId, userId);
				if (result.membershipRemoved) {
					removed += 1;
				}
				dependentRows += result.roleLinksRemoved + result.overwritesRemoved + result.threadMembershipsRemoved;
			}
		}
		const swept: TargetSweep = { removed, dependentRows, batches };
		this.report("memberships", vanished, swept);
		return swept;
	}

	/* ------------------------------------------------------------------------------ roles */

	/**
	 * R3's cascade, once per vanished role. The role read is unpaginated, so a list that arrived is the whole
	 * list and an id it omits is a role Discord deleted — R11's own example, because a revoked role that keeps
	 * its row keeps handing out its permissions.
	 */
	private async sweepRoles(reads: VanishedStateReadSets, skipped: VanishedStateSkip[]): Promise<TargetSweep> {
		const read = reads.roles;
		if (read === undefined) {
			this.refuse(skipped, "roles", "not-read-in-this-pass");
			return NOTHING_SWEPT;
		}

		const stored = (await this.roleRegistry.findRoles(this.guildId)).map((role) => role.roleId);
		const vanished = vanishedFromRead(stored, read);
		if (vanished.length === 0) {
			return NOTHING_SWEPT;
		}

		let removed = 0;
		let dependentRows = 0;
		let batches = 0;
		for (const batch of splitWriteBatch(vanished, this.writeBatchSize)) {
			batches += 1;
			for (const roleId of batch) {
				const outcome = await this.deleteRoleCommand.execute({ guildId: this.guildId, roleId });
				if (outcome.status === "applied" && outcome.roleRemoved) {
					removed += 1;
					dependentRows += outcome.membershipLinksRemoved + outcome.overwritesRemoved;
				}
			}
		}
		const swept: TargetSweep = { removed, dependentRows, batches };
		this.report("roles", vanished, swept);
		return swept;
	}

	/* --------------------------------------------------------------------------- channels */

	/**
	 * R6's cascade, once per vanished channel or thread. Threads are part of the channel read, so a thread
	 * deleted during the outage loses its overwrite rows, its child threads and its private-thread edges exactly
	 * the way a `channel-deleted` event would.
	 */
	private async sweepChannels(reads: VanishedStateReadSets, skipped: VanishedStateSkip[]): Promise<TargetSweep> {
		const read = reads.channels;
		if (read === undefined) {
			this.refuse(skipped, "channels", "not-read-in-this-pass");
			return NOTHING_SWEPT;
		}

		const stored = (await this.channelRegistry.findChannels(this.guildId)).map((channel) => channel.channelId);
		const vanished = vanishedFromRead(stored, read);
		if (vanished.length === 0) {
			return NOTHING_SWEPT;
		}

		let removed = 0;
		let dependentRows = 0;
		let batches = 0;
		for (const batch of splitWriteBatch(vanished, this.writeBatchSize)) {
			batches += 1;
			for (const channelId of batch) {
				const outcome = await this.deleteChannelCommand.execute({ guildId: this.guildId, channelId });
				if (outcome.status === "applied" && outcome.channelRemoved) {
					removed += 1;
					dependentRows +=
						outcome.childThreadsRemoved + outcome.overwritesRemoved + outcome.threadMembershipsRemoved;
				}
			}
		}
		const swept: TargetSweep = { removed, dependentRows, batches };
		this.report("channels", vanished, swept);
		return swept;
	}

	/* ------------------------------------------------------------------------- reporting */

	/**
	 * The refusal, stated before any diff. It is loud because it is the security-relevant branch: the registry
	 * keeps rows this process could not prove gone, and the `roster-truncated` gap the bootstrap pass recorded is
	 * what holds the status out of `current` until a pass reads the roster to its end (R2, R11).
	 */
	private refuse(skipped: VanishedStateSkip[], target: VanishedStateTarget, reason: VanishedStateSkipReason): void {
		skipped.push({ target, reason });
		this.logger.warn("guild-state resync sweep skipped a target; its read was not complete", {
			guildId: this.guildId,
			target,
			reason,
			operation: "sweep-vanished-state"
		});
	}

	/** One swept target: the ids removed and the counts the cascades returned (R14: ids and counts). */
	private report(target: VanishedStateTarget, vanished: readonly DiscordIdentifier[], swept: TargetSweep): void {
		this.logger.info("guild-state resync sweep converged state that vanished during the outage", {
			guildId: this.guildId,
			target,
			operation: "sweep-vanished-state",
			removedIds: vanished,
			removedCount: vanished.length,
			batches: swept.batches,
			dependentRowsRemoved: swept.dependentRows
		});
	}
}
