import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { IngestionConfig } from "../config/ingestion-config.interface.js";
import type { ChannelImportStatus } from "../models/domain/import-progress.js";
import { applyChannelImportAttempt, channelStatusForStopReason } from "../models/domain/import-progress.js";
import { nextAttemptInstant } from "../models/domain/catch-up-backoff.js";
import type { ImportWindow } from "../models/domain/import-window.js";
import { resolveImportCutoff } from "../models/domain/import-window.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import type { ImportProgressRepository } from "../repositories/import-progress.repository.js";
import type { BackfillChannelHistoryCommand } from "./backfill-channel-history.command.js";

/**
 * `CatchUpOutstandingChannelsCommand` — one bounded tick of R14's catch-up
 * (`odd/tasks/ingestion-catchup.md` T2 and T3; docs/features/ingestion.md R14).
 *
 * The rule this command exists for: closing a channel the bootstrap import deferred must not require an operator
 * restart. The 2026-11-13 run finished `incomplete` with 43 deferred channels and nothing in the runtime ever
 * retried them; the day-to-day answer is this job, and it is deliberately the smallest thing that can be one.
 *
 * One tick, in the order it happens:
 *
 * 1. **Read the outstanding page.** `outstanding(guildId, now, catchUpChannelsPerTick)` — the rows with work left
 *    and no pending backoff, oldest due first. The bound is the query's own `LIMIT`, declared before anything
 *    runs.
 * 2. **Walk each channel from its stored cursor**, through {@link BackfillChannelHistoryCommand} — the same walk
 *    the bootstrap import and R9's resync use — with `catchUpPagesPerChannelPerTick` as this tick's page bound.
 *    A channel whose tab is exhausted completes; one that hits the bound is `partial` at its new cursor; a rate
 *    limit or 5xx defers it at the cursor it already had.
 * 3. **Persist that channel's row** before the next channel starts, so a tick that dies halfway leaves the
 *    channels it finished recorded rather than replayed.
 * 4. **Schedule.** A deferred channel's `attempts` grows by one and its `nextAttemptAt` is the exponential backoff
 *    in `models/domain/catch-up-backoff.ts` (one minute doubling to an hour). Every other outcome resets both: a
 *    channel that advanced a page starts from the base wait again, a `skipped` one (4xx: permission gone or channel
 *    deleted) carries no delay so the next tick re-asks it, and a completed one is no longer selected at all.
 *
 * What it never does, and why:
 *
 * - **It walks no channel twice in one tick.** The page it walked comes from one read, so a channel it just
 *   deferred cannot be retried in the same tick — that is the bound S3 asks for, and it is structural.
 * - **It does not read message content.** Counts, ids and stop reasons only (R12).
 * - **It does not enumerate the registry or touch live ingestion.** R14's catch-up only continues a walk that
 *   has already stopped; R5's "the registry decides what is ingestible" is applied by the bootstrap import's
 *   pruning, which drops a row whose channel the registry no longer names.
 * - **It does not fail the tick over one channel.** A walk that throws something that is not Discord's named
 *   boundary failure is counted as failed, logged by id, and the tick continues: one channel's defect must not
 *   starve the rest of the page. The channel stays outstanding and is retried on a later tick.
 */

/** What one tick did, as counts and ids only. */
export interface CatchUpTickResult {
	/** Rows the tick's read returned: the channels it was willing to walk. */
	readonly channelsConsidered: number;
	readonly channelsCompleted: number;
	readonly channelsDeferred: number;
	readonly channelsSkipped: number;
	readonly channelsPartial: number;
	/** Channels whose walk threw something this command does not classify. */
	readonly channelsFailed: number;
	readonly pagesRead: number;
	readonly messagesStored: number;
	readonly messagesUnchanged: number;
	/** When this tick started: the instant its backoff deadlines are measured from. */
	readonly startedInstant: Date;
}

export interface CatchUpOutstandingChannelsDeps {
	readonly config: IngestionConfig;
	readonly progress: ImportProgressRepository;
	readonly backfill: BackfillChannelHistoryCommand;
	readonly logger: AppLogger;
	/** Injectable clock, so "due now" and the backoff are facts of the run rather than of the wall clock. */
	readonly clock?: () => Date;
}

export class CatchUpOutstandingChannelsCommand {
	private readonly guildId: DiscordIdentifier;

	private readonly window: ImportWindow;

	private readonly channelsPerTick: number;

	private readonly pagesPerChannelPerTick: number;

	private readonly progress: ImportProgressRepository;

	private readonly backfill: BackfillChannelHistoryCommand;

