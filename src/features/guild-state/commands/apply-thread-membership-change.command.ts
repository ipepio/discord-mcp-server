import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { GuildStateConfig } from "../config/guild-state-config.interface.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireThreadMembershipChange } from "../models/domain/event-application-rules.js";
import type { ThreadMembershipChangeKind } from "../models/domain/event-application-rules.js";
import { isForeignGuildRecord, isThreadChannelType } from "../models/domain/registry-rules.js";
import type { ChannelRegistryRepository } from "../repositories/channel-registry.repository.js";
import type { ThreadMembershipRegistryRepository } from "../repositories/thread-membership-registry.repository.js";

/**
 * A private-thread membership event applied to the registry (docs/features/guild-state.md R8, R9, with R1 at
 * the event boundary).
 *
 * `THREAD_MEMBERSHIP_CREATE` and its removal counterpart both land on one (`thread id`, `User id`) row, so one
 * command serves both and the direction is part of the input rather than a second use case: the pair is one
 * fact about one edge, and R9's natural key is the edge itself. The writes are the repository's own single
 * statements — `ON CONFLICT DO NOTHING` for the add, a keyed `DELETE ... RETURNING` for the removal — which is
 * why a replay is a no-op that reports itself as one: no read of the stored set happens first, because the key
 * is what makes the write replay-safe and a read-then-write would only widen the window a concurrent event
 * could slip through.
 *
 * Two rules bound what this command may write:
 *
 * - **R8's error case.** A change for a thread the registry has no row for is *returned* as a deferral for the
 *   anomaly path (R11), never executed. An orphan thread row to hold the edge would be invented Discord state,
 *   and inventing an unresolvable grant is what R3 and R6 forbid; the thread arrives through its own event or
 *   through the resync pass, and the replayed change lands then. The same deferral covers a registry row that
 *   is not a thread: a text channel has no thread membership to record, and an edge keyed on it would be a
 *   contribution evaluation could never derive (a fail-closed reading of R8, like the sweep pinned in
 *   `odd/tasks/guild-state.md` L3(2)).
 * - **R8's fail-closed posture, which this command must not weaken.** A row exists because Discord said the
 *   user is in the thread; no row means nothing. Absence never grants — that is evaluation's rule (T7), and it
 *   is why nothing here back-fills membership for a thread this Installation could not observe. The coverage
 *   limit and open decision O1 stay exactly where the spec put them; the REST reconciliation half of R8 is
 *   T2's bootstrap path and T8's resync, both of which write the same table through `replaceThreadMemberships`.
 *
 * The edge does not require a Membership row. `thread_membership` deliberately has no foreign key to
 * `guild_membership` (T1, R8): the fact stands on its own, and a change that arrives before the roster page
 * lands must not fail on ordering. R4's cascade is what removes these edges when a Membership does end, and
 * R6's what removes them when the thread does.
 */

/** One thread-membership event: the configured Guild, the thread, the user, and which way it moved. */
export interface ApplyThreadMembershipChangeEvent {
	/** The Guild the event came from. Anything other than the configured one is dropped (R1). */
	readonly guildId: DiscordIdentifier;
	readonly threadId: DiscordIdentifier;
	readonly userId: DiscordIdentifier;
	/** The direction the event moved the edge: `added` for a creation, `removed` for its counterpart. */
	readonly change: ThreadMembershipChangeKind;
}

/** R8's error case, named: why this change could not be attached to a thread the registry holds. */
export type ThreadMembershipDeferralReason = "unknown-thread" | "not-a-thread";

/** The ids one change named, carried by every outcome so a caller never has to re-read the event. */
export interface ThreadMembershipChangeSubject {
	readonly guildId: DiscordIdentifier;
	readonly threadId: DiscordIdentifier;
	readonly userId: DiscordIdentifier;
	readonly change: ThreadMembershipChangeKind;
}

export type ApplyThreadMembershipChangeOutcome =
	| (ThreadMembershipChangeSubject & {
			readonly status: "applied";
			readonly change: "added";
			/** False when the edge was already there: a replay, and R9's no-op. */
			readonly rowWritten: boolean;
	  })
	| (ThreadMembershipChangeSubject & {
			readonly status: "applied";
			readonly change: "removed";
			/** False when there was no such edge: a repeated or post-resync removal is expected (R9). */
			readonly rowRemoved: boolean;
	  })
	| (ThreadMembershipChangeSubject & {
			readonly status: "refused";
			readonly reason: ThreadMembershipDeferralReason;
	  })
	| {
			readonly status: "dropped";
			readonly guildId: DiscordIdentifier;
			readonly threadId: DiscordIdentifier;
			readonly userId: DiscordIdentifier;
			readonly reason: "foreign-guild";
	  };

