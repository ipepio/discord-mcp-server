import type { ChannelPermissionOverwrite, NormalizedChannelType } from "../../discord/index.js";
import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { GuildStateConfig } from "../config/guild-state-config.interface.js";
import type { ChannelsIngestibilityGained } from "../gateways/channels-ingestibility-gained.port.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import type { ChannelAccessTransition } from "../models/domain/channel-access-rules.js";
import { detectChannelAccessTransition } from "../models/domain/channel-access-rules.js";
import { isTextCapableChannelType } from "../models/domain/channel-capability.js";
import { deriveEffectivePermissions, grantsViewChannel } from "../models/domain/effective-permission-rules.js";
import {
	completeChannelDescription,
	partitionOverwriteTargets,
	resolvedParentChannelId
} from "../models/domain/event-application-rules.js";
import type { ChannelDescriptionRefusalReason } from "../models/domain/event-application-rules.js";
import { InvalidRegistryFieldValueError } from "../models/domain/guild-state-registry.errors.js";
import { isForeignGuildRecord, isThreadChannelType } from "../models/domain/registry-rules.js";
import type { ChannelRegistryRepository } from "../repositories/channel-registry.repository.js";
import type { PermissionSnapshotRepository } from "../repositories/permission-snapshot.repository.js";

/**
 * One channel or thread event applied to the registry (docs/features/guild-state.md R6, R7, R9, R10, with R1
 * at the event boundary).
 *
 * Channels and threads are ONE registry, so one command serves both: a thread is a channel with a parent (R6),
 * and the input is the union of what a `CHANNEL_*` and a `THREAD_*` payload says about that one row — the
 * subscription binding maps the two normalized kinds onto it field for field. Nothing here needs to know which
 * kind arrived: thread-ness is derived from the channel type by the domain rule, so a caller cannot declare a
 * thread to be a channel and dodge the parent rule.
 *
 * Three rules shape the writes:
 *
 * - **R6, one row.** The row is written whole through the repository's idempotent upsert. A thread with no
 *   resolvable parent, or one naming a parent the registry has no row for, is *returned* as a refusal for the
 *   anomaly path (R11) — never stored parentless, and never left to surface as a foreign-key error.
 * - **R7, wholesale replacement.** A reported overwrite set becomes the channel's whole set through
 *   `replaceChannelOverwrites`, one transaction that sweeps before it inserts, so a grant that disappeared
 *   from Discord's payload cannot survive as a stale row. A target kind that is neither role nor member is
 *   dropped and counted there, never guessed from the id; every other target is stored as Discord reported it,
 *   because an unknown target is inert at evaluation (T7) and only evaluation knows who holds which role.
 * - **R10, absent is not empty.** A payload that carried no overwrite list writes no overwrite rows at all and
 *   reports `permissionOverwrites` in `pendingRestFields`, which is what T8's targeted REST read consumes. The
 *   stored set is left exactly as it was: "the update said nothing" must never look like "the channel has no
 *   overwrites".
 *
 * R9: replaying the event re-runs the same natural-key writes, so the state after the second delivery is
 * indistinguishable from the state after the first.
 *
 * **The channel-access trigger** (`odd/tasks/ingestion-channel-access-trigger.md` S1, S2, S3) is the one thing
 * this command says out loud. The overwrite replacement is the moment the bot's own `view-channel` decision can
 * change, so when the payload reports a set — or the row is new and therefore had nothing to view before — the
 * command asks the registry's committed five-stage derivation twice: once from the stored state and once from
 * the state this event leaves behind. When that pair is "cannot view → can view" on a channel that can carry
 * text, it reports {@link UpsertChannelOutcome.ingestibilityGained} and hands the channel id to the outbound
 * {@link ChannelsIngestibilityGained} port. It never derives a permission itself, never imports the consumer
 * that walks history, and never blocks on it: the port returns `void` and the row was already written.
 *
 * What this command does *not* do is emit anything. R6's structure-change fact reaches ingestion through the
 * `discord` feature's own normalized stream, which already publishes every channel and thread kind to every
 * subscriber (spec Contracts; ingestion R2); a second bus here would be a second source of truth about one
 * change, and the registry's job is the row. The access trigger is the one exception, and it is a permission
 * decision — this feature's own fact — not a copy of the event.
 */

