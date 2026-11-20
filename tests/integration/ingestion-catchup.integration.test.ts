import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";
import { DiscordRestFailureError } from "../../src/features/discord/index.js";
import { BackfillChannelHistoryCommand } from "../../src/features/ingestion/commands/backfill-channel-history.command.js";
import { CatchUpOutstandingChannelsCommand } from "../../src/features/ingestion/commands/catch-up-outstanding-channels.command.js";
import { createIngestionConfig } from "../../src/features/ingestion/config/ingestion-config.interface.js";
import type { IngestionConfig } from "../../src/features/ingestion/config/ingestion-config.interface.js";
import { IngestionCatchUpWorker } from "../../src/features/ingestion/ingestion-catch-up.worker.js";
import { CATCH_UP_BACKOFF_BASE_MS } from "../../src/features/ingestion/models/domain/catch-up-backoff.js";
import type { ChannelImportProgress } from "../../src/features/ingestion/models/domain/import-progress.js";
import { PostgresImportProgressRepository } from "../../src/features/ingestion/repositories/postgres-import-progress.repository.js";
import { PostgresMessageStoreRepository } from "../../src/features/ingestion/repositories/postgres-message-store.repository.js";
import type { MessageHistoryGateway } from "../../src/features/ingestion/gateways/message-history-gateway.interface.js";
import { RecordingLogger } from "../features/ingestion/fakes/recording-logger.js";
import {
	AUTHOR_ID,
	CHANNEL_ID,
	CREATED_AT,
	GUILD_ID,
	OTHER_CHANNEL_ID,
	SECRET_CONTENT,
	THREAD_ID
} from "../features/ingestion/fakes/message-fixtures.js";

/**
 * `odd/tasks/ingestion-catchup.md` S6 on a real, isolated PostgreSQL — the six named cases plus the two policy
 * facts T3 states that no fake can prove:
 *
 * - the ledger survives a **new command instance** (`catchup-derives-from-persisted-state`,
 *   `restart-resumes-without-rereading-completed-channels`), which is the whole point of the table: a process
 *   restart no longer re-reads ~1 800 pages to rediscover 166 866 stored messages;
 * - the tick's bounds are the query's `LIMIT` and the walk's page bound, not a hope
 *   (`catchup-respects-tick-bounds`);
 * - a 429 keeps the cursor, records a backoff instant in the future and is not retried in the same tick
 *   (`catchup-rate-limit-defers-at-cursor`), and a 4xx skips without a backoff (T3);
 * - a completed channel costs **zero history reads** afterwards (`catchup-completes-and-stops`).
 *
 * Everything is asserted through the public interfaces — the repository, the worker's `runTick()`, and row counts
 * — never by reading an internal map. The scripted history gateway is a double for Discord's REST boundary only:
 * the SQL, the ledger and the walk are the real ones.
 */

const NOW = new Date("2026-11-16T10:00:00.000Z");

/** A message id per page position, so a cursor is a name a reader can follow. */
const PAGE_ONE = ["160000000000000901", "160000000000000902"] as const;
const PAGE_TWO = ["160000000000000903", "160000000000000904"] as const;

type ScriptedPages = Readonly<Record<string, readonly (readonly string[])[]>>;

interface HistoryRead {
	readonly channelId: string;
	readonly before: string | undefined;
}

/**
 * Discord's message-history contract, scripted per channel as pages ordered newest first. The cursor rule is the
 * walk's own: the next page is the one after the page whose oldest id is the `before` value, and an unknown or
 * absent cursor starts at the newest page.
 */
function scriptedHistory(
	pages: ScriptedPages,
	failOn?: (input: HistoryRead) => Error | null
): MessageHistoryGateway & { readonly reads: HistoryRead[] } {
	const reads: HistoryRead[] = [];
	return {
		reads,
		readMessageHistoryPage: async (read) => {
			const observed: HistoryRead = { channelId: read.channelId, before: read.before };
			reads.push(observed);
			const failure = failOn?.(observed);
			if (failure !== null && failure !== undefined) throw failure;

			const channelPages = pages[read.channelId] ?? [];
			const index =
				read.before === undefined
					? 0
					: (() => {
							const at = channelPages.findIndex((page) => page.at(-1) === read.before);
							return at === -1 ? channelPages.length : at + 1;
						})();
			const messageIds = channelPages[index] ?? [];
			const hasMore = index < channelPages.length - 1;
			const nextBeforeId = messageIds.at(-1);

			return {
				channelId: read.channelId,
				requestedLimit: read.limit ?? 100,
				hasMore,
				messages: messageIds.map((messageId) => ({
					messageId,
					channelId: read.channelId,
					authorId: AUTHOR_ID,
					content: SECRET_CONTENT,
					createdInstant: CREATED_AT,
					messageType: "default" as const
				})),
				...(hasMore && nextBeforeId !== undefined ? { nextBeforeId } : {})
			};
		}
	};
}

