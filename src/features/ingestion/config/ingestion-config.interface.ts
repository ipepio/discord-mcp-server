import { InvalidMessageBatchError } from "../models/domain/ingestion-store.errors.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import { DISCORD_MESSAGE_PAGE_SIZE_MAX } from "../../discord/index.js";
import type { ImportMode, ImportWindow } from "../models/domain/import-window.js";
import { IMPORT_MODES, MAX_IMPORT_DAYS } from "../models/domain/import-window.js";
import {
	InvalidCatchUpConfigurationError,
	InvalidImportWindowError,
	InvalidResyncConfigurationError
} from "./ingestion-config.errors.js";
import type { IngestionConfigurationError } from "./ingestion-config.errors.js";
import {
	DEFAULT_MESSAGE_EXCLUSION_PAGE_SIZE,
	DEFAULT_MESSAGE_WRITE_BATCH_SIZE,
	resolveWriteBatchSize
} from "../repositories/message-write-batch.js";

/**
 * What ingestion needs to know about this Installation (docs/features/ingestion.md R1, R3, R6) and the bounds
 * its own writes obey.
 *
 * The Guild id is not ingestion's to parse: the `discord` feature owns reading `DISCORD_GUILD_ID` and
 * validating it once, and the composition hands the same value here through `DISCORD_CONFIG_TOKEN`, exactly
 * as guild-state takes it. One source, one validator, so the message store cannot be scoped to a Guild the
 * connection is not serving (R1) and a backfill cannot read a Guild the event stream is not feeding.
 *
 * The bounds are ingestion's own: "batch writes declare a page or key bound before execution"
 * (docs/architecture/persistence.md) is a store concern, and the numbers have to be stated somewhere a test
 * can read them.
 *
 * The import window is R3's, and it is stated here rather than read from the environment inside a command
 * because Prerequisites make it startup configuration ("no scattered `process.env` reads") and because a
 * resync run needs the same window a first import used. `./ingestion-config.validator.js` is the half that
 * turns `IMPORT_MODE`/`IMPORT_DAYS` into the value below; this file is the half that validates the value.
 */

/** How wide one message-store write batch is, and how many rows one bulk-exclusion page fetches. */
export interface MessageStoreBounds {
	/** Messages per upsert statement, one transaction each. Clamped to the repository ceiling. */
	readonly writeBatchSize: number;
	/** Rows a bulk exclusion marks per page. Sweep length is bounded by progress, not by this number. */
	readonly exclusionPageSize: number;
}

/**
 * The bounds of one history walk. Both are declared before a page is asked for, which is what
 * persistence.md asks of a bounded read, and both are the reason a walk cannot run away: the page size is
 * Discord's own ceiling, and the page count is a per-run bound a resumable import is allowed to hit and
 * continue past on the next run (R3).
 */
export interface MessageHistoryBounds {
	/** Messages asked for per history page. Clamped to Discord's ceiling for a message page. */
	readonly pageSize: number;
	/** Pages one run may read for one channel. Reaching it is reported as outstanding work, never as completion. */
	readonly maxPagesPerChannel: number;
}

/** The window as a caller declares it: a mode, and the days that mode may need. */
export interface ImportWindowInput {
	readonly mode: ImportMode;
	/** Required by `days`, not read by `full` (Prerequisites: "required and used only when `IMPORT_MODE=days`"). */
	readonly days?: number;
}

/**
 * The bounds of the periodic catch-up (docs/features/ingestion.md R14, `odd/tasks/ingestion-catchup.md` T2 and
 * T3). Four numbers and a switch, all declared here because a job that runs on its own must be bounded and
 * disableable by configuration rather than by an operator's memory.
 *
 * The environment names are documented in `docs/installation.md` and parsed once by
 * `./ingestion-config.validator.js`; nothing in the feature reads `process.env`.
 */
