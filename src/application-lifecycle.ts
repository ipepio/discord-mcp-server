import type { OnApplicationBootstrap, BeforeApplicationShutdown } from "@nestjs/common";
import { DiscordEventKind } from "./features/discord/index.js";
import type { DiscordEventConsumer, DiscordEventSubscription } from "./features/discord/index.js";
import type { AppLogger } from "./shared/logging/logger.interface.js";

export interface ApplicationLifecycleDependencies {
	readonly connection: { start(): Promise<void> };
	readonly shutdown: { shutdown(): Promise<unknown> };
	readonly guildState: { subscribe(): void; unsubscribe(): void };
	readonly ingestion: { subscribe(): void; unsubscribe(): void };
	readonly events: DiscordEventConsumer;
	readonly history: { execute(input: { botUserId: string }): Promise<unknown> };
	/**
	 * guild-state's outbound access-trigger port, seen as the two lifecycle operations this class owns: the
	 * registry publishes a gained channel access, and the application decides who listens. Structural on purpose —
	 * the narrow `onGained` half belongs to the registry, and this half belongs to whoever is running the process.
	 */
	readonly accessGained: {
		bind(listener: (channelId: string) => void): void;
		unbind(): void;
	};
	/** ingestion's one-channel backfill: what a gained access starts, and never what the event waits on (S1, S5). */
	readonly accessBackfill: { execute(input: { channelId: string }): Promise<unknown> };
	readonly botUserId: string;
	readonly logger: AppLogger;
}

/** Construction is inert. Pool close stays with PgPoolShutdown.onApplicationShutdown, AFTER this drain.
 * Semantic-index owns its worker's onModuleInit / beforeApplicationShutdown hooks.
 */
export class ApplicationLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
	private importTrigger: DiscordEventSubscription | undefined;
	private importing = false;
	private stopping = false;
	public constructor(private readonly deps: ApplicationLifecycleDependencies) {}

	public async onApplicationBootstrap(): Promise<void> {
		// Consumers run in registration order: registry convergence precedes ingestion and initial import.
		this.deps.guildState.subscribe();
		this.deps.ingestion.subscribe();
		// The access trigger is bound, not called: the registry reports a gained channel access and this job starts.
		// Same rule as the import trigger below — the registry's event application must not wait for a history read,
		// so the listener schedules and returns, and the failure is logged here rather than thrown into a delivery.
		this.deps.accessGained.bind((channelId) => {
			if (this.stopping) return;
			void this.deps.accessBackfill.execute({ channelId }).catch(() => {
				this.deps.logger.error("Channel access backfill failed", {
					code: "access_backfill_failed",
					channelId
				});
			});
		});
		this.importTrigger = this.deps.events.subscribe(DiscordEventKind.resyncNeeded, () => {
			this.startHistoricalImport();
		});
		// R3's historical import is started by the process, not by the event that reports a reconnect. The
		// connection publishes `resyncNeeded` before this object subscribes to it, so waiting for that signal left the
		// import unstarted for a whole run — the durable import ledger stayed empty and the catch-up had nothing to
		// resume. It starts after ingestion's own subscription is registered, so the first page it reads cannot arrive
		// before the event consumer is listening.
		this.startHistoricalImport();
		await this.deps.connection.start();
	}

	/**
	 * One historical import at a time (R3). The bootstrap run and a reconnect-triggered run share this guard, so a
	 * `resyncNeeded` delivery that arrives while the import is walking starts nothing and waits for the next signal
	 * instead of racing the running job over the same channels: the import ledger's per-channel write is not a lock.
	 * The guard is released when the job settles, so a later reconnect can still run one.
	 */
	private startHistoricalImport(): void {
		if (this.importing || this.stopping) return;
		this.importing = true;
		// Do not return/await this job from the delivery callback: continuous delivery must proceed.
		void this.deps.history
			.execute({ botUserId: this.deps.botUserId })
			.catch(() => {
				this.deps.logger.error("Historical import failed", { code: "import_failed" });
			})
			.finally(() => {
				this.importing = false;
			});
	}

	public async beforeApplicationShutdown(): Promise<void> {
		this.stopping = true;
		try {
			// Existing Discord shutdown owns stop-intake, the bounded delivery drain, and socket close.
			await this.deps.shutdown.shutdown();
		} finally {
			this.importTrigger?.unsubscribe();
			// Unbound first: a channel that becomes readable during the drain schedules nothing new.
			this.deps.accessGained.unbind();
			this.deps.ingestion.unsubscribe();
			this.deps.guildState.unsubscribe();
		}
	}
}