/** The row a previous attempt, or a previous process, left in the ledger. */
function ledgerRow(overrides: Partial<ChannelImportProgress> & { channelId: string }): ChannelImportProgress {
	return {
		status: "deferred",
		nextBeforeId: null,
		stopReason: "rest-transient-failure",
		restFailureReason: "rate-limit",
		pagesRead: 0,
		messagesStored: 0,
		messagesUnchanged: 0,
		messagesOutsideWindow: 0,
		attachmentsWritten: 0,
		attempts: 0,
		nextAttemptAt: null,
		...overrides
	};
}

describe.skipIf(!HAS_TEST_DATABASE)("ingestion catch-up (real PostgreSQL)", () => {
	let database: IsolatedTestDatabase;
	let progressRepository: PostgresImportProgressRepository;
	let messageStore: PostgresMessageStoreRepository;

	beforeAll(async () => {
		database = await openIsolatedTestDatabase("ingestion_catchup");
		progressRepository = new PostgresImportProgressRepository(database.executor);
		messageStore = new PostgresMessageStoreRepository({
			executor: database.executor,
			writeBatchSize: 200,
			exclusionPageSize: 200
		});
	}, 180_000);

	afterAll(async () => {
		await database?.close();
	});

	beforeEach(async () => {
		await database.resetMessageStore();
	});

	/**
	 * The production wiring, minus Nest: the same command, worker, repositories and real walk. `progress` is a
	 * parameter so a test can hand in a *new* repository instance and prove nothing is remembered in process.
	 */
	function mount(options: {
		pages: ScriptedPages;
		failOn?: (input: HistoryRead) => Error | null;
		config?: Partial<IngestionConfig>;
		progress?: PostgresImportProgressRepository;
	}): {
		readonly worker: IngestionCatchUpWorker;
		readonly logger: RecordingLogger;
		readonly reads: HistoryRead[];
	} {
		const history = scriptedHistory(options.pages, options.failOn);
		const config = createIngestionConfig({
			guildId: GUILD_ID,
			importWindow: { mode: "full" },
			catchUpChannelsPerTick: 5,
			catchUpPagesPerChannelPerTick: 20,
			...options.config
		});
		const logger = new RecordingLogger();
		const backfill = new BackfillChannelHistoryCommand({ config, history, messageStore, logger });
		const command = new CatchUpOutstandingChannelsCommand({
			config,
			progress: options.progress ?? progressRepository,
			backfill,
			logger,
			clock: () => NOW
		});

		return { worker: new IngestionCatchUpWorker(command, config, logger), logger, reads: history.reads };
	}

	async function storedRow(channelId: string): Promise<ChannelImportProgress> {
		const stored = (await progressRepository.loadAll(GUILD_ID)).find((row) => row.channelId === channelId);
		if (stored === undefined) throw new Error(`no ledger row for ${channelId}`);
		return stored;
	}

	async function storedMessageCount(): Promise<number> {
		const { rows } = await database.pool.query<{ total: string }>("SELECT count(*)::text AS total FROM message");
		return Number(rows[0]?.total ?? "0");
	}

	it("catchup-advances-outstanding-channel", async () => {
		// A previous attempt read page one and was deferred at its cursor.
		await progressRepository.saveAll(GUILD_ID, [
			ledgerRow({ channelId: CHANNEL_ID, nextBeforeId: PAGE_ONE[1], pagesRead: 1, messagesStored: 2 })
		]);
		const { worker, reads } = mount({ pages: { [CHANNEL_ID]: [PAGE_ONE, PAGE_TWO] } });

		const tick = await worker.runTick();

		expect(tick).toMatchObject({ channelsConsidered: 1, channelsCompleted: 1, channelsDeferred: 0 });
		// It resumed at the stored cursor rather than at the newest page: one read, for page two only.
		expect(reads).toEqual([{ channelId: CHANNEL_ID, before: PAGE_ONE[1] }]);
		expect(await storedRow(CHANNEL_ID)).toMatchObject({
			status: "complete",
			nextBeforeId: null,
			stopReason: "history-exhausted",
			attempts: 0,
			nextAttemptAt: null,
			pagesRead: 2,
			// Cumulative: the two rows the seeded attempt counted, plus the two this tick stored.
			messagesStored: 4
		});
		// The rows actually written by this tick: page two, and only page two.
		expect(await storedMessageCount()).toBe(2);
	});

	it("catchup-derives-from-persisted-state", async () => {
		// Two rows: one finished by a previous process, one still deferred. Nothing is in memory.
		await progressRepository.saveAll(GUILD_ID, [
			ledgerRow({ channelId: CHANNEL_ID, status: "complete", nextBeforeId: null, pagesRead: 3 }),
			ledgerRow({ channelId: OTHER_CHANNEL_ID, nextBeforeId: null, pagesRead: 1 })
		]);
		const fresh = new PostgresImportProgressRepository(database.executor);
		const { worker, reads } = mount({
			pages: { [OTHER_CHANNEL_ID]: [PAGE_ONE] },
			progress: fresh
		});

		const tick = await worker.runTick();

		// The new instance knows which channel is outstanding from the table alone (S2).
		expect(tick).toMatchObject({ channelsConsidered: 1, channelsCompleted: 1 });
		expect(reads.map((read) => read.channelId)).toEqual([OTHER_CHANNEL_ID]);
		expect((await storedRow(CHANNEL_ID)).status).toBe("complete");
		expect((await storedRow(OTHER_CHANNEL_ID)).status).toBe("complete");
		// The completed row's counters are untouched: nothing re-walked it.
		expect((await storedRow(CHANNEL_ID)).pagesRead).toBe(3);
	});

	it("catchup-respects-tick-bounds", async () => {
		const channels = [CHANNEL_ID, OTHER_CHANNEL_ID, THREAD_ID];
		await progressRepository.saveAll(
			GUILD_ID,
			channels.map((channelId) => ledgerRow({ channelId }))
		);
		const pages = Object.fromEntries(channels.map((channelId) => [channelId, [PAGE_ONE]]));
		const { worker, reads } = mount({ pages, config: { catchUpChannelsPerTick: 2 } });

		const first = await worker.runTick();
		expect(first.channelsConsidered).toBe(2);
		expect(reads).toHaveLength(2);

		// The channel the channel bound left behind is the only one the next tick finds.
		const second = await worker.runTick();
		expect(second.channelsConsidered).toBe(1);
		expect(reads).toHaveLength(3);
	});

	it("catchup-respects-pages-per-channel-per-tick", async () => {
		const pages = [PAGE_ONE, PAGE_TWO, ["160000000000000905"]];
		await progressRepository.saveAll(GUILD_ID, [ledgerRow({ channelId: CHANNEL_ID })]);
		const { worker, reads } = mount({
			pages: { [CHANNEL_ID]: pages },
			config: { catchUpPagesPerChannelPerTick: 2 }
		});

		const tick = await worker.runTick();

		// Two pages, no more: the third is outstanding work at the cursor, never completion.
		expect(reads).toHaveLength(2);
		expect(tick).toMatchObject({ channelsConsidered: 1, channelsPartial: 1, channelsCompleted: 0 });
		expect(await storedRow(CHANNEL_ID)).toMatchObject({
			status: "partial",
			stopReason: "page-bound",
			nextBeforeId: PAGE_TWO[1],
			attempts: 0,
			nextAttemptAt: null
		});
	});

	it("catchup-rate-limit-defers-at-cursor", async () => {
		await progressRepository.saveAll(GUILD_ID, [
			ledgerRow({ channelId: CHANNEL_ID, nextBeforeId: PAGE_ONE[1], pagesRead: 1 })
		]);
		const { worker, reads, logger } = mount({
			pages: { [CHANNEL_ID]: [PAGE_ONE, PAGE_TWO] },
			failOn: () =>
				new DiscordRestFailureError({
					operation: "discord-rest.message-history",
					reason: "rate-limit",
					detail: "too many requests",
					attempts: 3,
					status: 429
				})
		});

		const tick = await worker.runTick();

		expect(tick).toMatchObject({ channelsConsidered: 1, channelsDeferred: 1, channelsCompleted: 0 });
		// Not retried inside the tick: one request, and the cursor is where it already was.
		expect(reads).toHaveLength(1);
		const stored = await storedRow(CHANNEL_ID);
		expect(stored).toMatchObject({
			status: "deferred",
			stopReason: "rest-transient-failure",
			restFailureReason: "rate-limit",
			nextBeforeId: PAGE_ONE[1],
			pagesRead: 1,
			attempts: 1
		});
		expect(stored.nextAttemptAt?.toISOString()).toBe(
			new Date(NOW.getTime() + CATCH_UP_BACKOFF_BASE_MS).toISOString()
		);

		// The tick's own line carries ids and counts, and no message content (R12).
		const line = logger.messagesMatching("catch-up tick")[0];
		expect(line?.fields).toMatchObject({
			channelsConsidered: 1,
			channelsDeferred: 1,
			channelsCompleted: 0,
			failedChannelIds: []
		});
		expect(logger.transcript()).not.toContain(SECRET_CONTENT);
	});

	it("catchup-skips-on-access-loss-without-a-backoff", async () => {
		await progressRepository.saveAll(GUILD_ID, [ledgerRow({ channelId: CHANNEL_ID, attempts: 2 })]);
		const { worker } = mount({
			pages: { [CHANNEL_ID]: [PAGE_ONE] },
			failOn: () =>
				new DiscordRestFailureError({
					operation: "discord-rest.message-history",
					reason: "not-found",
					detail: "channel unavailable",
					attempts: 1,
					status: 404
				})
		});

		const tick = await worker.runTick();

		expect(tick).toMatchObject({ channelsConsidered: 1, channelsSkipped: 1 });
		// T3: a 4xx is a condition of the channel, so it carries no delay — and no accumulated attempts either.
		expect(await storedRow(CHANNEL_ID)).toMatchObject({
			status: "skipped",
			stopReason: "rest-access-lost",
			attempts: 0,
			nextAttemptAt: null
		});
	});

	it("catchup-completes-and-stops", async () => {
		await progressRepository.saveAll(GUILD_ID, [ledgerRow({ channelId: CHANNEL_ID })]);
		const { worker, reads } = mount({ pages: { [CHANNEL_ID]: [PAGE_ONE] } });

		expect((await worker.runTick()).channelsCompleted).toBe(1);
		const readsAfterCompletion = reads.length;
		expect(readsAfterCompletion).toBe(1);

		// A completed row is not selected again, so the channel is not read again.
		const next = await worker.runTick();
		expect(next).toMatchObject({ channelsConsidered: 0, channelsCompleted: 0 });
		expect(reads).toHaveLength(readsAfterCompletion);
	});

	it("restart-resumes-without-rereading-completed-channels", async () => {
		// What a previous process left: one channel finished, one still deferred at a cursor.
		await progressRepository.saveAll(GUILD_ID, [
			ledgerRow({
				channelId: CHANNEL_ID,
				status: "complete",
				nextBeforeId: null,
				stopReason: "window-bound",
				restFailureReason: null,
				pagesRead: 4,
				messagesStored: 10
			}),
			ledgerRow({ channelId: OTHER_CHANNEL_ID, nextBeforeId: PAGE_ONE[1], pagesRead: 1, messagesStored: 2 })
		]);
		// A new process: new repository, new command, new worker. Nothing survives but the table.
		const restarted = mount({
			pages: { [OTHER_CHANNEL_ID]: [PAGE_ONE, PAGE_TWO], [CHANNEL_ID]: [PAGE_ONE] },
			progress: new PostgresImportProgressRepository(database.executor)
		});

		const tick = await restarted.worker.runTick();

		expect(tick).toMatchObject({ channelsConsidered: 1, channelsCompleted: 1 });
		expect(restarted.reads.map((read) => read.channelId)).toEqual([OTHER_CHANNEL_ID]);
		expect(restarted.reads.filter((read) => read.channelId === CHANNEL_ID)).toHaveLength(0);
		// The resumed channel picked up exactly where it stopped.
		expect(restarted.reads[0]?.before).toBe(PAGE_ONE[1]);
		expect(await storedRow(OTHER_CHANNEL_ID)).toMatchObject({
			status: "complete",
			pagesRead: 2,
			messagesStored: 4
		});
	});
});
