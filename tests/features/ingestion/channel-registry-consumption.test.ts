import { describe, expect, it } from "vitest";
import { ExcludeChannelMessagesCommand } from "../../../src/features/ingestion/commands/exclude-channel-messages.command.js";
import { ImportChannelHistoryCommand } from "../../../src/features/ingestion/commands/import-channel-history.command.js";
import { BackfillChannelHistoryCommand } from "../../../src/features/ingestion/commands/backfill-channel-history.command.js";
import { createIngestionConfig } from "../../../src/features/ingestion/config/ingestion-config.interface.js";
import { RecordingImportProgressRepository } from "./fakes/recording-import-progress.repository.js";
import { RecordingMessageStore } from "./fakes/recording-message-store.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import {
	GUILD_ID,
	OTHER_GUILD_ID,
	CHANNEL_ID,
	THREAD_ID,
	AUTHOR_ID,
	DELETED_AT,
	MESSAGE_ID,
	attachment,
	messageWrite
} from "./fakes/message-fixtures.js";

describe("registry consumption R2", () => {
	it("excludes a deleted thread, physically dropping content/metadata; replay moves nothing", async () => {
		const store = new RecordingMessageStore();
		const logger = new RecordingLogger();
		const config = createIngestionConfig({ guildId: GUILD_ID });
		await store.upsertMessages([
			messageWrite({ channelId: THREAD_ID, attachments: [attachment()] }),
			messageWrite({ messageId: "160000000000000499", channelId: CHANNEL_ID })
		]);
		const command = new ExcludeChannelMessagesCommand({ config, messageStore: store, logger });
		const input = { guildId: GUILD_ID, channelIds: [THREAD_ID], deletedAt: DELETED_AT };
		expect(await command.execute(input)).toMatchObject({ messagesTombstoned: 1, attachmentsRemoved: 1 });
		expect(store.rows.get(MESSAGE_ID)).toMatchObject({ content: null, attachments: [], deletedAt: DELETED_AT });
		expect(store.rows.get("160000000000000499")?.deletedAt).toBeNull();
		expect(await command.execute(input)).toMatchObject({ messagesTombstoned: 0, attachmentsRemoved: 0 });
		expect(await command.execute({ ...input, guildId: OTHER_GUILD_ID })).toEqual({ status: "dropped" });
	});
	it("walks only the public registry query's returned channels", async () => {
		const store = new RecordingMessageStore();
		const logger = new RecordingLogger();
		const config = createIngestionConfig({ guildId: GUILD_ID });
		const seen: string[] = [];
		const backfill = new BackfillChannelHistoryCommand({
			config,
			logger,
			messageStore: store,
			history: {
				readMessageHistoryPage: async (input) => {
					seen.push(input.channelId);
					return { channelId: input.channelId, messages: [], hasMore: false, requestedLimit: 100 };
				}
			}
		});
		const channels = {
			execute: async () => ({
				guildId: GUILD_ID,
				botUserId: AUTHOR_ID,
				channels: [
					{
						channelId: THREAD_ID,
						channelType: "public-thread" as const,
						isThread: true,
						parentChannelId: CHANNEL_ID
					}
				],
				botCannotViewChannelIds: [CHANNEL_ID],
				botMembershipRegistered: true,
				registeredTextCapableCount: 2,
				refusalReasons: []
			})
		};
		const command = new ImportChannelHistoryCommand({
			config,
			channels,
			backfill,
			logger,
			progress: new RecordingImportProgressRepository()
		});
		expect((await command.execute({ botUserId: AUTHOR_ID })).status).toBe("complete");
		expect(seen).toEqual([THREAD_ID]);
	});
});
