import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { DiscordEventKind } from "../../discord/index.js";
import type { IngestionConfig } from "../config/ingestion-config.interface.js";
import type { IngestibleChannelRegistry } from "../gateways/channel-registry-gateway.interface.js";
import { registryConsumptionBlockReason } from "../models/domain/registry-consumption-rules.js";
import { stopReasonCompletesWalk } from "../models/domain/history-walk-rules.js";
import type {
	BackfillChannelHistoryCommand,
	BackfillChannelHistoryResult
} from "./backfill-channel-history.command.js";

export interface ResyncMessageHistoryInput {
	readonly guildId: string;
	readonly epoch: number;
	readonly reconnectAttempts: number;
	readonly lastDeliveredInstant?: Date;
	readonly affectedKinds?: readonly DiscordEventKind[];
	readonly botUserId: string;
}
export interface MessageHistoryGap {
	readonly channelId: string;
	readonly since: Date | null;
	readonly beforeId: string | null;
	readonly epoch: number;
	readonly reason: string;
}
export interface ResyncMessageHistoryResult {
	readonly status: "complete" | "incomplete" | "refused" | "dropped";
	readonly channels: readonly BackfillChannelHistoryResult[];
	readonly gaps: readonly MessageHistoryGap[];
}
export interface ResyncMessageHistoryDeps {
	readonly config: IngestionConfig;
	readonly channels: IngestibleChannelRegistry;
	readonly backfill: BackfillChannelHistoryCommand;
	readonly logger: AppLogger;
}
/** R9: a failed or bounded walk remains a named gap, never a claim that the channel is current.
 * No persisted cursor is required: replaying the signal after restart rereads the window idempotently (R7).
 *
 * The walk is bounded by `config.resyncMaxPagesPerChannel`. Hitting that bound is `page-bound`, the existing
 * stop reason for outstanding work at a cursor, so the channel stays in `gaps` with the cursor the next walk
 * resumes from — the resync reports a gap rather than claiming a channel it did not finish.
 */
export class ResyncMessageHistoryCommand {
	private readonly gaps = new Map<string, MessageHistoryGap>();
	public constructor(private readonly deps: ResyncMessageHistoryDeps) {}
	public gapSnapshot(): readonly MessageHistoryGap[] {
		return [...this.gaps.values()];
	}
	public readonly execute = async (input: ResyncMessageHistoryInput): Promise<ResyncMessageHistoryResult> => {
		if (input.guildId !== this.deps.config.guildId) {
			this.deps.logger.warn("ingestion refused foreign guild resync", {
				guildId: input.guildId,
				epoch: input.epoch
			});
			return { status: "dropped", channels: [], gaps: this.gapSnapshot() };
		}
		const listed = await this.deps.channels.execute({ botUserId: input.botUserId });
		if (registryConsumptionBlockReason(listed) !== null) {
			this.deps.logger.warn("ingestion deferred resync over unavailable registry", {
				guildId: input.guildId,
				epoch: input.epoch
			});
			return { status: "refused", channels: [], gaps: this.gapSnapshot() };
		}
		const results: BackfillChannelHistoryResult[] = [];
		for (const channel of listed.channels) {
			const previous = this.gaps.get(channel.channelId);
			const requestedSince = input.lastDeliveredInstant ?? null;
			let since = requestedSince;
			if (previous !== undefined) {
				since =
					previous.since === null || requestedSince === null
						? null
						: new Date(Math.min(previous.since.getTime(), requestedSince.getTime()));
			}
			// A new reconnect must start at the newest page too, not resume past newly missed messages.
			const beforeId = previous?.epoch === input.epoch ? previous.beforeId : null;
			this.gaps.set(channel.channelId, {
				channelId: channel.channelId,
				since,
				beforeId,
				epoch: input.epoch,
				reason: "pending"
			});
			try {
				const result = await this.deps.backfill.execute({
					channelId: channel.channelId,
					cutoffInstant: since,
					resumeBeforeId: beforeId,
					// R9 is a gap fill, not a second import: the walk reads what could have been missed while the
					// process was not listening (hours at most), and R3's import and R14's catch-up own the full walk
					// from the durable ledger. Unbounded, a restart re-read every channel from its newest message to
					// its beginning to discover that nothing had changed.
					maxPages: this.deps.config.resyncMaxPagesPerChannel
				});
				results.push(result);
				if (stopReasonCompletesWalk(result.stop)) this.gaps.delete(channel.channelId);
				else
					this.gaps.set(channel.channelId, {
						channelId: channel.channelId,
						since,
						beforeId: result.nextBeforeId,
						epoch: input.epoch,
						reason: result.stop
					});
			} catch (failure) {
				this.deps.logger.error("ingestion resync backfill failed with gap retained", {
					guildId: input.guildId,
					channelId: channel.channelId,
					epoch: input.epoch
				});
				// The gap remains pending; unexpected failures propagate rather than masquerade as Discord errors.
				throw failure;
			}
		}
		const gaps = this.gapSnapshot();
		this.deps.logger[gaps.length === 0 ? "info" : "warn"]("ingestion finished reconnect resync", {
			guildId: input.guildId,
			epoch: input.epoch,
			channelCount: results.length,
			gapCount: gaps.length
		});
		return { status: gaps.length === 0 ? "complete" : "incomplete", channels: results, gaps };
	};
}
