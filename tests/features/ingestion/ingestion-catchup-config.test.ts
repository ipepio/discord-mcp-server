import { describe, expect, it } from "vitest";
import {
	DEFAULT_INGESTION_CATCH_UP,
	createIngestionConfig
} from "../../../src/features/ingestion/config/ingestion-config.interface.js";
import {
	INGESTION_ENV_VARIABLES,
	loadIngestionCatchUpConfig
} from "../../../src/features/ingestion/config/ingestion-config.validator.js";
import { InvalidCatchUpConfigurationError } from "../../../src/features/ingestion/config/ingestion-config.errors.js";
import {
	CATCH_UP_BACKOFF_BASE_MS,
	CATCH_UP_BACKOFF_MAX_MS,
	nextAttemptInstant
} from "../../../src/features/ingestion/models/domain/catch-up-backoff.js";

/**
 * `odd/tasks/ingestion-catchup.md` T2 and T3 (docs/features/ingestion.md R14): the catch-up's bounds are
 * deployment configuration and its delay is a rule, so both are pinned here rather than discovered in
 * production.
 *
 * What the assertions are for:
 *
 * - **A defaulted setting is a decision, not an accident.** An installation that declares nothing must still
 *   get a bounded job (5 minutes apart, 5 channels and 20 pages per tick), and an operator who tightens one
 *   bound must not silently lose the others.
 * - **A refusal names the variable the operator wrote**, because the shared configuration contract fails
 *   startup with an explicit error and a silent fallback to "true" would start a job nobody asked for.
 * - **The backoff is exponential, capped and measured from the tick's own instant**, so a rate-limited channel
 *   is retried later instead of in the same tick, and a permanently failing channel cannot spin.
 */

const GUILD_ID = "160000000000000001";

describe("ingestion configuration — the catch-up bounds (T2)", () => {
	it("keeps the documented defaults when the deployment declares nothing", () => {
		expect(DEFAULT_INGESTION_CATCH_UP).toEqual({
			catchUpEnabled: true,
			catchUpIntervalMs: 300_000,
			catchUpChannelsPerTick: 5,
			catchUpPagesPerChannelPerTick: 20
		});
		expect(loadIngestionCatchUpConfig({})).toEqual(DEFAULT_INGESTION_CATCH_UP);
		expect(createIngestionConfig({ guildId: GUILD_ID })).toMatchObject(DEFAULT_INGESTION_CATCH_UP);
	});

	it("keeps the defaults for the variables a deployment does not declare", () => {
		expect(
			loadIngestionCatchUpConfig({
				[INGESTION_ENV_VARIABLES.catchUpChannelsPerTick]: "2",
				[INGESTION_ENV_VARIABLES.catchUpPagesPerChannelPerTick]: ""
			})
		).toEqual({
			...DEFAULT_INGESTION_CATCH_UP,
			catchUpChannelsPerTick: 2
		});
	});

	it("reads the four documented variables", () => {
		expect(
			loadIngestionCatchUpConfig({
				[INGESTION_ENV_VARIABLES.catchUpEnabled]: "false",
				[INGESTION_ENV_VARIABLES.catchUpIntervalMs]: "60000",
				[INGESTION_ENV_VARIABLES.catchUpChannelsPerTick]: "3",
				[INGESTION_ENV_VARIABLES.catchUpPagesPerChannelPerTick]: "7"
			})
		).toEqual({
			catchUpEnabled: false,
			catchUpIntervalMs: 60_000,
			catchUpChannelsPerTick: 3,
			catchUpPagesPerChannelPerTick: 7
		});
	});

	it("refuses a bound that is not a whole positive number, naming the variable", () => {
		for (const declared of ["0", "-1", "1.5", "twenty", "NaN"]) {
			expect(() => loadIngestionCatchUpConfig({ [INGESTION_ENV_VARIABLES.catchUpIntervalMs]: declared })).toThrow(
				new RegExp(INGESTION_ENV_VARIABLES.catchUpIntervalMs)
			);
			expect(() =>
				loadIngestionCatchUpConfig({ [INGESTION_ENV_VARIABLES.catchUpChannelsPerTick]: declared })
			).toThrow(new RegExp(INGESTION_ENV_VARIABLES.catchUpChannelsPerTick));
			expect(() =>
				loadIngestionCatchUpConfig({ [INGESTION_ENV_VARIABLES.catchUpPagesPerChannelPerTick]: declared })
			).toThrow(new RegExp(INGESTION_ENV_VARIABLES.catchUpPagesPerChannelPerTick));
		}
	});

	it("refuses an enabled flag that is neither true nor false", () => {
		for (const declared of ["yes", "1", "TRUE "]) {
			expect(() => loadIngestionCatchUpConfig({ [INGESTION_ENV_VARIABLES.catchUpEnabled]: declared })).toThrow(
				InvalidCatchUpConfigurationError
			);
		}
	});

	it("re-validates a programmatic construction, naming the setting that broke", () => {
		for (const catchUpChannelsPerTick of [0, -1, 1.5, Number.NaN]) {
			expect(() => createIngestionConfig({ guildId: GUILD_ID, catchUpChannelsPerTick })).toThrow(
				/catchUpChannelsPerTick/
			);
		}
		expect(() => createIngestionConfig({ guildId: GUILD_ID, catchUpIntervalMs: 0 })).toThrow(/catchUpIntervalMs/);
		expect(() => createIngestionConfig({ guildId: GUILD_ID, catchUpPagesPerChannelPerTick: 0 })).toThrow(
			/catchUpPagesPerChannelPerTick/
		);
	});
});

describe("catch-up backoff (T3)", () => {
	const now = new Date("2026-11-16T10:00:00.000Z");

	it("starts at one minute and doubles per consecutive deferral", () => {
		expect(CATCH_UP_BACKOFF_BASE_MS).toBe(60_000);
		expect(nextAttemptInstant(1, now).toISOString()).toBe("2026-11-16T10:01:00.000Z");
		expect(nextAttemptInstant(2, now).toISOString()).toBe("2026-11-16T10:02:00.000Z");
		expect(nextAttemptInstant(3, now).toISOString()).toBe("2026-11-16T10:04:00.000Z");
		expect(nextAttemptInstant(4, now).toISOString()).toBe("2026-11-16T10:08:00.000Z");
	});

	it("never waits longer than an hour, however many deferrals accumulated", () => {
		expect(CATCH_UP_BACKOFF_MAX_MS).toBe(3_600_000);
		expect(nextAttemptInstant(7, now).getTime() - now.getTime()).toBe(3_600_000);
		expect(nextAttemptInstant(64, now).getTime() - now.getTime()).toBe(3_600_000);
		expect(Number.isFinite(nextAttemptInstant(1024, now).getTime())).toBe(true);
	});

	it("measures from the instant the tick observed, never from the wall clock", () => {
		const observed = new Date("2026-03-02T10:00:00.000Z");
		expect(nextAttemptInstant(1, observed).toISOString()).toBe("2026-03-02T10:01:00.000Z");
		expect(nextAttemptInstant(1, new Date("2026-11-16T10:00:00.000Z")).toISOString()).toBe(
			"2026-11-16T10:01:00.000Z"
		);
	});
});
