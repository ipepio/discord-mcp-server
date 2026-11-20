import { Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import {
	IngestionModule,
	INGESTION_EVENT_SUBSCRIPTION_TOKEN,
	INGESTION_IMPORT_COMMAND_TOKEN,
	IngestionEventSubscription,
	ImportChannelHistoryCommand
} from "../../../src/features/ingestion/index.js";
import {
	INGESTION_MESSAGE_STORE_TOKEN,
	INGESTION_RECORD_COMMAND_TOKEN,
	INGESTION_CONFIG_TOKEN,
	INGESTION_CATCH_UP_WORKER_TOKEN,
	INGESTION_PROGRESS_REPOSITORY_TOKEN
} from "../../../src/features/ingestion/ingestion.tokens.js";
import { IngestionCatchUpWorker } from "../../../src/features/ingestion/ingestion-catch-up.worker.js";
import { RecordingImportProgressRepository } from "./fakes/recording-import-progress.repository.js";
import { APP_CONFIG_TOKEN } from "../../../src/shared/config/config.tokens.js";
import { APP_LOGGER_TOKEN } from "../../../src/shared/logging/logging.tokens.js";
import { PG_POOL_TOKEN } from "../../../src/shared/persistence/persistence.tokens.js";
import {
	DISCORD_CONFIG_TOKEN,
	DISCORD_REST_OPERATIONS_TOKEN,
	DISCORD_EVENT_STREAM_TOKEN,
	DISCORD_REQUIRED_INTENTS,
	DiscordEventKind
} from "../../../src/features/discord/index.js";
import { GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN } from "../../../src/features/guild-state/index.js";
import { RecordingMessageStore } from "./fakes/recording-message-store.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import { GUILD_ID, AUTHOR_ID, CHANNEL_ID, MESSAGE_ID, CREATED_AT } from "./fakes/message-fixtures.js";

let reads = 0;
const registered: string[] = [];
const providers = [
	{
		provide: DISCORD_CONFIG_TOKEN,
		useValue: { guildId: GUILD_ID, botToken: "never-logged", intents: DISCORD_REQUIRED_INTENTS }
	},
	{
		provide: DISCORD_REST_OPERATIONS_TOKEN,
		useValue: {
			readMessageHistoryPage: async () => {
				reads += 1;
				return { channelId: CHANNEL_ID, requestedLimit: 100, hasMore: false, messages: [] };
			}
		}
	},
	{
		provide: DISCORD_EVENT_STREAM_TOKEN,
		useValue: {
			subscribe: (kind: string) => {
				registered.push(kind);
				return { unsubscribe: () => undefined };
			}
		}
	},
	{
		provide: GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN,
		useValue: {
			execute: async () => ({
				guildId: GUILD_ID,
				botUserId: AUTHOR_ID,
				channels: [
					{ channelId: CHANNEL_ID, channelType: "guild-text", isThread: false, parentChannelId: null }
				],
				botMembershipRegistered: true,
				registeredTextCapableCount: 1,
				botCannotViewChannelIds: [],
				refusalReasons: []
			})
		}
	}
];
@Module({ providers, exports: providers.map((provider) => provider.provide) })
class PublicCapabilitiesModule {}

describe("ingestion module composition", () => {
	it("resolves real command instances with the public registry and Discord tokens; starts no I/O implicitly", async () => {
		reads = 0;
		registered.length = 0;
		const logger = new RecordingLogger();
		const store = new RecordingMessageStore();
		const testing = await Test.createTestingModule({
			imports: [
				IngestionModule.forRoot({
					imports: [PublicCapabilitiesModule],
					botUserId: AUTHOR_ID,
					env: { IMPORT_MODE: "full" },
					logger
				})
			]
		})
			.overrideProvider(APP_CONFIG_TOKEN)
			.useValue({
				database: { url: "postgres://test@localhost/test" },
				http: { port: 3000 },
				logging: { level: "info" }
			})
			.overrideProvider(APP_LOGGER_TOKEN)
			.useValue(logger)
			.overrideProvider(PG_POOL_TOKEN)
			.useValue({ end: async () => undefined })
			.overrideProvider(INGESTION_MESSAGE_STORE_TOKEN)
			.useValue(store)
			.overrideProvider(INGESTION_PROGRESS_REPOSITORY_TOKEN)
			.useValue(new RecordingImportProgressRepository())
			.compile();
		try {
			const binding = testing.get<IngestionEventSubscription>(INGESTION_EVENT_SUBSCRIPTION_TOKEN);
			const importing = testing.get<ImportChannelHistoryCommand>(INGESTION_IMPORT_COMMAND_TOKEN);
			const catchUp = testing.get<IngestionCatchUpWorker>(INGESTION_CATCH_UP_WORKER_TOKEN);
			expect(binding).toBeInstanceOf(IngestionEventSubscription);
			expect(importing).toBeInstanceOf(ImportChannelHistoryCommand);
			// R14's scheduler is composed like the embedding worker and starts nothing until Nest initialises it, which
			// `compile()` deliberately does not do: composing a module must stay inert (no timer, no history read).
			expect(catchUp).toBeInstanceOf(IngestionCatchUpWorker);
			expect(testing.get(INGESTION_RECORD_COMMAND_TOKEN).constructor.name).toBe("RecordMessageCommand");
			expect(testing.get(INGESTION_CONFIG_TOKEN).guildId).toBe(GUILD_ID);
			expect(reads).toBe(0);
			expect(registered).toEqual([]);
			expect((await importing.execute({ botUserId: AUTHOR_ID })).status).toBe("complete");
			expect(reads).toBe(1);
			binding.subscribe();
			expect(registered).toContain(DiscordEventKind.resyncNeeded);
			await binding.handle({
				kind: DiscordEventKind.messageCreated,
				guildId: GUILD_ID,
				channelId: CHANNEL_ID,
				messageId: MESSAGE_ID,
				authorId: AUTHOR_ID,
				createdInstant: CREATED_AT,
				messageType: "default",
				content: "stored-not-logged"
			});
			expect(store.rows.get(MESSAGE_ID)?.content).toBe("stored-not-logged");
			expect(JSON.stringify(logger)).not.toContain("stored-not-logged");
			binding.unsubscribe();
		} finally {
			await testing.close();
		}
	});
	it("rejects missing startup import configuration before constructing clients", () => {
		expect(() =>
			IngestionModule.forRoot({ imports: [PublicCapabilitiesModule], botUserId: AUTHOR_ID, env: {} })
		).toThrow(/IMPORT_MODE/);
	});
});
