import { describe, expect, it, vi } from "vitest";
import type { NormalizedDiscordEvent, DiscordEventKind as Kind } from "../../../src/features/discord/index.js";
import { DiscordEventKind } from "../../../src/features/discord/index.js";
import {
	IngestionEventSubscription,
	INGESTION_BOUND_EVENT_KINDS
} from "../../../src/features/ingestion/gateways/ingestion-event-subscription.gateway.js";
import { RecordMessageCommand } from "../../../src/features/ingestion/commands/record-message.command.js";
import { ApplyMessageEditCommand } from "../../../src/features/ingestion/commands/apply-message-edit.command.js";
import { ApplyMessageDeletionCommand } from "../../../src/features/ingestion/commands/apply-message-deletion.command.js";
import { ExcludeChannelMessagesCommand } from "../../../src/features/ingestion/commands/exclude-channel-messages.command.js";
import { ResyncMessageHistoryCommand } from "../../../src/features/ingestion/commands/resync-message-history.command.js";
import { BackfillChannelHistoryCommand } from "../../../src/features/ingestion/commands/backfill-channel-history.command.js";
import { createIngestionConfig } from "../../../src/features/ingestion/config/ingestion-config.interface.js";
import { RecordingMessageStore } from "./fakes/recording-message-store.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import {
	AUTHOR_ID,
	CHANNEL_ID,
	THREAD_ID,
	MESSAGE_ID,
	GUILD_ID,
	OTHER_GUILD_ID,
	CREATED_AT,
	EDITED_AT,
	DELETED_AT,
	SECRET_CONTENT,
	SECRET_FILENAME,
	SECRET_USERNAME,
	SECRET_URL,
	storedMessage
} from "./fakes/message-fixtures.js";

