import { describe, expect, it } from "vitest";
import { DiscordRestFailureError } from "../../../src/features/discord/index.js";
import { ResyncMessageHistoryCommand } from "../../../src/features/ingestion/commands/resync-message-history.command.js";
import { BackfillChannelHistoryCommand } from "../../../src/features/ingestion/commands/backfill-channel-history.command.js";
import {
	DEFAULT_INGESTION_RESYNC,
	createIngestionConfig
} from "../../../src/features/ingestion/config/ingestion-config.interface.js";
import {
	INGESTION_ENV_VARIABLES,
	loadIngestionResyncConfig
} from "../../../src/features/ingestion/config/ingestion-config.validator.js";
import { RecordingMessageStore } from "./fakes/recording-message-store.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import { AUTHOR_ID, CHANNEL_ID, GUILD_ID, OTHER_GUILD_ID, MESSAGE_ID, CREATED_AT } from "./fakes/message-fixtures.js";

function fixture() {
	const config = createIngestionConfig({ guildId: GUILD_ID });
	const logger = new RecordingLogger();
	const store = new RecordingMessageStore();
	let failing = false;
	let calls = 0;
	const backfill = new BackfillChannelHistoryCommand({
		config,
		logger,
		messageStore: store,
		history: {
			readMessageHistoryPage: async () => {
				calls += 1;
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
				{ channelId: CHANNEL_ID, channelType: "guild-text" as const, isThread: false, parentChannelId: null }
			],
			registeredTextCapableCount: 1,
			botMembershipRegistered: true,
			botCannotViewChannelIds: [],
			refusalReasons: []
		})
	};
	return {
		command: new ResyncMessageHistoryCommand({ config, channels, backfill, logger }),
		store,
		setFailing: (value: boolean) => {
			failing = value;
		},
		calls: () => calls
	};
}
/**
 * A channel with an arbitrary number of older pages behind it: what an unbounded reconnect walk used to read to
 * its beginning, and what the resync's own page bound has to stop.
 */
