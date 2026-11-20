import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { ListIngestibleChannelsResult } from "../../guild-state/index.js";
import type { IngestionConfig } from "../config/ingestion-config.interface.js";
import type { IngestibleChannelRegistry } from "../gateways/channel-registry-gateway.interface.js";
import type { BackfillChannelHistoryResult, ChannelHistoryFailure } from "./backfill-channel-history.command.js";
import type { BackfillChannelHistoryCommand } from "./backfill-channel-history.command.js";
import type { ChannelHistoryStopReason } from "../models/domain/history-walk-rules.js";
import type {
	ChannelImportProgress,
	ChannelImportStatus,
	ImportProgressLedger
} from "../models/domain/import-progress.js";
import {
	channelStatusForStopReason,
	applyChannelImportAttempt,
	outstandingChannelIds
} from "../models/domain/import-progress.js";
import { InMemoryImportProgressLedger } from "../progress/in-memory-import-progress.js";
import type { ImportProgressRepository } from "../repositories/import-progress.repository.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import type { ImportMode, ImportWindow } from "../models/domain/import-window.js";
import { resolveImportCutoff } from "../models/domain/import-window.js";
import type { RegistryConsumptionBlockReason } from "../models/domain/registry-consumption-rules.js";
import { registryConsumptionBlockReason } from "../models/domain/registry-consumption-rules.js";

/**
 * `ImportChannelHistoryCommand` — the historical import (docs/features/ingestion.md R3, applied through R7 and
 * R8, on the channels R2 makes readable).
 *
 * The command is the guild-wide orchestration, and it is deliberately thin: it decides **which channels** are
 * imported, **how far each one's window reaches**, **what has already been done**, and **whether the Guild may
 * be called imported**. The reading, filtering and writing of pages is
 * {@link BackfillChannelHistoryCommand}, the same walk R9's gap backfill runs, so there is exactly one copy of
 * the paging and boundary rules.
 *
 * The four R3 clauses, and where each lives here:
 *
 * - **The window.** `IMPORT_MODE=full` has no lower bound; `IMPORT_MODE=days` admits only messages strictly
 *   after `(import start − IMPORT_DAYS days)`, computed once from the injected clock before the first page of
 *   the run. An excluded message is counted (`messagesOutsideWindow`), never quietly dropped.
 * - **Resumable, not repeated.** Each channel's cursor and status live in the durable ledger
 *   (`import_channel_progress`, R14). A channel already `complete` is not read again — a re-run of a finished
 *   import, or a restart of the process, costs zero history reads and zero writes for it — and a channel that
 *   stopped at its page bound, at a rate limit or at a 4xx is resumed from its stored cursor. The counts a
 *   resumed run reports are that run's own; the ledger carries the cumulative totals.
 *   The ledger is loaded once before the first channel and written once per channel afterwards, never per page:
 *   this command is R3's one long run, and R14's periodic catch-up is what keeps a deferred channel moving
 *   without another restart.
 * - **Progress in structured logs**, per page (in the walk) and per channel here, as ids and counts only (R12).
 * - **Parallel with continuous sync, and never against it.** Nothing here reads a stored row to ask whether it
 *   is current: R7's idempotent upsert and R8's edited-instant guard are the store's, so a page that overlaps
 *   the event stream is a no-op and a late backfill record cannot overwrite a newer edit.
 *
 * R2 is obeyed before any read: a registry that cannot state the bot's Membership or hold a single text-capable
 * row is not consumed as authoritative, and this run reports itself `refused` without touching Discord or the
 * store. A 4xx skips one channel with its reason logged and the run continues; a rate limit or 5xx (after the
 * adapter's bounded retries) defers one channel at its cursor; neither is reported as completion, and the
 * report says which is which.
 */

/** What the import needs to know whose registry visibility is being computed. */
export interface ImportChannelHistoryInput {
	/**
	 * The bot's own Membership id, which the registry computes ingestibility for. It is an input fact rather
	 * than configuration because the spec declares no variable for it: the composition learns the bot's id from
	 * its own connection state (docs/features/discord.md R5), and `ListIngestibleChannelsQuery` requires it
	 * (guild-state R4).
	 */
	readonly botUserId: DiscordIdentifier;
}

/** One channel's outcome of this run, and the state it left behind. */ export interface ChannelImportReport {
	readonly channelId: DiscordIdentifier;
	/** Where the channel stands after this run. `complete` is the only value that means "no work left". */
	readonly status: ChannelImportStatus;
	/** False when the channel was already complete and this run read nothing for it. */
	readonly attempted: boolean;
	readonly resumedFromCursor: boolean;
	readonly pagesRead: number;
	readonly messagesStored: number;
	readonly messagesUnchanged: number;
	readonly messagesOutsideWindow: number;
	readonly replyReferencesDropped: number;
	readonly attachmentsWritten: number;
	readonly attachmentsRemoved: number;
	readonly stopReason: ChannelHistoryStopReason | null;
	readonly failure: ChannelHistoryFailure | null;
}

