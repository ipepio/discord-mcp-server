import { DiscordRestFailureError } from "../../discord/index.js";
import type { DiscordMessageHistoryPage, DiscordRestFailureReason } from "../../discord/index.js";
import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { IngestionConfig } from "../config/ingestion-config.interface.js";
import type { MessageHistoryGateway } from "../gateways/message-history-gateway.interface.js";
import type { ChannelHistoryStopReason, HistoryFailureClass } from "../models/domain/history-walk-rules.js";
import { classifyHistoryFailure, olderHistoryCursor } from "../models/domain/history-walk-rules.js";
import { messageIsInsideWindow, pageLiesOutsideWindow } from "../models/domain/import-window.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import { InvalidMessageBatchError } from "../models/domain/ingestion-store.errors.js";
import { toHistoryMessageWrite } from "../models/mappers/message-history.mapper.js";
import type { MessageStoreRepository } from "../repositories/message-store.repository.js";

/**
 * One channel's history walk, over the discord feature's backfill contract (docs/features/ingestion.md R3 and
 * R9, applied through R4, R7, R8, R11 and R12).
 *
 * This is the walk itself, and it is a command of its own for the reason guild-state states for its resync:
 * **reuse the path, never duplicate it**. The historical import (R3) and the reconnect gap backfill (R9) read
 * the same pages, apply them through the same idempotent batch write, and stop for the same six reasons; only
 * *why* they started and *what they record afterwards* differ. Two copies of a paging loop is two copies of
 * the stop rule, and a boundary that drifts between them is a silent message loss.
 *
 * The four decisions this command owns:
 *
 * - **Bounded pages, declared before the first read.** `config.history.pageSize` is the request and
 *   `config.history.maxPagesPerChannel` is how far one run may go for one channel. Reaching the bound is
 *   reported as `page-bound` — outstanding work at a cursor, never completion — because R3's import is a
 *   resumable job and a bound that quietly ended a walk would make the resume impossible.
 * - **Resume from a cursor, when one is handed in.** A walk started at `resumeBeforeId` continues the older
 *   pages of a previous run; a walk started without one begins at the channel's newest message.
 * - **The window, as a bound and a stop rule.** `cutoffInstant` is R3's lower bound (strictly after) or, for a
 *   gap backfill, R9's missed-window floor. Messages at or before it are counted, not stored; the walk stops
 *   at the first message at or before the cutoff; Discord pages newest-first.
 * - **Failure, classified.** A rate limit, a 5xx, a timeout and a transport failure are `rest-transient-failure`
 *   — the adapter has already spent its bounded retries, so the walk stops here and resumes at its cursor on a
 *   later run (R3: retries and resume, not import failure). A 4xx is `rest-access-lost`: the channel cannot be
 *   read and the caller decides whether that means skip. A payload that did not validate is
 *   `rest-payload-invalid`, reported as the defect it is rather than folded into either. Anything that is not
 *   a named boundary failure propagates: a repository statement or a defect does not get to look like Discord's
 *   fault (docs/architecture/shared.md: unexpected failures stay unexpected).
 *
 * What this command never does: it does not choose which channels to walk, it does not remember cursors
 * (that is the ledger each caller writes), and it does not read a stored row to ask whether a message is
 * already there. R7 and R8 are the store's guard clause; every page is applied whether or not anything in it
 * will change, and the counts say what did.
 *
 * R12: one structured line per page, carrying ids, counts and the cursor. No message content, no filename, no
 * URL, no author name.
 */

/** One walk of one channel. */
export interface BackfillChannelHistoryInput {
	readonly channelId: DiscordIdentifier;
	/** R3's lower bound, or R9's gap floor. `null` states "no bound": the retrievable history is the window. */
	readonly cutoffInstant: Date | null;
	/** The cursor a resumed walk starts from; `null` starts at the channel's newest message. */
	readonly resumeBeforeId?: string | null;
	/**
	 * A tighter page bound than `config.history.maxPagesPerChannel`, for a caller that already has one. R14's
	 * catch-up asks for a few pages per channel per tick, and the bound is declared here — before the first read —
	 * rather than enforced afterwards (docs/architecture/persistence.md). Absent means the configured bound.
	 */
	readonly maxPages?: number;
}

/** A history read that failed, in the facts R3 and R7 name it by. Never a payload, never content. */
export interface ChannelHistoryFailure {
	/** What the failure means for the walk, not the transport code that produced it. */
	readonly class: HistoryFailureClass;
	readonly restReason: DiscordRestFailureReason;
	readonly attempts: number;
	readonly httpStatus: number | null;
	readonly fieldPath: string | null;
}