/** One channel or thread as a normalized create/update event describes it. Absent fields were absent. */
export interface UpsertChannelEvent {
	/** The Guild the event came from. Anything other than the configured one is dropped (R1). */
	readonly guildId: DiscordIdentifier;
	readonly channelId: DiscordIdentifier;
	readonly channelType: NormalizedChannelType;
	readonly name?: string;
	readonly position?: number;
	/** Mandatory for a thread. `null` says the payload named no parent; absent says it said nothing. */
	readonly parentChannelId?: DiscordIdentifier | null;
	/** Absent when the payload carried no overwrite list; an empty list is an explicit empty set (R10). */
	readonly permissionOverwrites?: readonly ChannelPermissionOverwrite[];
}

/** The field a channel event left for the resync path to complete, named exactly as the payload names it. */
const PENDING_OVERWRITE_FIELD = "permissionOverwrites";

/**
 * The bot-access trigger's collaborators, supplied by composition only when it knows who the bot is.
 *
 * All three belong together: without the bot's own Membership id there is nobody to evaluate, without the
 * snapshot read there is no decision to make, and without the port the decision would have no consumer. A
 * composition that omits them (a harness, a use-case test) gets exactly the command this feature shipped
 * before the trigger existed.
 */
export interface ChannelAccessTriggerDeps {
	/** The bot's own Membership id: the bot is a member like any other (R4), so no id is special-cased. */
	readonly botUserId: DiscordIdentifier;
	/** The one consistent read the derivation takes (R12). */
	readonly snapshot: PermissionSnapshotRepository;
	/** Where a gained transition goes (S3). */
	readonly channelsIngestibilityGained: ChannelsIngestibilityGained;
}

/** The trigger's first half: the state the pair is measured from, captured while it still exists. */
interface AccessTransitionStart {
	readonly channelType: NormalizedChannelType;
	readonly before: boolean;
}

/** Where one channel or thread event ended up. Every case is reported, because a refusal is not a success. */
export type UpsertChannelOutcome =
	| {
			readonly status: "applied";
			readonly guildId: DiscordIdentifier;
			readonly channelId: DiscordIdentifier;
			readonly isThread: boolean;
			/** True when the registry held no row for this channel id before this event. */
			readonly created: boolean;
			readonly rowsWritten: number;
			/** False when the payload carried no overwrite list: nothing was swept, nothing was inserted. */
			readonly overwriteSetReplaced: boolean;
			readonly overwritesWritten: number;
			/** Targets dropped by R7's error case, counted and named, never guessed at. */
			readonly droppedOverwriteTargetIds: readonly DiscordIdentifier[];
			/** Fields the payload omitted that stored state could not complete: T8's targeted REST reads. */
			readonly pendingRestFields: readonly string[];
			readonly completedFields: readonly string[];
			/**
			 * True when this event turned the bot from "cannot view" into "can view" on a text-capable channel —
			 * the one fact that starts ingestion's history walk (S1, S2).
			 */
			readonly ingestibilityGained: boolean;
			/**
			 * The evaluated pair behind {@link ingestibilityGained}, or `null` when no evaluation was due: a payload
			 * that reported no overwrite set on an existing row, a channel type nothing is posted in, or a bot whose
			 * viewability could not be read. `null` is "not evaluated", never "unchanged".
			 */
			readonly accessTransition: ChannelAccessTransition | null;
	  }
	| {
			readonly status: "refused";
			readonly guildId: DiscordIdentifier;
			readonly channelId: DiscordIdentifier;
			readonly reason: ChannelDescriptionRefusalReason;
			readonly parentChannelId: DiscordIdentifier | null;
	  }
	| {
			readonly status: "dropped";
			readonly guildId: DiscordIdentifier;
			readonly channelId: DiscordIdentifier;
			readonly reason: "foreign-guild";
	  };

export interface UpsertChannelCommandDeps {
	readonly config: GuildStateConfig;
	readonly channelRegistry: ChannelRegistryRepository;
	readonly logger: AppLogger;
	/** Absent disables the access trigger: the command is the registry write it always was. */
	readonly accessTrigger?: ChannelAccessTriggerDeps;
}

export class UpsertChannelCommand {
	private readonly guildId: DiscordIdentifier;