/** The whole run's counts. Every number is a count of rows, pages or channels — never content (R12). */
export interface ImportRunTotals {
	readonly channelsAttempted: number;
	readonly channelsCompleted: number;
	readonly channelsSkipped: number;
	readonly channelsDeferred: number;
	readonly channelsPartial: number;
	readonly channelsUntouched: number;
	readonly pagesRead: number;
	readonly messagesStored: number;
	readonly messagesUnchanged: number;
	readonly messagesOutsideWindow: number;
	readonly replyReferencesDropped: number;
	readonly attachmentsWritten: number;
	readonly attachmentsRemoved: number;
}

/** What the registry said, kept in the report because R2 makes those facts part of the answer. */
export interface ImportRegistryFacts {
	readonly ingestibleChannelCount: number;
	readonly botCannotViewChannelCount: number;
	readonly registeredTextCapableCount: number;
	readonly botMembershipRegistered: boolean;
}

export type ImportChannelHistoryResult =
	| {
			readonly status: "refused";
			readonly guildId: DiscordIdentifier;
			readonly startedInstant: Date;
			readonly botUserId: DiscordIdentifier;
			readonly mode: ImportMode;
			readonly cutoffInstant: Date | null;
			readonly reason: RegistryConsumptionBlockReason;
			readonly registry: ImportRegistryFacts;
	  }
	| {
			readonly status: "complete" | "incomplete";
			readonly guildId: DiscordIdentifier;
			readonly startedInstant: Date;
			readonly botUserId: DiscordIdentifier;
			readonly mode: ImportMode;
			readonly cutoffInstant: Date | null;
			readonly registry: ImportRegistryFacts;
			readonly channels: readonly ChannelImportReport[];
			readonly totals: ImportRunTotals;
			/** Ledger entries dropped because the registry no longer names their channel (R2, R6). */
			readonly prunedChannelCount: number;
	  };

export interface ImportChannelHistoryDeps {
	readonly config: IngestionConfig;
	readonly channels: IngestibleChannelRegistry;
	readonly backfill: BackfillChannelHistoryCommand;
	/** The durable ledger (R14). The command keeps its in-run state in an `ImportProgressLedger` it loads from
	 * here and writes back to, once per channel. */
	readonly progress: ImportProgressRepository;
	readonly logger: AppLogger;
	/** Injectable clock, so a `days` window's cutoff is a fact of the run rather than of the wall clock. */
	readonly clock?: () => Date;
}

export class ImportChannelHistoryCommand {
	private readonly guildId: DiscordIdentifier;

	private readonly window: ImportWindow;

	private readonly channels: IngestibleChannelRegistry;

	private readonly backfill: BackfillChannelHistoryCommand;

	private readonly progress: ImportProgressRepository;

	private readonly logger: AppLogger;

	private readonly clock: () => Date;

	public constructor(deps: ImportChannelHistoryDeps) {
		this.guildId = deps.config.guildId;
		this.window = deps.config.importWindow;
		this.channels = deps.channels;
		this.backfill = deps.backfill;
		this.progress = deps.progress;
		this.logger = deps.logger;
		this.clock = deps.clock ?? (() => new Date());
	}

