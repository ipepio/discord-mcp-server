import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { IngestionConfig } from "../config/ingestion-config.interface.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import type { MessageTombstoneWrite } from "../models/domain/message-records.js";
import { isForeignGuildRecord } from "../models/domain/message-rules.js";
import type { MessageStoreRepository } from "../repositories/message-store.repository.js";

/**
 * `MESSAGE_DELETE` and `MESSAGE_DELETE_BULK` applied to the message store (docs/features/ingestion.md R6, with
 * R7, R4 and R1; ADR-0007).
 *
 * One command serves both events because they are one fact: Discord says these ids are gone. A single deletion
 * is a list of one and a bulk deletion is a list of many, and the store's tombstone statement is the same
 * bounded, idempotent sweep either way — so nothing here needs to know which event arrived, and a bulk list
 * that overlaps a single deletion cannot double-count or double-write (R7).
 *
 * Three decisions belong to this command:
 *
 * - **R1.** An event naming another Guild is refused before any statement runs and returned as a dropped
 *   anomaly. A deletion is the most destructive call the store takes, so the scope check is the first
 *   statement-free thing that can do it.
 * - **R6 with ADR-0007.** The row survives and its content does not: id, author, both instants and `deleted_at`
 *   stay, text and attachment metadata go. That is the repository's statement, and the counts it reports are
 *   what this command returns — a deletion that could not count itself would not be provable.
 * - **R4's error case.** Deleting an id the store never ingested is a *counted no-op*: the ids come back in
 *   `unknownMessageIds`, are logged, and no tombstone row is invented for them. A hub that had never seen the
 *   message cannot mirror what it never stored, and a row created here would claim an ingestion that did not
 *   happen.
 *
 * `deletedAt` is the instant the hub observed the deletion (R6), taken from the injected clock so the tombstone
 * instant is a fact a test fixes rather than a wall-clock read; a replay keeps the first instant, which is the
 * repository's guard, not this command's memory.
 *
 * R12: ids, counts and the container the event named. Never content — a deletion is the one event whose whole
 * subject is text that no longer exists, and the log must not be where it survives.
 */

/** One deletion, single or bulk: the configured Guild, the container, and the ids Discord says are gone. */
export interface ApplyMessageDeletionEvent {
	/** The Guild the event came from. Anything other than the configured one is refused (R1). */
	readonly guildId: DiscordIdentifier;
	/** The channel or thread the event names: log attribution and the anomaly's location, never a write target. */
	readonly channelId: DiscordIdentifier;
	/**
	 * The ids this deletion covers, in Discord's own list for a bulk event. An empty list is a technical
	 * refusal, not a no-op: naming nothing means a payload field was lost, and a sweep that covers the Guild
	 * without naming a target is never what a deletion asked for (R6).
	 */
	readonly messageIds: readonly DiscordIdentifier[];
}

/** Where one deletion ended up. The three counts are the three different fates the ids can have (R6, R7). */
export type ApplyMessageDeletionOutcome =
	| {
			readonly status: "applied";
			readonly guildId: DiscordIdentifier;
			readonly channelId: DiscordIdentifier;
			/** How many ids the event named. */
			readonly requested: number;
			readonly messagesTombstoned: number;
			readonly attachmentsRemoved: number;
			/** Rows already tombstoned: a replay of the deletion changes nothing (R7). */
			readonly alreadyTombstoned: number;
			/** Ids the store never had: counted and named, never written into existence (R4). */
			readonly unknownMessageIds: readonly DiscordIdentifier[];
			readonly batches: number;
			readonly deletedAt: Date;
	  }
	| {
			readonly status: "dropped";
			readonly guildId: DiscordIdentifier;
			readonly channelId: DiscordIdentifier;
			readonly requested: number;
			readonly reason: "foreign-guild";
	  };

export interface ApplyMessageDeletionCommandDeps {
	readonly config: IngestionConfig;
	readonly messageStore: MessageStoreRepository;
	readonly logger: AppLogger;
	/** The instant the hub observed the deletion. Injected so a tombstone instant is deterministic. */
	readonly clock?: () => Date;
}

