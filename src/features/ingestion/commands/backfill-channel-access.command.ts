import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { IngestionConfig } from "../config/ingestion-config.interface.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import type { ImportWindow } from "../models/domain/import-window.js";
import { resolveImportCutoff } from "../models/domain/import-window.js";
import type {
	BackfillChannelHistoryCommand,
	BackfillChannelHistoryResult
} from "./backfill-channel-history.command.js";

/**
 * `BackfillChannelAccessCommand` — the one-channel backfill a gained channel access starts
 * (`odd/tasks/ingestion-channel-access-trigger.md` S1, S4, S5).
 *
 * guild-state detects the trigger (a channel whose bot viewability just turned from not-viewable to viewable)
 * and reports it through its outbound port; this command is what the composition wires to that port. It exists
 * as its own command rather than as a call into `ImportChannelHistoryCommand` because the two runs differ in
 * exactly the way this file states and in nothing else:
 *
 * - **Which channels.** The import enumerates the whole registry and decides per channel from its ledger. This
 *   one channel is already named by the fact that triggered it, and it must not re-walk the others (S1: "without
 *   re-walking already-imported channels"). Enumerating the registry here would also make the trigger depend on
 *   a wide scan whose answer could lag the very event that produced it.
 * - **The window.** Identical, and shared rather than restated: {@link resolveImportCutoff} over the same
 *   `IMPORT_MODE`/`IMPORT_DAYS` configuration the bootstrap import uses, measured from this run's own start. A
 *   `days` window therefore admits exactly what a first import would have admitted had the channel been
 *   readable then, and a `full` window admits everything retrievable — S1's "same window rules as the bootstrap
 *   import".
 * - **What runs.** {@link BackfillChannelHistoryCommand}, unchanged: the same bounded pages, the same six stop
 *   reasons, the same idempotent guarded batch write, so R7/R8 apply to this path because it *is* that path.
 *
 * S4 is the store's, not this command's: applying the same page twice stores 0 and counts the rows unchanged, so
 * a duplicated event, a re-sent update or an operator re-running the job costs no duplicate row. Nothing here
 * keeps its own cursor or "already done" flag — a second trigger on a channel that is already converged is a
 * cheap no-op read, which is the honest bound for a job that is started by an event.
 *
 * S5: the caller schedules this and does not await the event application on it (`application-lifecycle.ts`
 * binds the port that way). The walk itself is bounded by `config.history.maxPagesPerChannel`, and every log
 * line carries the guild id, the channel id, page numbers and counts — never message content (R12).
 */

/** The channel a gained-access trigger names. */
export interface BackfillChannelAccessInput {
	readonly channelId: DiscordIdentifier;
}

/** What one triggered backfill did. */
export interface BackfillChannelAccessResult {
	readonly guildId: DiscordIdentifier;
	readonly channelId: DiscordIdentifier;
	/** When this run started: the instant the window's lower bound is measured from, exactly as R3 states. */
	readonly startedInstant: Date;
	/** `null` for a `full` window; the `days` bound otherwise. */
	readonly cutoffInstant: Date | null;
	readonly mode: ImportWindow["mode"];
	/** The walk's own report: stop reason, pages read, rows stored and unchanged, and the cursor it reached. */
	readonly walk: BackfillChannelHistoryResult;
}

export interface BackfillChannelAccessDeps {
	readonly config: IngestionConfig;
	readonly backfill: BackfillChannelHistoryCommand;
	readonly logger: AppLogger;
	/** Injectable clock, so a `days` window's cutoff is a fact of the run rather than of the wall clock. */
	readonly clock?: () => Date;
}

export class BackfillChannelAccessCommand {
	private readonly guildId: DiscordIdentifier;

	private readonly window: ImportWindow;

	private readonly backfill: BackfillChannelHistoryCommand;

	private readonly logger: AppLogger;

	private readonly clock: () => Date;

	public constructor(deps: BackfillChannelAccessDeps) {
		this.guildId = deps.config.guildId;
		this.window = deps.config.importWindow;
		this.backfill = deps.backfill;
		this.logger = deps.logger;
		this.clock = deps.clock ?? (() => new Date());
	}

	public readonly execute = async (input: BackfillChannelAccessInput): Promise<BackfillChannelAccessResult> => {
		const channelId = requireDiscordIdentifier("message.channel_id", input.channelId);
		const startedInstant = this.clock();
		const cutoffInstant = resolveImportCutoff(this.window, startedInstant);

		// R12: ids, the window and its bound. The reason this walk exists is a permission fact, and a permission
		// fact is never a message, a filename or a name.
		this.logger.info("ingestion started a channel access backfill", {
			guildId: this.guildId,
			channelId,
			operation: "backfill-channel-access",
			mode: this.window.mode,
			...(this.window.mode === "days" ? { importDays: this.window.days } : {}),
			cutoffInstant: cutoffInstant?.toISOString() ?? null
		});

		// A triggered backfill begins at the channel's newest message: there is no cursor to resume, because the
		// channel could not be read a moment ago. The store's guard (R7, R8) is what makes the replay inert.
		const walk = await this.backfill.execute({ channelId, cutoffInstant, resumeBeforeId: null });

		this.logger[walk.stop === "history-exhausted" ? "info" : "warn"]("ingestion closed a channel access backfill", {
			guildId: this.guildId,
			channelId,
			operation: "backfill-channel-access",
			stopReason: walk.stop,
			pagesRead: walk.pagesRead,
			messagesStored: walk.messagesStored,
			messagesUnchanged: walk.messagesUnchanged,
			messagesOutsideWindow: walk.messagesOutsideWindow,
			attachmentsWritten: walk.attachmentsWritten,
			cursorBeforeId: walk.nextBeforeId,
			restFailure: walk.failure?.restReason ?? null,
			httpStatus: walk.failure?.httpStatus ?? null,
			attempts: walk.failure?.attempts ?? null
		});

		return {
			guildId: this.guildId,
			channelId,
			startedInstant,
			cutoffInstant,
			mode: this.window.mode,
			walk
		};
	};
}
