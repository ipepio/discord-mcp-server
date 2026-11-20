import type { AppLogger } from "../../shared/logging/logger.interface.js";
import type { IngestionConfig } from "./config/ingestion-config.interface.js";
import type {
	CatchUpOutstandingChannelsCommand,
	CatchUpTickResult
} from "./commands/catch-up-outstanding-channels.command.js";

/**
 * R14's scheduler (`odd/tasks/ingestion-catchup.md` T2; docs/features/ingestion.md R14).
 *
 * The rule it serves: closing a channel the bootstrap import deferred must not require an operator restart. This
 * class is only the clock — every decision (which channels, how many pages, how long to wait after a deferral) is
 * {@link CatchUpOutstandingChannelsCommand}'s, and the walk is R3's. It exists as a separate object for the reason
 * `EmbeddingPipelineWorker` does: a periodic job needs an owner of its timer, its serialization and its shutdown,
 * and mixing that with the work is how a job starts running twice.
 *
 * The three properties copied from the embedding worker on purpose, because they are what makes a background job
 * behave in this process:
 *
 * - **One tick at a time.** The next timer is armed only after the current tick finished, so a slow tick delays
 *   the next one instead of overlapping it. Two overlapping ticks would walk the same channel twice from the same
 *   cursor — wasteful, and (R7) harmless but pointless.
 * - **`unref()`.** The timer never keeps the process alive on its own; the Gateway connection and the HTTP server
 *   do that, and a hub asked to stop must not be held open by a scheduled retry.
 * - **`beforeApplicationShutdown` stops and awaits.** It runs before the pool closes (`PgPoolShutdown`), so a tick
 *   in flight finishes its statements instead of being cut off with the connection.
 *
 * Disableability is configuration, not a code path: `INGESTION_CATCH_UP_ENABLED=false` means `onModuleInit` never
 * arms a timer and the worker is inert for the life of the process (`odd/tasks/ingestion-catchup.md` T2).
 *
 * R12: this class logs nothing at all. A tick's ids and counts are the command's line; a failure is logged here
 * without the exception, because a database error can carry its statement and parameters.
 */
export class IngestionCatchUpWorker {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private active: Promise<void> | undefined;
	private stopped = true;

	public constructor(
		private readonly command: CatchUpOutstandingChannelsCommand,
		private readonly config: IngestionConfig,
		private readonly logger: AppLogger
	) {}

	public onModuleInit(): void {
		if (!this.config.catchUpEnabled) return;
		this.stopped = false;
		this.schedule(0);
	}

	// Runs before PgPoolShutdown.onApplicationShutdown, irrespective of module traversal order.
	public async beforeApplicationShutdown(): Promise<void> {
		this.stopped = true;
		if (this.timer !== undefined) clearTimeout(this.timer);
		await this.active;
	}

	/**
	 * One tick, as the worker runs it: the unit a test drives without waiting for a timer, and the same call the
	 * scheduled tick makes. Public because "run one bounded tick now" is an operation an operator or a test may
	 * want, and hiding it behind a timer would make the rule untestable without fake clocks.
	 */
	public readonly runTick = (): Promise<CatchUpTickResult> => this.command.execute();

	private schedule(delay: number): void {
		if (this.stopped) return;
		this.timer = setTimeout(() => {
			this.active = this.tick();
		}, delay);
		this.timer.unref();
	}

	private async tick(): Promise<void> {
		try {
			await this.command.execute();
		} catch {
			// Database exceptions can contain SQL parameters: never log the exception.
			this.logger.warn("Ingestion catch-up tick stopped after a failure", {
				code: "ingestion_catch_up_failed"
			});
		}
		this.schedule(this.config.catchUpIntervalMs);
	}
}