/** What one walk did, and why it stopped. */
export interface BackfillChannelHistoryResult {
	readonly guildId: DiscordIdentifier;
	readonly channelId: DiscordIdentifier;
	/** True when the walk began at a cursor a previous run left behind. */
	readonly resumedFromCursor: boolean;
	readonly stop: ChannelHistoryStopReason;
	readonly failure: ChannelHistoryFailure | null;
	readonly pagesRead: number;
	readonly messagesStored: number;
	/** Rows R7's store guard refused: already as current as this page said, or tombstoned and therefore terminal. */
	readonly messagesUnchanged: number;
	/** Messages R3's window excluded. Counted, so an excluded edge is visible in the report. */
	readonly messagesOutsideWindow: number;
	readonly replyReferencesDropped: number;
	readonly attachmentsWritten: number;
	readonly attachmentsRemoved: number;
	/** Where a later run picks up. `null` when the walk reached the end of what can be read. */
	readonly nextBeforeId: string | null;
}

export interface BackfillChannelHistoryDeps {
	readonly config: IngestionConfig;
	readonly history: MessageHistoryGateway;
	readonly messageStore: MessageStoreRepository;
	readonly logger: AppLogger;
}

export class BackfillChannelHistoryCommand {
	private readonly guildId: DiscordIdentifier;

	private readonly pageSize: number;

	private readonly maxPagesPerChannel: number;

	private readonly history: MessageHistoryGateway;

	private readonly messageStore: MessageStoreRepository;

	private readonly logger: AppLogger;

	public constructor(deps: BackfillChannelHistoryDeps) {
		this.guildId = deps.config.guildId;
		this.pageSize = deps.config.history.pageSize;
		this.maxPagesPerChannel = deps.config.history.maxPagesPerChannel;
		this.history = deps.history;
		this.messageStore = deps.messageStore;
		this.logger = deps.logger;
	}

	public readonly execute = async (input: BackfillChannelHistoryInput): Promise<BackfillChannelHistoryResult> => {
		const channelId = requireDiscordIdentifier("message.channel_id", input.channelId);
		const cutoff = input.cutoffInstant;
		const resumedFromCursor = (input.resumeBeforeId ?? null) !== null;
		const pageBound = this.pageBound(input.maxPages);

		const totals = {
			pagesRead: 0,
			messagesStored: 0,
			messagesUnchanged: 0,
			messagesOutsideWindow: 0,
			replyReferencesDropped: 0,
			attachmentsWritten: 0,
			attachmentsRemoved: 0
		};

		let cursor = input.resumeBeforeId ?? null;

		for (let pageNumber = 1; pageNumber <= pageBound; pageNumber += 1) {
			let page: DiscordMessageHistoryPage;

			try {
				page = await this.history.readMessageHistoryPage({
					channelId,
					limit: this.pageSize,
					// An absent cursor is "from the newest message"; `before: null` would be a bound Discord never admits.
					...(cursor === null ? {} : { before: cursor })
				});
			} catch (failure) {
				if (!(failure instanceof DiscordRestFailureError)) {
					throw failure;
				}

				const reported = this.toReportedFailure(failure);
				this.logger.warn("ingestion stopped a channel history walk on a discord read failure", {
					guildId: this.guildId,
					channelId,
					operation: "backfill-channel-history",
					page: pageNumber,
					...reported,
					resumedFromCursor
				});

				return {
					guildId: this.guildId,
					channelId,
					resumedFromCursor,
					stop: reported.class,
					failure: reported,
					...totals,
					// The cursor this run has reached is still the cursor the next run resumes from.
					nextBeforeId: cursor
				};
			}

			totals.pagesRead += 1;
			const applied = await this.applyPage(page, cutoff);
			totals.messagesStored += applied.rowsWritten;
			totals.messagesUnchanged += applied.rowsSkipped;
			totals.messagesOutsideWindow += applied.outsideWindow;
			totals.replyReferencesDropped += applied.replyReferencesDropped;
			totals.attachmentsWritten += applied.attachmentsWritten;
			totals.attachmentsRemoved += applied.attachmentsRemoved;

			const nextCursor = olderHistoryCursor(page);
			const createdInstants = page.messages.map((record) => record.createdInstant);

			// R12: progress as ids, counts and a cursor. Page length and window counts, never content.
			this.logger.info("ingestion applied a channel history page", {
				guildId: this.guildId,
				channelId,
				operation: "backfill-channel-history",
				page: pageNumber,
				messageCount: page.messages.length,
				messagesStored: applied.rowsWritten,
				messagesUnchanged: applied.rowsSkipped,
				messagesOutsideWindow: applied.outsideWindow,
				attachmentsWritten: applied.attachmentsWritten,
				cursorBeforeId: nextCursor
			});

			// The end of what can be read. Discord's own `hasMore` first, then a page that carried nothing: a
			// walk that made no progress must not spend its whole bound discovering that.
			if (!page.hasMore || page.messages.length === 0) {
				return this.finished(channelId, "history-exhausted", totals, resumedFromCursor, null);
			}

			// Newest-first ordering means the first cutoff crossing finishes the window.
			if (pageLiesOutsideWindow(createdInstants, cutoff)) {
				return this.finished(channelId, "window-bound", totals, resumedFromCursor, null);
			}

			cursor = nextCursor ?? cursor;
		}

		return this.finished(channelId, "page-bound", totals, resumedFromCursor, cursor);
	};