export interface ApplyThreadMembershipChangeCommandDeps {
	readonly config: GuildStateConfig;
	readonly channelRegistry: ChannelRegistryRepository;
	readonly threadMembershipRegistry: ThreadMembershipRegistryRepository;
	readonly logger: AppLogger;
}

export class ApplyThreadMembershipChangeCommand {
	private readonly guildId: DiscordIdentifier;

	private readonly channelRegistry: ChannelRegistryRepository;

	private readonly threadMembershipRegistry: ThreadMembershipRegistryRepository;

	private readonly logger: AppLogger;

	public constructor(deps: ApplyThreadMembershipChangeCommandDeps) {
		this.guildId = deps.config.guildId;
		this.channelRegistry = deps.channelRegistry;
		this.threadMembershipRegistry = deps.threadMembershipRegistry;
		this.logger = deps.logger;
	}

	public readonly execute = async (
		event: ApplyThreadMembershipChangeEvent
	): Promise<ApplyThreadMembershipChangeOutcome> => {
		if (isForeignGuildRecord(event.guildId, this.guildId)) {
			return this.dropForeignGuild(event);
		}

		const threadId = requireDiscordIdentifier("thread_membership.thread_id", event.threadId);
		const userId = requireDiscordIdentifier("thread_membership.user_id", event.userId);
		const change = requireThreadMembershipChange("thread_membership.change", event.change);
		const subject: ThreadMembershipChangeSubject = { guildId: this.guildId, threadId, userId, change };

		const deferral = await this.deferIfThreadIsNotRegistered(subject);
		if (deferral !== null) {
			return deferral;
		}

		// One statement, in the direction the event named. The two branches are inverses on the same natural key:
		// an add that found the edge already there writes nothing, and a removal that found nothing deletes
		// nothing — which is R9's replay, reported as such rather than papered over.
		if (change === "added") {
			const rowWritten = await this.threadMembershipRegistry.addThreadMembership({
				guildId: this.guildId,
				threadId,
				userId
			});
			this.logger.info("guild-state thread-membership registry applied a thread-member event", {
				guildId: this.guildId,
				threadId,
				userId,
				change,
				rowWritten
			});
			return { guildId: this.guildId, threadId, userId, change, status: "applied", rowWritten };
		}

		const rowRemoved = await this.threadMembershipRegistry.removeThreadMembership({
			guildId: this.guildId,
			threadId,
			userId
		});
		this.logger.info("guild-state thread-membership registry applied a thread-member event", {
			guildId: this.guildId,
			threadId,
			userId,
			change,
			rowRemoved
		});
		return { guildId: this.guildId, threadId, userId, change, status: "applied", rowRemoved };
	};

	/**
	 * R8's error case, decided by the registry's own channel rows: is there a thread with this id, and is that
	 * row a thread. `null` means the change may be written.
	 */
	private async deferIfThreadIsNotRegistered(
		subject: ThreadMembershipChangeSubject
	): Promise<ApplyThreadMembershipChangeOutcome | null> {
		const thread = await this.channelRegistry.findChannel(this.guildId, subject.threadId);
		if (thread !== null && isThreadChannelType(thread.channelType)) {
			return null;
		}

		const reason: ThreadMembershipDeferralReason = thread === null ? "unknown-thread" : "not-a-thread";
		// An anomaly to converge, not a failure to hide. The thread's own event, or the resync pass, is what
		// makes this change applicable later; the log carries ids and the reason and nothing else (R14).
		this.logger.warn("guild-state deferred a thread-member event for a thread the registry does not hold", {
			guildId: this.guildId,
			threadId: subject.threadId,
			userId: subject.userId,
			change: subject.change,
			reason
		});
		return { ...subject, status: "refused", reason };
	}

	/** R1: named and counted, never stored — another Guild's thread has no edge in this registry. */
	private dropForeignGuild(event: ApplyThreadMembershipChangeEvent): ApplyThreadMembershipChangeOutcome {
		this.logger.warn("guild-state dropped a thread-member event for another guild", {
			guildId: this.guildId,
			eventGuildId: event.guildId,
			threadId: event.threadId,
			userId: event.userId,
			operation: "apply-thread-membership-change"
		});
		return {
			status: "dropped",
			guildId: this.guildId,
			threadId: event.threadId,
			userId: event.userId,
			reason: "foreign-guild"
		};
	}
}