	public readonly execute = async (input: ImportChannelHistoryInput): Promise<ImportChannelHistoryResult> => {
		const botUserId = requireDiscordIdentifier("guild_membership.user_id", input.botUserId);
		const startedInstant = this.clock();
		const cutoffInstant = resolveImportCutoff(this.window, startedInstant);

		const listed = await this.channels.execute({ botUserId });
		const registry = this.toRegistryFacts(listed);

		const blocked = registryConsumptionBlockReason(listed);
		if (blocked !== null) {
			// R2: a registry that cannot answer either question is not a basis for an import claim. Nothing was
			// read from Discord and nothing was written, and the run says so by name.
			this.logger.warn("ingestion refused a historical import over a partial channel registry", {
				guildId: this.guildId,
				botUserId,
				operation: "import-channel-history",
				reason: blocked,
				...registry
			});

			return {
				status: "refused",
				guildId: this.guildId,
				startedInstant,
				botUserId,
				mode: this.window.mode,
				cutoffInstant,
				reason: blocked,
				registry
			};
		}

		const ingestibleChannelIds = listed.channels.map((channel) => channel.channelId);
		// R14: the source of truth is the table, loaded once. A restart finds the cursors a previous process left and
		// a completed channel costs one row read instead of a re-walk of its whole history.
		const ledger = await this.loadLedger();
		this.logger.info("ingestion started a historical import", {
			guildId: this.guildId,
			botUserId,
			operation: "import-channel-history",
			mode: this.window.mode,
			...(this.window.mode === "days" ? { importDays: this.window.days } : {}),
			cutoffInstant: cutoffInstant?.toISOString() ?? null,
			ledgerChannelCount: ledger.snapshot().length,
			...registry
		});

		const channels: ChannelImportReport[] = [];

		for (const channelId of ingestibleChannelIds) {
			channels.push(await this.importChannel(channelId, cutoffInstant, ledger));
		}

		const prunedChannelCount = await this.forgetMissingChannels(ingestibleChannelIds, ledger);
		const outstanding = outstandingChannelIds(ingestibleChannelIds, ledger);
		const totals = this.summarize(channels);
		const status = outstanding.length === 0 ? "complete" : "incomplete";

		// R3: completion is claimed here and only here, from the registry's own channel set against the ledger.
		this.logger[status === "complete" ? "info" : "warn"]("ingestion finished a historical import", {
			guildId: this.guildId,
			botUserId,
			operation: "import-channel-history",
			status,
			outstandingChannelCount: outstanding.length,
			...registry,
			...totals
		});

		return {
			status,
			guildId: this.guildId,
			startedInstant,
			botUserId,
			mode: this.window.mode,
			cutoffInstant,
			registry,
			channels: Object.freeze(channels),
			totals,
			prunedChannelCount
		};
	};

	/**
	 * The in-run ledger, built from the durable one. `models/domain/import-progress.ts` states the split: the table
	 * is the source of truth between runs, and this shape is what one run reads, updates and reports from.
	 */
	private async loadLedger(): Promise<ImportProgressLedger> {
		const loaded = await this.progress.loadAll(this.guildId);
		const ledger = new InMemoryImportProgressLedger();
		for (const entry of loaded) {
			ledger.record(entry);
		}
		return ledger;
	}

	/**
	 * One channel: skip it if the ledger says it is done, otherwise walk it from the cursor the last attempt
	 * left, record what this attempt reached, and persist that channel's row before the next channel starts.
	 */
	private async importChannel(
		channelId: DiscordIdentifier,
		cutoffInstant: Date | null,
		ledger: ImportProgressLedger
	): Promise<ChannelImportReport> {
		const previous = ledger.progressFor(channelId);

		if (previous !== null && previous.status === "complete") {
			// R3's resume without duplicating: a finished channel is not read again in this process, so a re-run
			// of a completed import spends zero history pages and zero writes.
			return {
				channelId,
				status: "complete",
				attempted: false,
				resumedFromCursor: false,
				pagesRead: 0,
				messagesStored: 0,
				messagesUnchanged: 0,
				messagesOutsideWindow: 0,
				replyReferencesDropped: 0,
				attachmentsWritten: 0,
				attachmentsRemoved: 0,
				stopReason: previous.stopReason,
				failure: null
			};
		}

		const walked = await this.backfill.execute({
			channelId,
			cutoffInstant,
			resumeBeforeId: previous?.nextBeforeId ?? null
		});
		const status = channelStatusForStopReason(walked.stop);
		const resumedFromCursor = walked.resumedFromCursor;

		// A bounded write: one row per channel, after its walk stopped. Pages never write the ledger.
		const progress = this.toProgress(previous, walked);
		await this.progress.saveAll(this.guildId, [progress]);
		ledger.record(progress);

		this.logger.info("ingestion closed a channel history import attempt", {
			guildId: this.guildId,
			channelId,
			operation: "import-channel-history",
			status,
			stopReason: walked.stop,
			resumedFromCursor,
			pagesRead: walked.pagesRead,
			messagesStored: walked.messagesStored,
			messagesUnchanged: walked.messagesUnchanged,
			messagesOutsideWindow: walked.messagesOutsideWindow,
			cursorBeforeId: walked.nextBeforeId,
			// R3's logged reason for a skip or a defer: the boundary cause, its status and its attempt bound.
			restFailure: walked.failure?.restReason ?? null,
			httpStatus: walked.failure?.httpStatus ?? null,
			attempts: walked.failure?.attempts ?? null
		});

		return {
			channelId,
			status,
			attempted: true,
			resumedFromCursor,
			pagesRead: walked.pagesRead,
			messagesStored: walked.messagesStored,
			messagesUnchanged: walked.messagesUnchanged,
			messagesOutsideWindow: walked.messagesOutsideWindow,
			replyReferencesDropped: walked.replyReferencesDropped,
			attachmentsWritten: walked.attachmentsWritten,
			attachmentsRemoved: walked.attachmentsRemoved,
			stopReason: walked.stop,
			failure: walked.failure
		};
	}