	/**
	 * The bound this walk obeys. A caller-supplied bound is validated rather than clamped: a zero or fractional
	 * page count is a caller's defect, and silently turning it into "the configured bound" would make a tick read
	 * five times the pages it declared.
	 */
	private pageBound(declared: number | undefined): number {
		if (declared === undefined) return this.maxPagesPerChannel;
		if (!Number.isInteger(declared) || declared < 1) {
			throw new InvalidMessageBatchError(
				"backfill-channel-history.maxPages",
				"the per-walk page bound must be a positive whole number"
			);
		}
		return declared;
	}

	/**
	 * One page, applied. Every in-window message goes into one bounded batch through the store's guarded
	 * upsert, which is what makes R3's "idempotent batches" and R7's replay-safety the same statement, and
	 * what makes R8 hold without a read: a backfill record older than stored state is refused inside the
	 * write, so a page that arrives late cannot overwrite content that arrived first.
	 *
	 * Out-of-window messages are excluded by never entering the batch, and counted so the exclusion is a
	 * reported fact rather than an absence.
	 */
	private async applyPage(
		page: DiscordMessageHistoryPage,
		cutoff: Date | null
	): Promise<{
		readonly rowsWritten: number;
		readonly rowsSkipped: number;
		readonly outsideWindow: number;
		readonly replyReferencesDropped: number;
		readonly attachmentsWritten: number;
		readonly attachmentsRemoved: number;
	}> {
		const writes = [];
		let outsideWindow = 0;
		let replyReferencesDropped = 0;

		for (const record of page.messages) {
			if (!messageIsInsideWindow(record.createdInstant, cutoff)) {
				outsideWindow += 1;
				break;
			}

			const mapped = toHistoryMessageWrite(this.guildId, record);
			if (mapped.replyReferenceDropped) {
				replyReferencesDropped += 1;
			}

			writes.push(mapped.write);
		}

		if (writes.length === 0) {
			// Nothing in window: no statement runs, so an out-of-window page cannot look like a written one.
			return {
				rowsWritten: 0,
				rowsSkipped: 0,
				outsideWindow,
				replyReferencesDropped,
				attachmentsWritten: 0,
				attachmentsRemoved: 0
			};
		}

		const written = await this.messageStore.upsertMessages(writes);
		return {
			rowsWritten: written.rowsWritten,
			rowsSkipped: written.rowsSkipped,
			outsideWindow,
			replyReferencesDropped,
			attachmentsWritten: written.attachmentsWritten,
			attachmentsRemoved: written.attachmentsRemoved
		};
	}

	private finished(
		channelId: DiscordIdentifier,
		stop: ChannelHistoryStopReason,
		totals: Pick<
			BackfillChannelHistoryResult,
			| "pagesRead"
			| "messagesStored"
			| "messagesUnchanged"
			| "messagesOutsideWindow"
			| "replyReferencesDropped"
			| "attachmentsWritten"
			| "attachmentsRemoved"
		>,
		resumedFromCursor: boolean,
		nextBeforeId: string | null
	): BackfillChannelHistoryResult {
		return {
			guildId: this.guildId,
			channelId,
			resumedFromCursor,
			stop,
			failure: null,
			...totals,
			nextBeforeId
		};
	}

	private toReportedFailure(failure: DiscordRestFailureError): ChannelHistoryFailure {
		return {
			class: classifyHistoryFailure(failure.reason),
			restReason: failure.reason,
			attempts: failure.attempts,
			httpStatus: failure.status ?? null,
			fieldPath: failure.fieldPath ?? null
		};
	}
}