export class ApplyMessageDeletionCommand {
	private readonly guildId: DiscordIdentifier;

	private readonly messageStore: MessageStoreRepository;

	private readonly logger: AppLogger;

	private readonly clock: () => Date;

	public constructor(deps: ApplyMessageDeletionCommandDeps) {
		this.guildId = deps.config.guildId;
		this.messageStore = deps.messageStore;
		this.logger = deps.logger;
		this.clock = deps.clock ?? (() => new Date());
	}

	public readonly execute = async (event: ApplyMessageDeletionEvent): Promise<ApplyMessageDeletionOutcome> => {
		const requested = event.messageIds.length;

		if (isForeignGuildRecord(event.guildId, this.guildId)) {
			return this.dropForeignGuild(event.guildId, event.channelId, requested);
		}

		const channelId = requireDiscordIdentifier("message.channel_id", event.channelId);
		const deletedAt = this.clock();
		const tombstone: MessageTombstoneWrite = {
			guildId: this.guildId,
			// The ids are validated by the store's own rule on the way into the statement, which is also where an
			// empty list is refused: a deletion that names nothing has lost a payload field (R6).
			messageIds: event.messageIds.map((messageId) => requireDiscordIdentifier("message.message_id", messageId)),
			deletedAt
		};

		const outcome = await this.messageStore.tombstoneMessages(tombstone);

		this.logger.info("ingestion applied a message deletion", {
			guildId: this.guildId,
			channelId,
			// The ids the event named, which is everything R12 allows a deletion to say: an id is a fact about
			// addressing, and the text those ids used to carry is the one thing that must not appear here.
			messageIds: tombstone.messageIds,
			requested,
			messagesTombstoned: outcome.messagesTombstoned,
			attachmentsRemoved: outcome.attachmentsRemoved,
			alreadyTombstoned: outcome.alreadyTombstoned,
			unknownMessageCount: outcome.unknownMessageIds.length,
			batches: outcome.batches,
			deletedAt: deletedAt.toISOString(),
			outcome: this.reasonOf(outcome)
		});
		if (outcome.unknownMessageIds.length > 0) {
			// An id the store never ingested is an anomaly worth finding: it says an event arrived for a message
			// this hub did not store, which is either a gap in the import or a deletion in another channel (R4).
			this.logger.warn("ingestion tombstoned nothing for message ids the store never had", {
				guildId: this.guildId,
				channelId,
				unknownMessageIds: outcome.unknownMessageIds,
				reason: "message-never-ingested"
			});
		}

		return {
			status: "applied",
			guildId: this.guildId,
			channelId,
			requested,
			messagesTombstoned: outcome.messagesTombstoned,
			attachmentsRemoved: outcome.attachmentsRemoved,
			alreadyTombstoned: outcome.alreadyTombstoned,
			unknownMessageIds: outcome.unknownMessageIds,
			batches: outcome.batches,
			deletedAt
		};
	};

	/** R1: named and counted, never written — another Guild's messages are not this mirror's to delete. */
	private dropForeignGuild(
		eventGuildId: DiscordIdentifier,
		channelId: DiscordIdentifier,
		requested: number
	): ApplyMessageDeletionOutcome {
		this.logger.warn("ingestion dropped a message deletion for another guild", {
			guildId: this.guildId,
			eventGuildId,
			channelId,
			requested,
			operation: "apply-message-deletion"
		});
		return { status: "dropped", guildId: this.guildId, channelId, requested, reason: "foreign-guild" };
	}

	/** What the sweep actually did, as one word, so an anomaly is greppable without reading a single message. */
	private reasonOf(outcome: {
		messagesTombstoned: number;
		alreadyTombstoned: number;
		unknownMessageIds: readonly DiscordIdentifier[];
	}): string {
		if (outcome.messagesTombstoned > 0) {
			return "tombstoned";
		}
		if (outcome.alreadyTombstoned > 0) {
			return "unchanged-by-replay";
		}
		return outcome.unknownMessageIds.length > 0 ? "no-ingested-row-for-these-ids" : "nothing-to-do";
	}
}
