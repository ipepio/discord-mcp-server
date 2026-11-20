/**
 * Bounded-read policy for the Discord REST adapter (spec R7). Every number that limits what the adapter
 * will do — timeout, attempts, waiting budget, page size, page count — is declared here as data, so a
 * review can see the bounds and a test can assert them without guessing.
 *
 * Classification is pure arithmetic over an HTTP status: which failures are transient (retry with backoff),
 * which are a named technical failure right away (a client error is never retried, R7), and how a rate-limit
 * response is treated — the adapter waits inside its budget instead of failing fast or fanning out
 * (R7 boundary). Whether that budget is process-global or per-feature is the open decision O2; v1 uses one
 * budget per adapter instance, which the composition root may share.
 */

/** Discord's own hard page-size ceiling for the member list endpoint. */
export const DISCORD_MEMBER_PAGE_SIZE_MAX = 1_000;

/** Discord's ceiling for a channel message-history page. */
export const DISCORD_MESSAGE_PAGE_SIZE_MAX = 100;

/** Discord's ceiling for a thread-member page. */
export const DISCORD_THREAD_MEMBER_PAGE_SIZE_MAX = 100;

/** What one operation call is allowed to spend, and how it spends it. */
export interface DiscordRestReadPolicy {
	/** Per-request timeout handed to the transport, which enforces it. */
	readonly timeoutMs: number;
	/** Total attempts per page, first try included. A bounded number, never a loop that runs forever. */
	readonly maxAttempts: number;
	/** Backoff before the first retry of a page. */
	readonly baseDelayMs: number;
	readonly factor: number;
	/** Ceiling of one backoff delay. */
	readonly maxDelayMs: number;
	/** Total waiting one operation call may spend, backoff and rate-limit waits together. */
	readonly budgetMs: number;
	/** A single rate-limit wait above this is refused: the adapter will not stall a consumer for minutes. */
	readonly maxSingleWaitMs: number;
	/** Bounded pagination limits: pages per call, members per call. */
	readonly memberPageSize: number;
	readonly memberMaxPages: number;
	readonly messagePageSize: number;
	readonly threadMemberPageSize: number;
}

/** The v1 defaults: able to read a 12 000-member Guild in 12 bounded pages, small enough to stay honest. */
export const DEFAULT_DISCORD_REST_READ_POLICY: DiscordRestReadPolicy = Object.freeze({
	timeoutMs: 15_000,
	maxAttempts: 3,
	baseDelayMs: 500,
	factor: 2,
	maxDelayMs: 5_000,
	budgetMs: 30_000,
	maxSingleWaitMs: 10_000,
	memberPageSize: 1_000,
	memberMaxPages: 20,
	messagePageSize: 100,
	threadMemberPageSize: 100
});

/** Every bound that must hold for the adapter to keep its R7 promises. */
export function validateRestReadPolicy(policy: DiscordRestReadPolicy): void {
	for (const [name, value] of Object.entries(policy)) {
		if (!Number.isFinite(value) || value <= 0) {
			throw new RangeError(`Discord REST read policy ${name} must be a positive finite number`);
		}
	}

	if (policy.memberPageSize > DISCORD_MEMBER_PAGE_SIZE_MAX) {
		throw new RangeError(
			`Discord REST read policy memberPageSize exceeds Discord's ceiling ${DISCORD_MEMBER_PAGE_SIZE_MAX}`
		);
	}

	if (policy.messagePageSize > DISCORD_MESSAGE_PAGE_SIZE_MAX) {
		throw new RangeError(
			`Discord REST read policy messagePageSize exceeds Discord's ceiling ${DISCORD_MESSAGE_PAGE_SIZE_MAX}`
		);
	}

	if (policy.threadMemberPageSize > DISCORD_THREAD_MEMBER_PAGE_SIZE_MAX) {
		throw new RangeError(
			`Discord REST read policy threadMemberPageSize exceeds Discord's ceiling ${DISCORD_THREAD_MEMBER_PAGE_SIZE_MAX}`
		);
	}
}

/**
 * Status classes the adapter distinguishes (R7). `rate-limit` and `transient` are the identified transient
 * failures; everything else is a named technical failure without a retry.
 */
export type DiscordRestStatusClass =
	"success" | "rate-limit" | "transient" | "unauthorized" | "not-found" | "client-error";

export function classifyRestStatus(status: number): DiscordRestStatusClass {
	if (status >= 200 && status < 300) {
		return "success";
	}

	if (status === 429) {
		return "rate-limit";
	}

	if (status === 401 || status === 403) {
		return "unauthorized";
	}

	if (status === 404) {
		return "not-found";
	}

	if (status >= 500) {
		return "transient";
	}

	return "client-error";
}

/** The only two classes worth retrying. A client error never is (R7). */
export function isTransientRestStatus(status: number): boolean {
	const kind = classifyRestStatus(status);
	return kind === "rate-limit" || kind === "transient";
}

/** Backoff for attempt `attempt` (1 is the first retry), capped by `maxDelayMs`. */
export function computeRestRetryDelayMs(
	attempt: number,
	policy: Pick<DiscordRestReadPolicy, "baseDelayMs" | "factor" | "maxDelayMs">
): number {
	if (attempt <= 0) {
		return 0;
	}

	const grown = policy.baseDelayMs * policy.factor ** (attempt - 1);
	return Math.min(Math.round(grown), policy.maxDelayMs);
}

/**
 * Can this wait still be honoured inside the remaining budget? A rate limit that asks for more than the
 * budget left, or for one wait longer than `maxSingleWaitMs`, is refused as a named failure rather than
 * stalled on or retried blindly (R7 boundary).
 */
export function isWaitWithinBudget(waitMs: number, waitedMs: number, policy: DiscordRestReadPolicy): boolean {
	return waitMs <= policy.maxSingleWaitMs && waitedMs + waitMs <= policy.budgetMs;
}

/** Has the call run out of attempts? Attempts count the first try, so `attempt === maxAttempts` is the last. */
export function isRestRetryExhausted(attempt: number, policy: Pick<DiscordRestReadPolicy, "maxAttempts">): boolean {
	return attempt >= policy.maxAttempts;
}

/** A `retry_after` that Discord did not send falls back to the backoff curve, never to zero. */
export function restRateLimitWaitMs(
	retryAfterMs: number | undefined,
	attempt: number,
	policy: DiscordRestReadPolicy
): number {
	if (retryAfterMs !== undefined && retryAfterMs > 0) {
		return Math.round(retryAfterMs);
	}

	return computeRestRetryDelayMs(attempt, policy);
}

/**
 * Does another page have to be asked for? A short page means Discord had nothing more; a full page means
 * the roster is not yet complete (R7 example: a partial roster is never reported as complete).
 */
export function restHasMorePage(itemCount: number, pageSize: number): boolean {
	return itemCount >= pageSize;
}