export interface IngestionCatchUpConfig {
	/** `INGESTION_CATCH_UP_ENABLED`: `false` means the worker never starts and nothing is retried on its own. */
	readonly catchUpEnabled: boolean;
	/** `INGESTION_CATCH_UP_INTERVAL_MS`: the delay between two ticks. */
	readonly catchUpIntervalMs: number;
	/** `INGESTION_CATCH_UP_CHANNELS_PER_TICK`: how many outstanding channels one tick may walk. */
	readonly catchUpChannelsPerTick: number;
	/** `INGESTION_CATCH_UP_PAGES_PER_CHANNEL_PER_TICK`: the page bound one channel's tick walk obeys. */
	readonly catchUpPagesPerChannelPerTick: number;
}

/**
 * The bound of one reconnect resync walk (docs/features/ingestion.md R9).
 *
 * The resync exists to close the gap that appeared while the process was not listening — hours at most, not a
 * channel's whole history. The full walk belongs to R3's import and to R14's catch-up, which resume from the
 * durable ledger; an unbounded resync made every restart re-read the entire mirror, page by page, to discover
 * that nothing had changed. So the resync declares its own page bound, and hitting it leaves the channel
 * gap-tracked at its cursor instead of claiming the channel is current.
 */
export interface IngestionResyncConfig {
	/** `INGESTION_RESYNC_MAX_PAGES_PER_CHANNEL`: the page bound one resync walk obeys, per channel. */
	readonly resyncMaxPagesPerChannel: number;
}

export interface IngestionConfig extends IngestionCatchUpConfig, IngestionResyncConfig {
	readonly guildId: string;
	readonly store: MessageStoreBounds;
	readonly history: MessageHistoryBounds;
	readonly importWindow: ImportWindow;
}

/** The v1 bounds: 200 messages per transaction, 200 rows per exclusion page. */
export const DEFAULT_MESSAGE_STORE_BOUNDS: MessageStoreBounds = Object.freeze({
	writeBatchSize: DEFAULT_MESSAGE_WRITE_BATCH_SIZE,
	exclusionPageSize: DEFAULT_MESSAGE_EXCLUSION_PAGE_SIZE
});

/**
 * The v1 history bounds: Discord's own page ceiling, and 500 pages per channel per run — 50 000 messages,
 * after which the channel is reported outstanding at its cursor and the next run resumes (R3's resumable job,
 * persistence.md's declared bound).
 */
export const DEFAULT_MESSAGE_HISTORY_BOUNDS: MessageHistoryBounds = Object.freeze({
	pageSize: DISCORD_MESSAGE_PAGE_SIZE_MAX,
	maxPagesPerChannel: 500
});

/**
 * R3's widest window. A programmatic construction that names no window means `full`, which is the mode
 * project-context names as this Installation's default ("historical import: full history by default"). A
 * deployment does not get this default for free: `loadIngestionImportWindow` requires `IMPORT_MODE` to be
 * declared, exactly as Prerequisites require the configuration to be valid or missing-and-fatal.
 */
export const DEFAULT_IMPORT_WINDOW: ImportWindow = Object.freeze({ mode: "full" });

/**
 * R14's catch-up as an installation that declares nothing runs it: enabled, one tick every five minutes, five
 * channels and twenty pages per channel per tick. The four numbers are deliberately small — the job exists to
 * close a handful of deferred channels, not to import a Guild a second time — and every one of them is stated
 * in `docs/installation.md` so an operator can tighten or widen it.
 */
export const DEFAULT_INGESTION_CATCH_UP: IngestionCatchUpConfig = Object.freeze({
	catchUpEnabled: true,
	catchUpIntervalMs: 300_000,
	catchUpChannelsPerTick: 5,
	catchUpPagesPerChannelPerTick: 20
});