	/**
	 * Cumulative ledger state: the stored row's counts plus what this run did. The catch-up's two scheduling facts
	 * (`attempts`, `nextAttemptAt`) are reset here: the bootstrap import attempts every outstanding channel once and
	 * leaves no backoff behind, so a restart is an immediate retry of exactly this run's outcomes.
	 */
	private toProgress(
		previous: ChannelImportProgress | null,
		walked: BackfillChannelHistoryResult
	): ChannelImportProgress {
		return applyChannelImportAttempt({
			previous,
			channelId: walked.channelId,
			stopReason: walked.stop,
			restFailureReason: walked.failure?.restReason ?? null,
			nextBeforeId: walked.nextBeforeId,
			counts: walked,
			scheduling: { attempts: 0, nextAttemptAt: null }
		});
	}

	/**
	 * R2 with R6: a channel the registry no longer names cannot be imported, and its cursor would otherwise sit
	 * in the ledger for the life of the process. Its messages are the exclusion command's business, not this
	 * ledger's; only the stale bookkeeping is dropped here.
	 */
	private async forgetMissingChannels(
		ingestibleChannelIds: readonly DiscordIdentifier[],
		ledger: ImportProgressLedger
	): Promise<number> {
		const stillListed = new Set(ingestibleChannelIds);
		const missing = ledger
			.snapshot()
			.map((entry) => entry.channelId)
			.filter((channelId) => !stillListed.has(channelId));

		if (missing.length === 0) return 0;

		// The durable half of `forget`: a row for a channel the registry no longer names would be walked by the
		// catch-up forever, because nothing else ever revisits a ledger row.
		const pruned = await this.progress.forgetChannels(this.guildId, missing);

		this.logger.info("ingestion dropped import progress for channels no longer registered", {
			guildId: this.guildId,
			operation: "import-channel-history",
			prunedChannelCount: pruned
		});

		return pruned;
	}

	private summarize(channels: readonly ChannelImportReport[]): ImportRunTotals {
		// A mutable accumulator of the same shape as the reported totals: the counts are summed here and handed
		// out as one immutable fact, so no caller can adjust a run's totals after it finished.
		const totals: { -readonly [Key in keyof ImportRunTotals]: number } = {
			channelsAttempted: 0,
			channelsCompleted: 0,
			channelsSkipped: 0,
			channelsDeferred: 0,
			channelsPartial: 0,
			channelsUntouched: 0,
			pagesRead: 0,
			messagesStored: 0,
			messagesUnchanged: 0,
			messagesOutsideWindow: 0,
			replyReferencesDropped: 0,
			attachmentsWritten: 0,
			attachmentsRemoved: 0
		};

		for (const channel of channels) {
			totals.pagesRead += channel.pagesRead;
			totals.messagesStored += channel.messagesStored;
			totals.messagesUnchanged += channel.messagesUnchanged;
			totals.messagesOutsideWindow += channel.messagesOutsideWindow;
			totals.replyReferencesDropped += channel.replyReferencesDropped;
			totals.attachmentsWritten += channel.attachmentsWritten;
			totals.attachmentsRemoved += channel.attachmentsRemoved;

			if (!channel.attempted) {
				totals.channelsUntouched += 1;
				continue;
			}

			totals.channelsAttempted += 1;
			switch (channel.status) {
				case "complete":
					totals.channelsCompleted += 1;
					break;
				case "skipped":
					totals.channelsSkipped += 1;
					break;
				case "deferred":
					totals.channelsDeferred += 1;
					break;
				case "partial":
				case "in-progress":
					totals.channelsPartial += 1;
					break;
			}
		}

		return totals;
	}

	/**
	 * The registry's distinct facts, kept distinct. `registeredTextCapableCount` is the denominator that tells a
	 * reader whether an empty ingestible set meant "the bot can view nothing" or "the registry holds nothing" —
	 * R2's two absences, which no count here is allowed to merge.
	 */
	private toRegistryFacts(listed: ListIngestibleChannelsResult): ImportRegistryFacts {
		return {
			ingestibleChannelCount: listed.channels.length,
			botCannotViewChannelCount: listed.botCannotViewChannelIds.length,
			registeredTextCapableCount: listed.registeredTextCapableCount,
			botMembershipRegistered: listed.botMembershipRegistered
		};
	}
}
