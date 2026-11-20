/** Fixed-window limiter seam. `key` is `<bucket>|<identity>`; the bucket selects the configured window. */
export interface RateLimitDecision {
	readonly allowed: boolean;
	/** Whole seconds until the fixed window resets, 0 while the request is allowed. */
	readonly retryAfterSeconds: number;
}

export interface RateLimiterGateway {
	readonly take: (key: string) => RateLimitDecision;
}
