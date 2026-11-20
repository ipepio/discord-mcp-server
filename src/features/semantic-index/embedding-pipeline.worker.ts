import type { AppLogger } from "../../shared/logging/logger.interface.js";
import type { EmbedPendingMessagesCommand } from "./commands/embed-pending-messages.command.js";

/** One serial batch at a time. Capacity is 64 messages per batch; idle lag <= 1s plus provider latency. */
export class EmbeddingPipelineWorker {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private active: Promise<void> | undefined;
	private stopped = true;

	constructor(
		private readonly command: EmbedPendingMessagesCommand,
		private readonly logger: AppLogger
	) {}

	onModuleInit(): void {
		this.stopped = false;
		this.schedule(0);
	}

	// Runs before PgPoolShutdown.onApplicationShutdown, irrespective of module traversal order.
	async beforeApplicationShutdown(): Promise<void> {
		this.stopped = true;
		if (this.timer !== undefined) clearTimeout(this.timer);
		await this.active;
	}

	private schedule(delay: number): void {
		if (this.stopped) return;
		this.timer = setTimeout(() => {
			this.active = this.tick();
		}, delay);
		this.timer.unref();
	}

	private async tick(): Promise<void> {
		let delay = 5000;
		try {
			const result = await this.command.execute();
			if (result.paused) delay = 5000;
			else if (result.examined === 0) delay = 1000;
			else delay = 0;
		} catch {
			// Database exceptions can contain SQL parameters: never log the exception.
			this.logger.warn("Embedding worker paused after storage failure");
		}
		this.schedule(delay);
	}
}
