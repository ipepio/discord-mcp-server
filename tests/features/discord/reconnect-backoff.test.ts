import { describe, expect, it } from "vitest";
import {
	computeReconnectDelayMs,
	DEFAULT_RECONNECT_BACKOFF,
	isUnavailableAfter
} from "../../../src/features/discord/models/domain/reconnect-backoff.js";
import type { ReconnectBackoffSettings } from "../../../src/features/discord/models/domain/reconnect-backoff.js";

/**
 * R1 — reconnect with backoff. The growth is asserted apart from the lifecycle so the ceiling and the
 * `unavailable` threshold are arithmetic facts, not timing that a test has to wait for.
 */

const settings: ReconnectBackoffSettings = {
	baseDelayMs: 1_000,
	factor: 2,
	maxDelayMs: 8_000,
	unavailableAfterAttempts: 4
};

describe("R1 — reconnect backoff growth", () => {
	it("grows geometrically from the base delay", () => {
		expect([1, 2, 3, 4].map((attempt) => computeReconnectDelayMs(attempt, settings))).toEqual([
			1_000, 2_000, 4_000, 8_000
		]);
	});

	it("stays at the ceiling instead of escalating without bound", () => {
		expect(computeReconnectDelayMs(5, settings)).toBe(8_000);
		expect(computeReconnectDelayMs(50, settings)).toBe(8_000);
	});

	it("waits nothing before the first attempt", () => {
		expect(computeReconnectDelayMs(0, settings)).toBe(0);
		expect(computeReconnectDelayMs(-3, settings)).toBe(0);
	});

	it("rounds a fractional growth to whole milliseconds", () => {
		const odd: ReconnectBackoffSettings = {
			baseDelayMs: 300,
			factor: 1.5,
			maxDelayMs: 10_000,
			unavailableAfterAttempts: 9
		};
		expect(computeReconnectDelayMs(2, odd)).toBe(450);
		expect(computeReconnectDelayMs(3, odd)).toBe(675);
	});

	it("reports unavailable exactly at the configured threshold", () => {
		expect(isUnavailableAfter(3, settings)).toBe(false);
		expect(isUnavailableAfter(4, settings)).toBe(true);
		expect(isUnavailableAfter(9, settings)).toBe(true);
	});

	it("keeps the documented production defaults", () => {
		expect(DEFAULT_RECONNECT_BACKOFF.baseDelayMs).toBe(1_000);
		expect(DEFAULT_RECONNECT_BACKOFF.maxDelayMs).toBe(60_000);
		expect(DEFAULT_RECONNECT_BACKOFF.unavailableAfterAttempts).toBe(5);
	});
});
