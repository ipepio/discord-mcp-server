import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { IngestionConfig } from "../config/ingestion-config.interface.js";
import type { ChannelExclusionResult } from "../models/domain/message-records.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import type { MessageStoreRepository } from "../repositories/message-store.repository.js";

export interface ExcludeChannelMessagesInput {
	readonly guildId: string;
	readonly channelIds: readonly string[];
	/** Discord supplies no deletion timestamp; the binding injects its observed instant. */
	readonly deletedAt: Date;
}
export interface ExcludeChannelMessagesDeps {
	readonly config: IngestionConfig;
	readonly messageStore: MessageStoreRepository;
	readonly logger: AppLogger;
}
/** R2/R6: bulk exclusion is ingestion-owned; the guild-state registry is never written here. */
export class ExcludeChannelMessagesCommand {
	public constructor(private readonly deps: ExcludeChannelMessagesDeps) {}
	public readonly execute = async (
		input: ExcludeChannelMessagesInput
	): Promise<ChannelExclusionResult | { readonly status: "dropped" }> => {
		if (input.guildId !== this.deps.config.guildId) {
			this.deps.logger.warn("ingestion refused foreign guild channel exclusion", {
				guildId: input.guildId,
				channelCount: input.channelIds.length
			});
			return { status: "dropped" };
		}
		const channelIds = input.channelIds.map((id) => requireDiscordIdentifier("message.channel_id", id));
		const result = await this.deps.messageStore.excludeChannelMessages({
			guildId: input.guildId,
			channelIds,
			deletedAt: input.deletedAt
		});
		this.deps.logger.info("ingestion excluded channel messages", {
			guildId: input.guildId,
			channelCount: channelIds.length,
			messagesTombstoned: result.messagesTombstoned,
			attachmentsRemoved: result.attachmentsRemoved
		});
		return result;
	};
}
