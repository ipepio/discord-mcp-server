import { describe, expect, it } from "vitest";
import type { DiscordMessageHistoryPage, DiscordMessageRecord } from "../../../src/features/discord/index.js";
import { DiscordRestFailureError } from "../../../src/features/discord/index.js";
import { BackfillChannelHistoryCommand } from "../../../src/features/ingestion/commands/backfill-channel-history.command.js";
import { ImportChannelHistoryCommand } from "../../../src/features/ingestion/commands/import-channel-history.command.js";
import { createIngestionConfig } from "../../../src/features/ingestion/config/ingestion-config.interface.js";
import { loadIngestionImportWindow } from "../../../src/features/ingestion/config/ingestion-config.validator.js";
import { RecordingImportProgressRepository } from "./fakes/recording-import-progress.repository.js";
import { RecordingMessageStore } from "./fakes/recording-message-store.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import { AUTHOR_ID, CHANNEL_ID, GUILD_ID, MESSAGE_ID, THREAD_ID, SECRET_CONTENT } from "./fakes/message-fixtures.js";

export const START = new Date("2026-03-02T10:00:00Z");
export const CUTOFF = new Date("2026-03-01T10:00:00Z");
export function historyRecord(overrides: Partial<DiscordMessageRecord> = {}): DiscordMessageRecord {
	return {
		messageId: MESSAGE_ID,
		channelId: CHANNEL_ID,
		authorId: AUTHOR_ID,
		content: SECRET_CONTENT,
		createdInstant: START,
		messageType: "default",
		...overrides
	};
}
export function historyPage(messages: readonly DiscordMessageRecord[], hasMore = false): DiscordMessageHistoryPage {
	return {
		channelId: CHANNEL_ID,
		messages,
		requestedLimit: 100,
		hasMore,
		...(hasMore && messages.length > 0 ? { nextBeforeId: messages.at(-1)?.messageId ?? MESSAGE_ID } : {})
	};
}
export function registry(channelIds: readonly string[] = [CHANNEL_ID]) {
	return {
		execute: async () => ({
			guildId: GUILD_ID,
			botUserId: AUTHOR_ID,
			refusalReasons: [],
			channels: channelIds.map((channelId) => ({
				channelId,
				channelType: "guild-text" as const,
				isThread: false,
				parentChannelId: null
			})),
			botCannotViewChannelIds: [],
			registeredTextCapableCount: channelIds.length,
			botMembershipRegistered: true
		})
	};
}
function fixture(pages: (DiscordMessageHistoryPage | Error)[], maxPagesPerChannel = 20) {
	const store = new RecordingMessageStore();
	const logger = new RecordingLogger();
	const requests: unknown[] = [];
	const config = createIngestionConfig({
		guildId: GUILD_ID,
		importWindow: { mode: "days", days: 1 },
		history: { maxPagesPerChannel }
	});
	const backfill = new BackfillChannelHistoryCommand({
		config,
		messageStore: store,
		logger,
		history: {
			readMessageHistoryPage: async (input) => {
				requests.push(input);
				const page = pages.shift();
				if (page instanceof Error) throw page;
				if (page === undefined) throw new Error("unexpected history request");
				return page;
			}
		}
	});
	const mount = () =>
		new ImportChannelHistoryCommand({
			config,
			channels: registry(),
			backfill,
			progress: new RecordingImportProgressRepository(),
			logger,
			clock: () => START
		});
	return { store, logger, requests, backfill, mount };
}
describe("historical import R3/R7/R8", () => {
	it("stops on the FIRST cutoff-crossing page rather than spending another request", async () => {
		const f = fixture([
			historyPage(
				[historyRecord(), historyRecord({ messageId: "160000000000000400", createdInstant: CUTOFF })],
				true
			)
		]);
		const result = await f.backfill.execute({ channelId: CHANNEL_ID, cutoffInstant: CUTOFF });
		expect(result.stop).toBe("window-bound");
		expect(f.requests).toHaveLength(1);
		expect(f.store.rows.size).toBe(1);
	});
	it("restarts after an interrupted import with replayed batches moving nothing", async () => {
		const first = historyPage([historyRecord()], true);
		const f = fixture([first, first, historyPage([])], 1);
		expect((await f.mount().execute({ botUserId: AUTHOR_ID })).status).toBe("incomplete");
		const restarted = f.mount();
		const replay = await restarted.execute({ botUserId: AUTHOR_ID });
		expect(replay.status).toBe("incomplete");
		if (replay.status !== "refused") expect(replay.totals.messagesUnchanged).toBe(1);
		expect((await restarted.execute({ botUserId: AUTHOR_ID })).status).toBe("complete");
		expect(f.store.rows.size).toBe(1);
	});
	it("continues after a 4xx and never calls incomplete work complete", async () => {
		const f = fixture([]);
		const config = createIngestionConfig({ guildId: GUILD_ID });
		const seen: string[] = [];
		const backfill = new BackfillChannelHistoryCommand({
			config,
			messageStore: f.store,
			logger: f.logger,
			history: {
				readMessageHistoryPage: async (input) => {
					seen.push(input.channelId);
					if (input.channelId === CHANNEL_ID)
						throw new DiscordRestFailureError({
							operation: "discord-rest.message-history",
							reason: "not-found",
							detail: "channel unavailable",
							attempts: 1,
							status: 404
						});
					return { ...historyPage([]), channelId: THREAD_ID };
				}
			}
		});
		const command = new ImportChannelHistoryCommand({
			config,
			channels: registry([CHANNEL_ID, THREAD_ID]),
			backfill,
			progress: new RecordingImportProgressRepository(),
			logger: f.logger
		});
		const result = await command.execute({ botUserId: AUTHOR_ID });
		expect(result.status).toBe("incomplete");
		expect(seen).toEqual([CHANNEL_ID, THREAD_ID]);
		expect(JSON.stringify(f.logger)).not.toContain(SECRET_CONTENT);
	});
	it.each([undefined, "", "bogus"])("rejects missing/invalid mode %s", (mode) => {
		expect(() => loadIngestionImportWindow({ IMPORT_MODE: mode })).toThrow();
	});
	it.each([undefined, "0", "-1", "1.5", "NaN", "999999999999999999"])("rejects invalid days %s", (days) => {
		expect(() => loadIngestionImportWindow({ IMPORT_MODE: "days", IMPORT_DAYS: days })).toThrow();
	});
	it("requires days only in days mode", () => {
		expect(loadIngestionImportWindow({ IMPORT_MODE: "full", IMPORT_DAYS: "not-read" })).toEqual({ mode: "full" });
		expect(loadIngestionImportWindow({ IMPORT_MODE: "days", IMPORT_DAYS: "90" })).toEqual({
			mode: "days",
			days: 90
		});
	});
});