const created = {
	kind: DiscordEventKind.messageCreated,
	guildId: GUILD_ID,
	channelId: CHANNEL_ID,
	messageId: MESSAGE_ID,
	authorId: AUTHOR_ID,
	content: SECRET_CONTENT,
	createdInstant: CREATED_AT,
	messageType: "default"
} as const;
function fixture() {
	const config = createIngestionConfig({ guildId: GUILD_ID });
	const logger = new RecordingLogger();
	const store = new RecordingMessageStore();
	const registrations: Kind[] = [];
	const cancelled: Kind[] = [];
	const record = new RecordMessageCommand({ config, logger, messageStore: store });
	const edit = new ApplyMessageEditCommand({
		config,
		logger,
		messageStore: store,
		messageRest: {
			readMessage: async () => ({
				messageId: MESSAGE_ID,
				channelId: CHANNEL_ID,
				authorId: AUTHOR_ID,
				content: "reconciled",
				createdInstant: CREATED_AT,
				editedInstant: EDITED_AT,
				messageType: "default"
			})
		}
	});
	const remove = new ApplyMessageDeletionCommand({ config, logger, messageStore: store, clock: () => DELETED_AT });
	const exclude = new ExcludeChannelMessagesCommand({ config, logger, messageStore: store });
	const backfill = new BackfillChannelHistoryCommand({
		config,
		logger,
		messageStore: store,
		history: {
			readMessageHistoryPage: async () => ({
				channelId: CHANNEL_ID,
				messages: [],
				hasMore: false,
				requestedLimit: 100
			})
		}
	});
	const resync = new ResyncMessageHistoryCommand({
		config,
		logger,
		backfill,
		channels: {
			execute: async () => ({
				guildId: GUILD_ID,
				botUserId: AUTHOR_ID,
				channels: [],
				registeredTextCapableCount: 1,
				botMembershipRegistered: true,
				botCannotViewChannelIds: [CHANNEL_ID],
				refusalReasons: []
			})
		}
	});
	const spies = {
		record: vi.spyOn(record, "execute"),
		edit: vi.spyOn(edit, "execute"),
		remove: vi.spyOn(remove, "execute"),
		exclude: vi.spyOn(exclude, "execute"),
		resync: vi.spyOn(resync, "execute")
	};
	const binding = new IngestionEventSubscription({
		config,
		logger,
		botUserId: AUTHOR_ID,
		record,
		edit,
		remove,
		exclude,
		resync,
		clock: () => DELETED_AT,
		consumer: {
			subscribe: (kind) => {
				registrations.push(kind);
				return {
					unsubscribe: () => {
						cancelled.push(kind);
					}
				};
			}
		}
	});
	return { binding, spies, store, logger, registrations, cancelled };
}
const events: readonly NormalizedDiscordEvent[] = [
	created,
	{ kind: DiscordEventKind.messageUpdated, guildId: GUILD_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID },
	{ kind: DiscordEventKind.messageDeleted, guildId: GUILD_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID },
	{ kind: DiscordEventKind.messageBulkDeleted, guildId: GUILD_ID, channelId: CHANNEL_ID, messageIds: [MESSAGE_ID] },
	{ kind: DiscordEventKind.channelCreated, guildId: GUILD_ID, channelId: CHANNEL_ID, channelType: "guild-text" },
	{ kind: DiscordEventKind.channelUpdated, guildId: GUILD_ID, channelId: CHANNEL_ID, channelType: "guild-text" },
	{ kind: DiscordEventKind.channelDeleted, guildId: GUILD_ID, channelId: CHANNEL_ID, channelType: "guild-text" },
	{ kind: DiscordEventKind.threadCreated, guildId: GUILD_ID, threadId: THREAD_ID, threadType: "public-thread" },
	{ kind: DiscordEventKind.threadUpdated, guildId: GUILD_ID, threadId: THREAD_ID, threadType: "public-thread" },
	{ kind: DiscordEventKind.threadDeleted, guildId: GUILD_ID, threadId: THREAD_ID },
	{ kind: DiscordEventKind.resyncNeeded, guildId: GUILD_ID, epoch: 2, reconnectAttempts: 1 }
];
describe("ingestion event binding R1/R7/R8/R10/R11/R12", () => {
	it("registers exactly the normalized message/structure/resync kinds once and unsubscribes", () => {
		const f = fixture();
		expect(f.registrations).toEqual([]);
		const subscription = f.binding.subscribe();
		expect(f.binding.subscribe()).toBe(subscription);
		expect(f.registrations).toEqual(INGESTION_BOUND_EVENT_KINDS);
		f.binding.unsubscribe();
		expect(f.cancelled).toEqual(INGESTION_BOUND_EVENT_KINDS);
	});
	it.each(events)("foreign $kind is dropped and counted before any command or I/O", async (event) => {
		const f = fixture();
		expect(await f.binding.handle({ ...event, guildId: OTHER_GUILD_ID })).toEqual({
			status: "dropped",
			reason: "foreign-guild"
		});
		expect(f.binding.foreignGuildCount()).toBe(1);
		for (const spy of Object.values(f.spies)) expect(spy).not.toHaveBeenCalled();
		expect(f.store.calls).toEqual([]);
	});
	it("maps create field-for-field preserving missing and explicit empty attachment sets", async () => {
		const f = fixture();
		await f.binding.handle(created);
		const { kind, ...input } = created;
		void kind;
		expect(f.spies.record).toHaveBeenLastCalledWith(input);
		expect(f.spies.record.mock.calls[0]?.[0]).not.toHaveProperty("attachments");
		await f.binding.handle({ ...created, attachments: [] });
		expect(f.spies.record.mock.lastCall?.[0].attachments).toEqual([]);
	});
	it("partial edit does not manufacture content, timestamp or a list", async () => {
		const f = fixture();
		f.store.rows.set(MESSAGE_ID, storedMessage());
		await f.binding.handle({
			kind: DiscordEventKind.messageUpdated,
			guildId: GUILD_ID,
			channelId: CHANNEL_ID,
			messageId: MESSAGE_ID
		});
		expect(f.spies.edit).toHaveBeenCalledWith({ guildId: GUILD_ID, channelId: CHANNEL_ID, messageId: MESSAGE_ID });
	});
	it("maps single/bulk deletion and channel/thread exclusion to the exact ids", async () => {
		const f = fixture();
		for (const event of events.filter((event) =>
			[
				DiscordEventKind.messageDeleted,
				DiscordEventKind.messageBulkDeleted,
				DiscordEventKind.channelDeleted,
				DiscordEventKind.threadDeleted
			].some((kind) => kind === event.kind)
		))
			await f.binding.handle(event);
		expect(f.spies.remove.mock.calls.map((call) => call[0])).toEqual([
			{ guildId: GUILD_ID, channelId: CHANNEL_ID, messageIds: [MESSAGE_ID] },
			{ guildId: GUILD_ID, channelId: CHANNEL_ID, messageIds: [MESSAGE_ID] }
		]);
		expect(f.spies.exclude.mock.calls.map((call) => call[0])).toEqual([
			{ guildId: GUILD_ID, channelIds: [CHANNEL_ID], deletedAt: DELETED_AT },
			{ guildId: GUILD_ID, channelIds: [THREAD_ID], deletedAt: DELETED_AT }
		]);
	});
	it("resync preserves absent fields; explicit facts are handed through unchanged", async () => {
		const f = fixture();
		const bare = {
			kind: DiscordEventKind.resyncNeeded,
			guildId: GUILD_ID,
			epoch: 2,
			reconnectAttempts: 1
		} as const;
		await f.binding.handle(bare);
		expect(f.spies.resync).toHaveBeenLastCalledWith({
			guildId: GUILD_ID,
			epoch: 2,
			reconnectAttempts: 1,
			botUserId: AUTHOR_ID
		});
		await f.binding.handle({ ...bare, lastDeliveredInstant: CREATED_AT, affectedKinds: [] });
		expect(f.spies.resync).toHaveBeenLastCalledWith({
			guildId: GUILD_ID,
			epoch: 2,
			reconnectAttempts: 1,
			botUserId: AUTHOR_ID,
			lastDeliveredInstant: CREATED_AT,
			affectedKinds: []
		});
	});
	it("double create is a no-op and a late pre-edit create cannot regress content; logs contain only safe facts", async () => {
		const f = fixture();
		await f.binding.handle(created);
		const before = [...f.store.rows.values()];
		await f.binding.handle(created);
		expect([...f.store.rows.values()]).toEqual(before);
		await f.binding.handle({
			kind: DiscordEventKind.messageUpdated,
			guildId: GUILD_ID,
			channelId: CHANNEL_ID,
			messageId: MESSAGE_ID,
			content: "newer",
			editedInstant: EDITED_AT
		});
		await f.binding.handle(created);
		expect(f.store.rows.get(MESSAGE_ID)?.content).toBe("newer");
		const transcript = JSON.stringify(f.logger);
		for (const secret of [SECRET_CONTENT, SECRET_USERNAME, SECRET_FILENAME, SECRET_URL, "newer"])
			expect(transcript).not.toContain(secret);
	});
});
