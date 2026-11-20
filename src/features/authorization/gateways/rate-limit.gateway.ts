import type { RateLimitDecision, RateLimiterGateway } from "./rate-limit.gateway.interface.js";

/** Bounded in-process memory: v1 runs as a single instance; a multi-instance deployment needs a shared store. */
export const RATE_LIMIT_MAX_ENTRIES = 4096;
/** Keys are `<bucket>|<identity>`; the bucket selects the fixed window and identity is the client address. */
export const RATE_LIMIT_KEY_SEPARATOR = "|";

export interface FixedWindowBucket {
	readonly limit: number;
	readonly windowSeconds: number;
}

export interface InMemoryFixedWindowRateLimiterOptions {
	readonly buckets: Readonly<Record<string, FixedWindowBucket>>;
	readonly maxEntries?: number;
	/** Injectable clock for window-math tests; production uses `Date.now`. */
	readonly now?: () => number;
}

interface WindowEntry {
	count: number;
	resetAtEpochMs: number;
}

/**
 * Fixed-window limiter with a hard entry cap. When the cap is reached the oldest key is dropped, so a
 * flood of distinct addresses cannot grow memory without bound; an evicted key starts a fresh window.
 */
export class InMemoryFixedWindowRateLimiter implements RateLimiterGateway {
	private readonly entries = new Map<string, WindowEntry>();
	private readonly buckets: Readonly<Record<string, FixedWindowBucket>>;
	private readonly maxEntries: number;
	private readonly now: () => number;

	public constructor(options: InMemoryFixedWindowRateLimiterOptions) {
		this.buckets = options.buckets;
		this.maxEntries = options.maxEntries ?? RATE_LIMIT_MAX_ENTRIES;
		if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1)
			throw new RangeError("Rate limit entry capacity must be a positive integer");
		this.now = options.now ?? Date.now;
	}

	public readonly take = (key: string): RateLimitDecision => {
		const separator = key.indexOf(RATE_LIMIT_KEY_SEPARATOR);
		const bucketId = separator < 0 ? key : key.slice(0, separator);
		const bucket = this.buckets[bucketId];
		if (!bucket) throw new TypeError(`Unknown rate limit bucket: ${bucketId}`);
		const timestamp = this.now();
		let entry = this.entries.get(key);
		if (!entry || timestamp >= entry.resetAtEpochMs) {
			entry = { count: 0, resetAtEpochMs: timestamp + bucket.windowSeconds * 1000 };
			this.entries.set(key, entry);
			this.evictOldest();
		}
		entry.count += 1;
		if (entry.count <= bucket.limit) return { allowed: true, retryAfterSeconds: 0 };
		return {
			allowed: false,
			retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAtEpochMs - timestamp) / 1000))
		};
	};

	/** Bounded-memory evidence for tests; never used to make a decision. */
	public readonly entryCount = (): number => this.entries.size;

	private evictOldest(): void {
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next();
			if (oldest.done) return;
			this.entries.delete(oldest.value);
		}
	}
}