	private readonly channelRegistry: ChannelRegistryRepository;

	private readonly logger: AppLogger;

	private readonly accessTrigger: ChannelAccessTriggerDeps | null;

	public constructor(deps: UpsertChannelCommandDeps) {
		this.guildId = deps.config.guildId;
		this.channelRegistry = deps.channelRegistry;
		this.logger = deps.logger;
		// Validated once, at construction: an id that cannot live in a bigint column is a composition error, not
		// a fact to rediscover on every channel event.
		this.accessTrigger =
			deps.accessTrigger === undefined
				? null
				: {
						...deps.accessTrigger,
						botUserId: requireDiscordIdentifier("guild_membership.user_id", deps.accessTrigger.botUserId)
					};
	}

	public readonly execute = async (event: UpsertChannelEvent): Promise<UpsertChannelOutcome> => {
		if (isForeignGuildRecord(event.guildId, this.guildId)) {
			return this.dropForeignGuild(event.guildId, event.channelId);
		}

		const channelId = requireDiscordIdentifier("channel.channel_id", event.channelId);
		const reportedParentChannelId = this.requireStorableParent(event.parentChannelId);
		this.requireStorablePosition(event.position);

		// Two bounded point reads, both for R10's completion and R6's parent rule: what the registry already
		// says about this row, and whether the parent the row resolves to exists at all. Neither is a read of
		// the previous overwrite set — replacement never needs to know what was there before.
		const stored = await this.channelRegistry.findChannel(this.guildId, channelId);
		const parentChannelId = resolvedParentChannelId(
			this.toDescription(channelId, event, reportedParentChannelId),
			stored
		);
		const parentRegistered = parentChannelId === null ? false : await this.isRegistered(parentChannelId);

		const description = completeChannelDescription(
			this.guildId,
			this.toDescription(channelId, event, reportedParentChannelId),
			stored,
			parentChannelId,
			parentRegistered
		);
		if (description.status === "refused") {
			return this.refuse(channelId, description.reason, description.parentChannelId);
		}

		// The overwrite set is partitioned before anything is written. A bitfield that reached this seam as a
		// number is a value the registry must refuse (R3, R7), and refusing it after the row write would leave
		// half an event applied — so the validation runs first and the payload either describes a row in full or
		// writes nothing at all. An absent list is not an empty one: `reported` is what the two branches turn on,
		// and the absent branch never reaches the replacement statement (R10).
		const reported = event.permissionOverwrites !== undefined;
		const partition = reported
			? partitionOverwriteTargets(event.permissionOverwrites)
			: {
					storable: [] as readonly ChannelPermissionOverwrite[],
					droppedTargetIds: [] as readonly DiscordIdentifier[]
				};

		// The bot's viewability, read while the stored state this event is about to replace still exists. It runs
		// before either write: once the row and its overwrite set have landed there is no way to read the state
		// they replaced, and reconstructing it in memory would be a second answer to the same question.
		const accessBefore = await this.startAccessTransition(
			channelId,
			description.channel.channelType,
			stored === null,
			reported
		);

		const written = await this.channelRegistry.upsertChannels([description.channel]);
		const isThread = isThreadChannelType(event.channelType);
		const overwriteResult = reported
			? await this.channelRegistry.replaceChannelOverwrites({
					guildId: this.guildId,
					channelId,
					overwrites: partition.storable
				})
			: null;
		const accessTransition = await this.completeAccessTransition(channelId, accessBefore);

		this.logger.info("guild-state channel registry applied a channel event", {
			guildId: this.guildId,
			channelId,
			isThread,
			created: stored === null,
			rowsWritten: written.rowsWritten + (overwriteResult?.overwritesWritten ?? 0),
			// Field names and counts only: a completed or pending field is a fact about the payload (R14).
			completedFieldCount: description.completedFields.length,
			pendingRestFields: reported ? [] : [PENDING_OVERWRITE_FIELD],
			overwriteSetReplaced: reported,
			droppedOverwriteTargetCount: partition.droppedTargetIds.length,
			// The access trigger, as ids and names: what the derivation decided, never the bitfields it decided on.
			botViewabilityBefore: accessTransition?.before ?? null,
			botViewabilityAfter: accessTransition?.after ?? null,
			viewabilityTransition: accessTransition?.transition ?? null,
			ingestibilityGained: accessTransition?.ingestibilityGained ?? false
		});
		if (partition.droppedTargetIds.length > 0) {
			this.logger.warn("guild-state channel registry dropped overwrite targets of an unknown kind", {
				guildId: this.guildId,
				channelId,
				droppedOverwriteTargetIds: partition.droppedTargetIds
			});
		}
		if (!reported) {
			this.logger.warn("guild-state channel registry left a channel's overwrite set untouched", {
				guildId: this.guildId,
				channelId,
				pendingRestFields: [PENDING_OVERWRITE_FIELD],
				reason: "payload-carried-no-overwrite-set"
			});
		}

		return {
			status: "applied",
			guildId: this.guildId,
			channelId,
			isThread,
			created: stored === null,
			rowsWritten: written.rowsWritten + (overwriteResult?.overwritesWritten ?? 0),
			overwriteSetReplaced: reported,
			overwritesWritten: overwriteResult?.overwritesWritten ?? 0,
			droppedOverwriteTargetIds: partition.droppedTargetIds,
			pendingRestFields: reported ? [] : [PENDING_OVERWRITE_FIELD],
			completedFields: description.completedFields,
			ingestibilityGained: accessTransition?.ingestibilityGained ?? false,
			accessTransition
		};
	};