	private readonly logger: AppLogger;

	private readonly clock: () => Date;

	public constructor(deps: CatchUpOutstandingChannelsDeps) {
		this.guildId = deps.config.guildId;
		this.window = deps.config.importWindow;
		this.channelsPerTick = deps.config.catchUpChannelsPerTick;
		this.pagesPerChannelPerTick = deps.config.catchUpPagesPerChannelPerTick;
		this.progress = deps.progress;
		this.backfill = deps.backfill;
		this.logger = deps.logger;
		this.clock = deps.clock ?? (() => new Date());
	}

	public readonly execute = async (): Promise<CatchUpTickResult> => {
		const startedInstant = this.clock();
		// The window is R3's, measured from this tick: a `days` import admits exactly what a first import would have
		// admitted at this instant, and a `full` one has no lower bound at all.
		const cutoffInstant = resolveImportCutoff(this.window, startedInstant);
		const outstanding = await this.progress.outstanding(this.guildId, startedInstant, this.channelsPerTick);

		const totals = {
			channelsCompleted: 0,
			channelsDeferred: 0,
			channelsSkipped: 0,
			channelsPartial: 0,
			channelsFailed: 0,
			pagesRead: 0,
			messagesStored: 0,
			messagesUnchanged: 0
		};
		const consideredChannelIds: DiscordIdentifier[] = [];
		const failedChannelIds: DiscordIdentifier[] = [];

		for (const entry of outstanding) {
			consideredChannelIds.push(entry.channelId);

			try {
				const walked = await this.backfill.execute({
					channelId: entry.channelId,
					cutoffInstant,
					resumeBeforeId: entry.nextBeforeId,
					maxPages: this.pagesPerChannelPerTick
				});
				const status = channelStatusForStopReason(walked.stop);
				const progress = applyChannelImportAttempt({
					previous: entry,
					channelId: walked.channelId,
					stopReason: walked.stop,
					restFailureReason: walked.failure?.restReason ?? null,
					nextBeforeId: walked.nextBeforeId,
					counts: walked,
					scheduling: schedulingFor(status, entry.attempts, startedInstant)
				});

				await this.progress.saveAll(this.guildId, [progress]);

				totals.pagesRead += walked.pagesRead;
				totals.messagesStored += walked.messagesStored;
				totals.messagesUnchanged += walked.messagesUnchanged;
				countStatus(totals, status);
			} catch {
				// Never the exception itself: a PostgreSQL failure carries its statement and parameters, and a payload
				// error can carry a fragment. The id and the count are what an operator acts on.
				failedChannelIds.push(entry.channelId);
				totals.channelsFailed += 1;
			}
		}

		const result: CatchUpTickResult = {
			channelsConsidered: consideredChannelIds.length,
			...totals,
			startedInstant
		};

		// R12: one line per tick, ids and counts. Which channels were considered and which failed, never a message.
		this.logger.info("ingestion ran a history import catch-up tick", {
			guildId: this.guildId,
			operation: "ingestion-catch-up",
			mode: this.window.mode,
			...(this.window.mode === "days" ? { importDays: this.window.days } : {}),
			cutoffInstant: cutoffInstant?.toISOString() ?? null,
			channelIds: consideredChannelIds,
			failedChannelIds,
			...result,
			startedInstant: startedInstant.toISOString()
		});

		return result;
	};
}

/**
 * T3's policy in one place: only a deferral backs off, and a deferral always backs off. `attempts` is the
 * consecutive count, which is why the exponent here is the already-incremented value — the first deferral waits
 * the base minute, the second two minutes, and so on to the ceiling.
 */
function schedulingFor(
	status: ChannelImportStatus,
	previousAttempts: number,
	now: Date
): { readonly attempts: number; readonly nextAttemptAt: Date | null } {
	if (status !== "deferred") {
		return { attempts: 0, nextAttemptAt: null };
	}

	const attempts = previousAttempts + 1;
	return { attempts, nextAttemptAt: nextAttemptInstant(attempts, now) };
}

function countStatus(
	totals: {
		channelsCompleted: number;
		channelsDeferred: number;
		channelsSkipped: number;
		channelsPartial: number;
	},
	status: ChannelImportStatus
): void {
	switch (status) {
		case "complete":
			totals.channelsCompleted += 1;
			return;
		case "deferred":
			totals.channelsDeferred += 1;
			return;
		case "skipped":
			totals.channelsSkipped += 1;
			return;
		case "partial":
		case "in-progress":
			totals.channelsPartial += 1;
			return;
	}
}