/**
 * R9's resync as an installation that declares nothing runs it: five pages per channel per reconnect — 500
 * messages, which is the window a process that was not listening can have missed. It is deliberately much
 * smaller than the import or the catch-up, because those are the walks that own a channel's whole history and
 * they resume from the ledger; the resync only has to close the gap. `docs/installation.md` states the number
 * so an operator can widen it for an outage that lasted longer than the default covers.
 */
export const DEFAULT_INGESTION_RESYNC: IngestionResyncConfig = Object.freeze({ resyncMaxPagesPerChannel: 5 });

export interface IngestionConfigInput {
	/** The configured Guild id, taken from the `discord` feature's validated configuration. */
	readonly guildId: string;
	/** Bounds a deployment may tighten; a partial block keeps the defaults it does not name. */
	readonly store?: Partial<MessageStoreBounds>;
	/** History bounds, tightened the same way. */
	readonly history?: Partial<MessageHistoryBounds>;
	/** The declared import window. Absent means {@link DEFAULT_IMPORT_WINDOW}. */
	readonly importWindow?: ImportWindowInput;
	/** The catch-up bounds a deployment declared. Each absent value keeps {@link DEFAULT_INGESTION_CATCH_UP}. */
	readonly catchUpEnabled?: boolean;
	readonly catchUpIntervalMs?: number;
	readonly catchUpChannelsPerTick?: number;
	readonly catchUpPagesPerChannelPerTick?: number;
	/** R9's resync page bound; absent keeps {@link DEFAULT_INGESTION_RESYNC}. */
	readonly resyncMaxPagesPerChannel?: number;
}

/**
 * R3's window, validated: one of the two admitted modes, a whole positive number of days when the bounded mode
 * is chosen, and a bound whose cutoff instant a `timestamptz` can still hold. A `days` value handed to `full`
 * is not read — the mode says the whole history is wanted, and keeping a number that cannot mean anything
 * would be a second, quieter window rule.
 *
 * Exported because the environment validator and every test that builds a window go through this one copy of
 * the rule instead of restating it.
 */
export function resolveImportWindow(declared: ImportWindowInput): ImportWindow {
	if (!(IMPORT_MODES as readonly string[]).includes(declared.mode)) {
		throw new InvalidImportWindowError(
			"importWindow.mode",
			`expected one of ${IMPORT_MODES.join(", ")}, got ${JSON.stringify(declared.mode)}`
		);
	}

	if (declared.mode === "full") {
		return { mode: "full" };
	}

	const days = declared.days;
	if (days === undefined) {
		throw new InvalidImportWindowError("importWindow.days", "IMPORT_MODE=days declares no window to bound");
	}

	if (!Number.isInteger(days) || days < 1) {
		throw new InvalidImportWindowError("importWindow.days", "expected a whole number of days of at least 1");
	}

	if (days > MAX_IMPORT_DAYS) {
		throw new InvalidImportWindowError(
			"importWindow.days",
			`its cutoff instant would fall outside the storable timestamp range (max ${MAX_IMPORT_DAYS})`
		);
	}

	return { mode: "days", days };
}

/**
 * R14's four bounds, validated: the switch is a boolean, and each period, channel count and page count is a
 * whole positive number. A zero interval or a zero channel count would make the job either a spin or a no-op
 * that silently never closes a channel, so neither is a value this validator keeps.
 */
function resolveCatchUpConfig(declared: {
	readonly catchUpEnabled?: boolean;
	readonly catchUpIntervalMs?: number;
	readonly catchUpChannelsPerTick?: number;
	readonly catchUpPagesPerChannelPerTick?: number;
}): IngestionCatchUpConfig {
	return {
		catchUpEnabled: declared.catchUpEnabled ?? DEFAULT_INGESTION_CATCH_UP.catchUpEnabled,
		catchUpIntervalMs: requireCatchUpBound(
			"catchUpIntervalMs",
			declared.catchUpIntervalMs ?? DEFAULT_INGESTION_CATCH_UP.catchUpIntervalMs
		),
		catchUpChannelsPerTick: requireCatchUpBound(
			"catchUpChannelsPerTick",
			declared.catchUpChannelsPerTick ?? DEFAULT_INGESTION_CATCH_UP.catchUpChannelsPerTick
		),
		catchUpPagesPerChannelPerTick: requireCatchUpBound(
			"catchUpPagesPerChannelPerTick",
			declared.catchUpPagesPerChannelPerTick ?? DEFAULT_INGESTION_CATCH_UP.catchUpPagesPerChannelPerTick
		)
	};
}

