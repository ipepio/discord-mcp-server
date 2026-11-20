import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";
import { PostgresMessageStoreRepository } from "../../src/features/ingestion/repositories/postgres-message-store.repository.js";
import { BackfillChannelHistoryCommand } from "../../src/features/ingestion/commands/backfill-channel-history.command.js";
import { ExcludeChannelMessagesCommand } from "../../src/features/ingestion/commands/exclude-channel-messages.command.js";
import { ResyncMessageHistoryCommand } from "../../src/features/ingestion/commands/resync-message-history.command.js";
import { DiscordRestFailureError } from "../../src/features/discord/index.js";
import { ImportChannelHistoryCommand } from "../../src/features/ingestion/commands/import-channel-history.command.js";
import { createIngestionConfig } from "../../src/features/ingestion/config/ingestion-config.interface.js";
import { PostgresImportProgressRepository } from "../../src/features/ingestion/repositories/postgres-import-progress.repository.js";
import { RecordingLogger } from "../features/ingestion/fakes/recording-logger.js";
import {
	AUTHOR_ID,
	CHANNEL_ID,
	GUILD_ID,
	MESSAGE_ID,
	CREATED_AT,
	EDITED_AT,
	messageWrite
} from "../features/ingestion/fakes/message-fixtures.js";

describe.skipIf(!HAS_TEST_DATABASE)("ingestion history (real PostgreSQL)", () => {
	let database: IsolatedTestDatabase;
	let store: PostgresMessageStoreRepository;
	let progress: PostgresImportProgressRepository;
	beforeAll(async () => {
		database = await openIsolatedTestDatabase("ingestion_history");
		store = new PostgresMessageStoreRepository({
			executor: database.executor,
			writeBatchSize: 200,
			exclusionPageSize: 200
		});
		// R14: the ledger is a table now, so a restarted command resumes from what the previous run stored.
		progress = new PostgresImportProgressRepository(database.executor);
	}, 180000);
	afterAll(async () => {
		await database?.close();
	});
	beforeEach(async () => {
		await database.resetMessageStore();
	});
	function mount() {
		const config = createIngestionConfig({ guildId: GUILD_ID, history: { maxPagesPerChannel: 1 } });
		const logger = new RecordingLogger();
		const backfill = new BackfillChannelHistoryCommand({
			config,
			messageStore: store,
			logger,
			history: {
				readMessageHistoryPage: async (input) => ({
					channelId: CHANNEL_ID,
					requestedLimit: 100,
					hasMore: input.before === undefined,
					...(input.before === undefined ? { nextBeforeId: MESSAGE_ID } : {}),
					messages:
						input.before === undefined
							? [
									{
										messageId: MESSAGE_ID,
										channelId: CHANNEL_ID,
										authorId: AUTHOR_ID,
										content: "history-original",
										createdInstant: CREATED_AT,
										messageType: "default"
									}
								]
							: []
				})
			}
		});
		const channels = {
			execute: async () => ({
				guildId: GUILD_ID,
				botUserId: AUTHOR_ID,
				channels: [
					{
						channelId: CHANNEL_ID,
						channelType: "guild-text" as const,
						isThread: false,
						parentChannelId: null
					}
				],
				registeredTextCapableCount: 1,
				botMembershipRegistered: true,
				botCannotViewChannelIds: [],
				refusalReasons: []
			})
		};
		return new ImportChannelHistoryCommand({
			config,
			channels,
			backfill,
			progress,
			logger
		});
	}
	it("restarts mid-import and resumes at the stored cursor instead of re-reading", async () => {
		expect((await mount().execute({ botUserId: AUTHOR_ID })).status).toBe("incomplete");
		const before = await store.findMessage(GUILD_ID, MESSAGE_ID);
		const replay = await mount().execute({ botUserId: AUTHOR_ID });
		if (replay.status === "refused") throw new Error("registry refused");
		// R14 with S2: the restarted run loads the stored cursor, so the page it already applied is not asked for again.
		expect(replay.status).toBe("complete");
		expect(replay.channels[0]?.resumedFromCursor).toBe(true);
		expect(replay.totals.messagesStored).toBe(0);
		expect(replay.totals.messagesUnchanged).toBe(0);
		expect(await store.findMessage(GUILD_ID, MESSAGE_ID)).toEqual(before);
		const count = await database.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM message");
		expect(count.rows[0]?.count).toBe("1");
	});
	it("reconnect failure retains its missed window; retry stores it once on PostgreSQL", async () => {
		const config = createIngestionConfig({ guildId: GUILD_ID });
		const logger = new RecordingLogger();
		let failing = true;
		const backfill = new BackfillChannelHistoryCommand({
			config,
			logger,
			messageStore: store,
			history: {
				readMessageHistoryPage: async () => {
					if (failing)
						throw new DiscordRestFailureError({
							operation: "discord-rest.message-history",
							reason: "server-error",
							attempts: 3,
							status: 503,
							detail: "unavailable"
						});
					return {
						channelId: CHANNEL_ID,
						requestedLimit: 100,
						hasMore: false,
						messages: [
							{
								messageId: MESSAGE_ID,
								channelId: CHANNEL_ID,
								authorId: AUTHOR_ID,
								content: "missed",
								createdInstant: CREATED_AT,
								messageType: "default"
							}
						]
					};
				}
			}
		});
		const channels = {
			execute: async () => ({
				guildId: GUILD_ID,
				botUserId: AUTHOR_ID,
				channels: [
					{
						channelId: CHANNEL_ID,
						channelType: "guild-text" as const,
						isThread: false,
						parentChannelId: null
					}
				],
				registeredTextCapableCount: 1,
				botMembershipRegistered: true,
				botCannotViewChannelIds: [],
				refusalReasons: []
			})
		};
		const command = new ResyncMessageHistoryCommand({ config, channels, backfill, logger });
		const signal = {
			guildId: GUILD_ID,
			botUserId: AUTHOR_ID,
			epoch: 2,
			reconnectAttempts: 1,
			lastDeliveredInstant: new Date(CREATED_AT.getTime() - 600000)
		};
		expect((await command.execute(signal)).status).toBe("incomplete");
		expect(command.gapSnapshot()).toHaveLength(1);
		expect(await store.findMessage(GUILD_ID, MESSAGE_ID)).toBeNull();
		failing = false;
		expect((await command.execute(signal)).status).toBe("complete");
		expect((await command.execute(signal)).channels[0]?.messagesUnchanged).toBe(1);
		expect((await store.findMessage(GUILD_ID, MESSAGE_ID))?.content).toBe("missed");
	});
	it("structure deletion excludes all channel messages and replay leaves tombstones unchanged", async () => {
		await store.upsertMessages([messageWrite(), messageWrite({ messageId: "160000000000000499" })]);
		const command = new ExcludeChannelMessagesCommand({
			config: createIngestionConfig({ guildId: GUILD_ID }),
			logger: new RecordingLogger(),
			messageStore: store
		});
		const input = { guildId: GUILD_ID, channelIds: [CHANNEL_ID], deletedAt: EDITED_AT };
		expect(await command.execute(input)).toMatchObject({ messagesTombstoned: 2 });
		const before = await store.findMessage(GUILD_ID, MESSAGE_ID);
		expect(before).toMatchObject({ content: null, deletedAt: EDITED_AT, attachments: [] });
		expect(await command.execute(input)).toMatchObject({ messagesTombstoned: 0 });
		expect(await store.findMessage(GUILD_ID, MESSAGE_ID)).toEqual(before);
	});
	it("late REST history and its replay cannot revive a Gateway tombstone", async () => {
		await store.upsertMessages([messageWrite()]);
		await store.tombstoneMessages({ guildId: GUILD_ID, messageIds: [MESSAGE_ID], deletedAt: EDITED_AT });
		const before = await store.findMessage(GUILD_ID, MESSAGE_ID);
		const applied = await mount().execute({ botUserId: AUTHOR_ID });
		if (applied.status === "refused") throw new Error("registry refused");
		expect(applied.totals.messagesStored).toBe(0);
		expect(applied.totals.messagesUnchanged).toBe(1);
		expect(await store.findMessage(GUILD_ID, MESSAGE_ID)).toEqual(before);
		// R14's restart: the second run resumes at the stored cursor, so it neither re-reads the tombstoned page nor
		// revives it.
		const replay = await mount().execute({ botUserId: AUTHOR_ID });
		if (replay.status === "refused") throw new Error("registry refused");
		expect(replay.totals.messagesStored).toBe(0);
		expect(replay.totals.messagesUnchanged).toBe(0);
		expect(await store.findMessage(GUILD_ID, MESSAGE_ID)).toEqual(before);
		expect(before).toMatchObject({ content: null, attachments: [], deletedAt: EDITED_AT });
	});
	it("a late historical version never regresses a newer Gateway edit", async () => {
		await store.upsertMessages([messageWrite({ content: "newer", editedInstant: EDITED_AT })]);
		await mount().execute({ botUserId: AUTHOR_ID });
		expect((await store.findMessage(GUILD_ID, MESSAGE_ID))?.content).toBe("newer");
	});
});
