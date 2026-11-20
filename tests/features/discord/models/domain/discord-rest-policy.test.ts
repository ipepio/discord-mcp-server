import { describe, expect, it } from "vitest";
import {
	DISCORD_MEMBER_PAGE_SIZE_MAX,
	DEFAULT_DISCORD_REST_READ_POLICY,
	classifyRestStatus,
	computeRestRetryDelayMs,
	isRestRetryExhausted,
	isTransientRestStatus,
	isWaitWithinBudget,
	restHasMorePage,
	restRateLimitWaitMs,
	validateRestReadPolicy
} from "../../../../../src/features/discord/models/domain/discord-rest-policy.js";

/**
 * R7 — the arithmetic behind the bounded read: which failures count as transient, how a retry waits, how
 * much waiting one call may spend, and when a page is the last one. These are the numbers the spec names,
 * so they are asserted as data rather than left to an integration test.
 */

describe("discord REST read policy — status classification", () => {
	it("classifies exactly the failures the spec calls transient", () => {
		expect(classifyRestStatus(429)).toBe("rate-limit");
		expect(classifyRestStatus(500)).toBe("transient");
		expect(classifyRestStatus(503)).toBe("transient");
		expect(isTransientRestStatus(429)).toBe(true);
		expect(isTransientRestStatus(500)).toBe(true);
	});

	it("names the other statuses separately, so a permission failure is not read as an empty result (R8)", () => {
		expect(classifyRestStatus(401)).toBe("unauthorized");
		expect(classifyRestStatus(403)).toBe("unauthorized");
		expect(classifyRestStatus(404)).toBe("not-found");
		expect(classifyRestStatus(400)).toBe("client-error");
		expect(classifyRestStatus(204)).toBe("success");
		expect(isTransientRestStatus(400)).toBe(false);
		expect(isTransientRestStatus(403)).toBe(false);
	});
});

describe("discord REST read policy — backoff, budget and bounds", () => {
	const policy = {
		...DEFAULT_DISCORD_REST_READ_POLICY,
		baseDelayMs: 100,
		factor: 2,
		maxDelayMs: 1_000,
		budgetMs: 3_000,
		maxSingleWaitMs: 2_000
	};

	it("grows the delay per attempt and caps it", () => {
		expect(computeRestRetryDelayMs(1, policy)).toBe(100);
		expect(computeRestRetryDelayMs(2, policy)).toBe(200);
		expect(computeRestRetryDelayMs(3, policy)).toBe(400);
		expect(computeRestRetryDelayMs(9, policy)).toBe(1_000);
		expect(computeRestRetryDelayMs(0, policy)).toBe(0);
	});

	it("counts the first try inside the bounded attempt count", () => {
		expect(isRestRetryExhausted(1, policy)).toBe(false);
		expect(isRestRetryExhausted(3, policy)).toBe(true);
		expect(isRestRetryExhausted(4, policy)).toBe(true);
	});

	it("refuses a wait that does not fit the remaining budget or the single-wait ceiling", () => {
		expect(isWaitWithinBudget(500, 2_000, policy)).toBe(true);
		expect(isWaitWithinBudget(900, 2_500, policy)).toBe(false);
		expect(isWaitWithinBudget(5_000, 0, policy)).toBe(false);
	});

	it("honours Discord's own wait and falls back to the curve when it is missing", () => {
		expect(restRateLimitWaitMs(250, 1, policy)).toBe(250);
		expect(restRateLimitWaitMs(undefined, 2, policy)).toBe(200);
		expect(restRateLimitWaitMs(0, 1, policy)).toBe(100);
	});

	it("reads a full page as more to come and a short page as the end", () => {
		expect(restHasMorePage(100, 100)).toBe(true);
		expect(restHasMorePage(99, 100)).toBe(false);
		expect(restHasMorePage(0, 100)).toBe(false);
	});

	it("defaults to bounds that read a 12 000-member Guild in bounded pages (R7 example)", () => {
		const pages = Math.ceil(12_000 / DEFAULT_DISCORD_REST_READ_POLICY.memberPageSize);

		expect(DEFAULT_DISCORD_REST_READ_POLICY.memberPageSize).toBe(DISCORD_MEMBER_PAGE_SIZE_MAX);
		expect(pages).toBe(12);
		expect(DEFAULT_DISCORD_REST_READ_POLICY.memberMaxPages).toBeGreaterThanOrEqual(pages);
	});

	it("rejects a policy that would ask Discord for more than a page ceiling allows", () => {
		expect(() => validateRestReadPolicy(DEFAULT_DISCORD_REST_READ_POLICY)).not.toThrow();
		expect(() => validateRestReadPolicy({ ...DEFAULT_DISCORD_REST_READ_POLICY, memberPageSize: 5_000 })).toThrow(
			RangeError
		);
		expect(() => validateRestReadPolicy({ ...DEFAULT_DISCORD_REST_READ_POLICY, messagePageSize: 0 })).toThrow(
			RangeError
		);
	});
});