	/**
	 * The trigger, first half (S1, S2, S3): whether this event is one worth evaluating, and the bot's viewability
	 * *before* the overwrite replacement lands. Nothing is read when nothing can have changed: an existing channel
	 * whose payload reported no overwrite set never reaches the read, and a channel type that carries no text
	 * never reaches it either — both are decisions, not omissions, and the outcome says `null` rather than
	 * inventing an `unchanged` nobody evaluated.
	 *
	 * This half must run before the write. Once the overwrite set is replaced, the "before" state is gone: there
	 * is no way to read it back, and reconstructing it in memory would be a second construction of the read model
	 * and therefore a second answer to the same question.
	 */
	private async startAccessTransition(
		channelId: DiscordIdentifier,
		channelType: NormalizedChannelType,
		created: boolean,
		reported: boolean
	): Promise<AccessTransitionStart | null> {
		const trigger = this.accessTrigger;
		if (trigger === null || !isTextCapableChannelType(channelType)) {
			return null;
		}
		// A payload that reported no overwrite set left the grants exactly as they were, and the row's own write
		// cannot add one: only the create path still has a transition to detect, from "no row" to the new row.
		if (!created && !reported) {
			return null;
		}

		// A channel the registry has never held had no stored state to view: the before-state is the derivation's
		// own `channel-not-registered` refusal, so no read can improve on it.
		const before = created ? false : await this.botCanViewChannel(trigger, channelId);
		return before === null ? null : { channelType, before };
	}

	/**
	 * The trigger, second half: the same decision from the state the write just left, and — when the pair is
	 * "cannot view → can view" on a text-capable channel — the outbound port (S1, S3).
	 */
	private async completeAccessTransition(
		channelId: DiscordIdentifier,
		start: AccessTransitionStart | null
	): Promise<ChannelAccessTransition | null> {
		const trigger = this.accessTrigger;
		if (start === null || trigger === null) {
			return null;
		}

		const after = await this.botCanViewChannel(trigger, channelId);
		if (after === null) {
			return null;
		}

		const transition = detectChannelAccessTransition({
			channelType: start.channelType,
			before: start.before,
			after
		});
		if (!transition.ingestibilityGained) {
			return transition;
		}

		this.logger.info("guild-state channel access trigger fired", {
			guildId: this.guildId,
			channelId,
			operation: "upsert-channel",
			channelType: start.channelType,
			transition: transition.transition
		});
		this.notifyIngestibilityGained(trigger, channelId);
		return transition;
	}