function pagedFixture(resyncMaxPagesPerChannel: number, pages: number) {
	const config = createIngestionConfig({ guildId: GUILD_ID, resyncMaxPagesPerChannel });
	const logger = new RecordingLogger();
	const store = new RecordingMessageStore();
	const cursors: (string | undefined)[] = [];
	const backfill = new BackfillChannelHistoryCommand({
		config,
		logger,
		messageStore: store,
		history: {
			readMessageHistoryPage: async (read) => {
				cursors.push(read.before);
				const pageNumber = cursors.length;
				const messageId = String(BigInt(MESSAGE_ID) + BigInt(pageNumber * 10));
				return {
					channelId: CHANNEL_ID,
					requestedLimit: read.limit ?? 100,
					hasMore: pageNumber < pages,
					messages: [
						{
							messageId,
							channelId: CHANNEL_ID,
							authorId: AUTHOR_ID,
							content: "missed",
							createdInstant: new Date(CREATED_AT.getTime() + pageNumber * 1000),
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
				{ channelId: CHANNEL_ID, channelType: "guild-text" as const, isThread: false, parentChannelId: null }
			],
			registeredTextCapableCount: 1,
			botMembershipRegistered: true,
			botCannotViewChannelIds: [],
			refusalReasons: []
		})
	};
	return {
		command: new ResyncMessageHistoryCommand({ config, channels, backfill, logger }),
		store,
		cursors
	};
}

const signal = {
	guildId: GUILD_ID,
	botUserId: AUTHOR_ID,
	epoch: 2,
	reconnectAttempts: 1,
	lastDeliveredInstant: new Date(CREATED_AT.getTime() - 600000)
};
describe("reconnect history R9/R7/R10", () => {
	it("fills the missed window and a replay changes nothing", async () => {
		const f = fixture();
		expect((await f.command.execute(signal)).status).toBe("complete");
		const before = [...f.store.rows.values()];
		const replay = await f.command.execute(signal);
		expect(replay.channels[0]?.messagesUnchanged).toBe(1);
		expect([...f.store.rows.values()]).toEqual(before);
	});
	it("retains a failed gap and only clears it after a successful backfill", async () => {
		const f = fixture();
		f.setFailing(true);
		const failed = await f.command.execute(signal);
		expect(failed.status).toBe("incomplete");
		expect(failed.gaps[0]?.since).toEqual(signal.lastDeliveredInstant);
		expect(failed.gaps[0]?.reason).toBe("rest-transient-failure");
		f.setFailing(false);
		expect((await f.command.execute(signal)).status).toBe("complete");
		expect(f.command.gapSnapshot()).toEqual([]);
	});
	it("unknown last delivery scans the full channel rather than guessing a zero-length gap", async () => {
		const f = fixture();
		const { lastDeliveredInstant: _last, ...unknown } = signal;
		expect((await f.command.execute(unknown)).channels[0]?.messagesStored).toBe(1);
	});
	it("foreign guild signal does not read or write", async () => {
		const f = fixture();
		expect((await f.command.execute({ ...signal, guildId: OTHER_GUILD_ID })).status).toBe("dropped");
		expect(f.calls()).toBe(0);
		expect(f.store.rows.size).toBe(0);
	});
	it("resync-walk-is-bounded: a channel with more pages than the bound reads only the bound and keeps its gap", async () => {
		const f = pagedFixture(2, 3);
		const stopped = await f.command.execute(signal);
		// The resync's job is the gap that appeared while the process was not listening, not the whole channel.
		expect(f.cursors).toHaveLength(2);
		expect(stopped.channels[0]?.pagesRead).toBe(2);
		expect(stopped.channels[0]?.stop).toBe("page-bound");
		expect(f.store.rows.size).toBe(2);
		// Not completion: the channel stays gap-tracked with the cursor the next walk resumes from.
		expect(stopped.status).toBe("incomplete");
		const gap = f.command.gapSnapshot()[0];
		expect(gap?.channelId).toBe(CHANNEL_ID);
		expect(gap?.since).toEqual(signal.lastDeliveredInstant);
		expect(gap?.epoch).toBe(signal.epoch);
		expect(gap?.reason).toBe("page-bound");
		const resumeCursor = String(BigInt(MESSAGE_ID) + BigInt(2 * 10));
		expect(gap?.beforeId).toBe(resumeCursor);
		const resumed = await f.command.execute(signal);
		expect(f.cursors[2]).toBe(resumeCursor);
		expect(resumed.channels[0]?.resumedFromCursor).toBe(true);
	});
	it("resync-bound-is-configurable: the walk bound is validated configuration, five pages by default", () => {
		expect(DEFAULT_INGESTION_RESYNC).toEqual({ resyncMaxPagesPerChannel: 5 });
		expect(loadIngestionResyncConfig({})).toEqual(DEFAULT_INGESTION_RESYNC);
		expect(createIngestionConfig({ guildId: GUILD_ID }).resyncMaxPagesPerChannel).toBe(5);
		expect(loadIngestionResyncConfig({ [INGESTION_ENV_VARIABLES.resyncMaxPagesPerChannel]: "3" })).toEqual({
			resyncMaxPagesPerChannel: 3
		});
		expect(createIngestionConfig({ guildId: GUILD_ID, resyncMaxPagesPerChannel: 8 }).resyncMaxPagesPerChannel).toBe(
			8
		);
		for (const declared of ["0", "-1", "1.5", "five", "NaN"]) {
			expect(() =>
				loadIngestionResyncConfig({ [INGESTION_ENV_VARIABLES.resyncMaxPagesPerChannel]: declared })
			).toThrow(new RegExp(INGESTION_ENV_VARIABLES.resyncMaxPagesPerChannel));
		}
		for (const resyncMaxPagesPerChannel of [0, -1, 1.5, Number.NaN]) {
			expect(() => createIngestionConfig({ guildId: GUILD_ID, resyncMaxPagesPerChannel })).toThrow(
				/resyncMaxPagesPerChannel/
			);
		}
	});
});
