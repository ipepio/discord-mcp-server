import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import { DiscordEventKind } from "../../discord/index.js";
import type { DiscordEventConsumer, DiscordEventSubscription, NormalizedDiscordEvent } from "../../discord/index.js";
import type { IngestionConfig } from "../config/ingestion-config.interface.js";
import type { RecordMessageCommand } from "../commands/record-message.command.js";
import type { ApplyMessageEditCommand } from "../commands/apply-message-edit.command.js";
import type { ApplyMessageDeletionCommand } from "../commands/apply-message-deletion.command.js";
import type { ExcludeChannelMessagesCommand } from "../commands/exclude-channel-messages.command.js";
import type { ResyncMessageHistoryCommand } from "../commands/resync-message-history.command.js";

export const INGESTION_BOUND_EVENT_KINDS = Object.freeze([
	DiscordEventKind.messageCreated,
	DiscordEventKind.messageUpdated,
	DiscordEventKind.messageDeleted,
	DiscordEventKind.messageBulkDeleted,
	DiscordEventKind.channelCreated,
	DiscordEventKind.channelUpdated,
	DiscordEventKind.channelDeleted,
	DiscordEventKind.threadCreated,
	DiscordEventKind.threadUpdated,
	DiscordEventKind.threadDeleted,
	DiscordEventKind.resyncNeeded
]);
export interface IngestionEventSubscriptionDeps {
	readonly config: IngestionConfig;
	readonly botUserId: string;
	readonly consumer: DiscordEventConsumer;
	readonly logger: AppLogger;
	readonly record: Pick<RecordMessageCommand, "execute">;
	readonly edit: Pick<ApplyMessageEditCommand, "execute">;
	readonly remove: Pick<ApplyMessageDeletionCommand, "execute">;
	readonly exclude: Pick<ExcludeChannelMessagesCommand, "execute">;
	readonly resync: Pick<ResyncMessageHistoryCommand, "execute">;
	readonly clock?: () => Date;
}
export type IngestionEventDisposition =
	| { readonly status: "dropped"; readonly reason: "foreign-guild" }
	| { readonly status: "ignored"; readonly reason: "registry-owned" | "kind-not-bound" }
	| { readonly status: "handled"; readonly outcome: unknown };

/** Thin, explicit application mapping; never logs payloads. Construction does not subscribe or start I/O.
 * Composition subscribes guild-state first, so structure facts converge before ingestion consumes them.
 * Historical import is started independently by composition, not awaited on the message delivery queue.
 */
export class IngestionEventSubscription {
	private subscription: DiscordEventSubscription | undefined;
	private anomalies = 0;
	public constructor(private readonly deps: IngestionEventSubscriptionDeps) {}
	public foreignGuildCount(): number {
		return this.anomalies;
	}
	public subscribe(): DiscordEventSubscription {
		if (this.subscription !== undefined) return this.subscription;
		const subscriptions = INGESTION_BOUND_EVENT_KINDS.map((kind) =>
			this.deps.consumer.subscribe(kind, async (event) => {
				await this.handle(event);
			})
		);
		this.subscription = {
			unsubscribe: () => {
				for (const item of subscriptions) item.unsubscribe();
				this.subscription = undefined;
			}
		};
		return this.subscription;
	}
	public unsubscribe(): void {
		this.subscription?.unsubscribe();
	}
	public async handle(event: NormalizedDiscordEvent): Promise<IngestionEventDisposition> {
		if (event.guildId !== this.deps.config.guildId) {
			this.anomalies += 1;
			this.deps.logger.warn("ingestion dropped foreign guild event", {
				guildId: event.guildId,
				kind: event.kind,
				anomalyCount: this.anomalies
			});
			return { status: "dropped", reason: "foreign-guild" };
		}
		switch (event.kind) {
			case DiscordEventKind.messageCreated: {
				const { kind, ...input } = event;
				void kind;
				return { status: "handled", outcome: await this.deps.record.execute(input) };
			}
			case DiscordEventKind.messageUpdated: {
				const { kind, ...input } = event;
				void kind;
				return { status: "handled", outcome: await this.deps.edit.execute(input) };
			}
			case DiscordEventKind.messageDeleted:
				return {
					status: "handled",
					outcome: await this.deps.remove.execute({
						guildId: event.guildId,
						channelId: event.channelId,
						messageIds: [event.messageId]
					})
				};
			case DiscordEventKind.messageBulkDeleted:
				return {
					status: "handled",
					outcome: await this.deps.remove.execute({
						guildId: event.guildId,
						channelId: event.channelId,
						messageIds: event.messageIds
					})
				};
			case DiscordEventKind.channelDeleted:
			case DiscordEventKind.threadDeleted:
				return {
					status: "handled",
					outcome: await this.deps.exclude.execute({
						guildId: event.guildId,
						channelIds: [event.kind === DiscordEventKind.channelDeleted ? event.channelId : event.threadId],
						deletedAt: (this.deps.clock ?? (() => new Date()))()
					})
				};
			case DiscordEventKind.resyncNeeded: {
				const { kind, ...facts } = event;
				void kind;
				return {
					status: "handled",
					outcome: await this.deps.resync.execute({ ...facts, botUserId: this.deps.botUserId })
				};
			}
			case DiscordEventKind.channelCreated:
			case DiscordEventKind.channelUpdated:
			case DiscordEventKind.threadCreated:
			case DiscordEventKind.threadUpdated:
				return { status: "ignored", reason: "registry-owned" };
			default:
				return { status: "ignored", reason: "kind-not-bound" };
		}
	}
}