	/**
	 * The bot's own `view-channel` decision for one channel, read from one snapshot and decided by the registry's
	 * committed derivation (R12). `null` is "could not decide": the row was written either way, and a trigger
	 * that cannot be decided is not allowed to turn an applied event into a failed one (S3).
	 */
	private async botCanViewChannel(
		trigger: ChannelAccessTriggerDeps,
		channelId: DiscordIdentifier
	): Promise<boolean | null> {
		try {
			const snapshot = await trigger.snapshot.loadSnapshot({
				guildId: this.guildId,
				userId: trigger.botUserId,
				channelId
			});
			return grantsViewChannel(
				deriveEffectivePermissions({
					guildId: this.guildId,
					userId: trigger.botUserId,
					channelId,
					snapshot
				})
			);
		} catch (failure) {
			this.logger.warn("guild-state could not evaluate the bot's view access for a channel event", {
				guildId: this.guildId,
				channelId,
				operation: "upsert-channel",
				failure: failure instanceof Error ? failure.name : typeof failure
			});
			return null;
		}
	}

	/**
	 * Hand the gained transition to the outbound port. A listener that throws synchronously is reported and
	 * swallowed here, because the row is already written and the event that revealed the channel must not be
	 * failed by the consumer's own defect.
	 */
	private notifyIngestibilityGained(trigger: ChannelAccessTriggerDeps, channelId: DiscordIdentifier): void {
		try {
			trigger.channelsIngestibilityGained.onGained(channelId);
		} catch (failure) {
			this.logger.warn("guild-state channel access trigger listener failed", {
				guildId: this.guildId,
				channelId,
				operation: "upsert-channel",
				failure: failure instanceof Error ? failure.name : typeof failure
			});
		}
	}

	/** R1: named and counted, never stored — another Guild's channel has no row in this registry. */
	private dropForeignGuild(eventGuildId: DiscordIdentifier, channelId: DiscordIdentifier): UpsertChannelOutcome {
		this.logger.warn("guild-state dropped a channel event for another guild", {
			guildId: this.guildId,
			eventGuildId,
			channelId,
			operation: "upsert-channel"
		});
		return { status: "dropped", guildId: this.guildId, channelId, reason: "foreign-guild" };
	}

	/**
	 * R6's error case, returned rather than written: the event goes back to the caller for the anomaly path,
	 * which retries it once the parent is known. Nothing was stored, so nothing can be evaluated from it.
	 */
	private refuse(
		channelId: DiscordIdentifier,
		reason: ChannelDescriptionRefusalReason,
		parentChannelId: DiscordIdentifier | null
	): UpsertChannelOutcome {
		this.logger.warn("guild-state refused a channel event whose parent could not be resolved", {
			guildId: this.guildId,
			channelId,
			reason,
			parentChannelId
		});
		return { status: "refused", guildId: this.guildId, channelId, reason, parentChannelId };
	}

	/** The domain rule's view of the payload: the validated ids, and only the fields the event carried. */
	private toDescription(
		channelId: DiscordIdentifier,
		event: UpsertChannelEvent,
		parentChannelId: DiscordIdentifier | null | undefined
	): {
		channelId: DiscordIdentifier;
		channelType: NormalizedChannelType;
		name?: string;
		position?: number;
		parentChannelId?: DiscordIdentifier | null;
	} {
		return {
			channelId,
			channelType: event.channelType,
			...(event.name === undefined ? {} : { name: event.name }),
			...(event.position === undefined ? {} : { position: event.position }),
			...(parentChannelId === undefined ? {} : { parentChannelId })
		};
	}

	/** Whether the registry holds a row for that parent id: R6's "resolvable", asked of the owning repository. */
	private async isRegistered(parentChannelId: DiscordIdentifier): Promise<boolean> {
		return (await this.channelRegistry.findChannel(this.guildId, parentChannelId)) !== null;
	}

	/** `channel.parent_channel_id` is a `bigint` column or nothing: a non-id is refused, never guessed around. */
	private requireStorableParent(
		parentChannelId: DiscordIdentifier | null | undefined
	): DiscordIdentifier | null | undefined {
		if (parentChannelId === undefined || parentChannelId === null) {
			return parentChannelId;
		}
		return requireDiscordIdentifier("channel.parent_channel_id", parentChannelId);
	}

	/** `channel_position` is an `integer` column; a fractional or non-finite value is refused, not rounded (R6). */
	private requireStorablePosition(position: number | undefined): void {
		if (position === undefined || Number.isInteger(position)) {
			return;
		}
		throw new InvalidRegistryFieldValueError("channel.channel_position", "expected a whole number");
	}
}