function requireCatchUpBound(field: string, declared: number): number {
	return requirePositiveWholeBound(field, declared, InvalidCatchUpConfigurationError);
}

/**
 * R9's resync page bound, validated the same way and refused by its own error: a bound of zero would make the
 * resync a no-op that recorded a gap on every reconnect, and a fractional one is a caller's defect rather than
 * a number to round.
 */
function requireResyncBound(field: string, declared: number): number {
	return requirePositiveWholeBound(field, declared, InvalidResyncConfigurationError);
}

/** One declared bound: a whole positive number, or the feature's own refusal naming the setting. */
function requirePositiveWholeBound(
	field: string,
	declared: number,
	refuse: new (field: string, reason: string) => IngestionConfigurationError
): number {
	if (!Number.isInteger(declared) || declared < 1) {
		throw new refuse(field, "expected a positive whole number");
	}

	return declared;
}

/**
 * One validator for the whole feature: the Guild id must be storable as a `bigint`, every bound must be a
 * positive whole number, and the declared import window must be one R3 admits. A broken deployment throws at
 * composition instead of discovering it mid-backfill.
 */
export function createIngestionConfig(input: IngestionConfigInput): IngestionConfig {
	const store = input.store ?? {};
	const history = input.history ?? {};
	const exclusionPageSize = store.exclusionPageSize ?? DEFAULT_MESSAGE_STORE_BOUNDS.exclusionPageSize;
	if (!Number.isInteger(exclusionPageSize) || exclusionPageSize < 1) {
		throw new InvalidMessageBatchError(
			"store.exclusionPageSize",
			"the exclusion page bound must be a positive whole number"
		);
	}

	const maxPagesPerChannel = history.maxPagesPerChannel ?? DEFAULT_MESSAGE_HISTORY_BOUNDS.maxPagesPerChannel;
	if (!Number.isInteger(maxPagesPerChannel) || maxPagesPerChannel < 1) {
		throw new InvalidMessageBatchError(
			"history.maxPagesPerChannel",
			"the per-channel page bound must be a positive whole number"
		);
	}

	const pageSize = history.pageSize ?? DEFAULT_MESSAGE_HISTORY_BOUNDS.pageSize;
	if (!Number.isInteger(pageSize) || pageSize < 1) {
		throw new InvalidMessageBatchError("history.pageSize", "the history page size must be a positive whole number");
	}

	return {
		...resolveCatchUpConfig(input),
		resyncMaxPagesPerChannel: requireResyncBound(
			"resyncMaxPagesPerChannel",
			input.resyncMaxPagesPerChannel ?? DEFAULT_INGESTION_RESYNC.resyncMaxPagesPerChannel
		),
		guildId: requireDiscordIdentifier("ingestion.guild_id", input.guildId),
		store: {
			writeBatchSize: resolveWriteBatchSize(store.writeBatchSize ?? DEFAULT_MESSAGE_STORE_BOUNDS.writeBatchSize),
			exclusionPageSize
		},
		history: {
			// Discord answers a history read with at most its own ceiling of messages, whatever a caller asks
			// for; clamping here is what makes the declared bound the number the walk actually obeys.
			pageSize: Math.min(pageSize, DISCORD_MESSAGE_PAGE_SIZE_MAX),
			maxPagesPerChannel
		},
		importWindow: resolveImportWindow(input.importWindow ?? DEFAULT_IMPORT_WINDOW)
	};
}
