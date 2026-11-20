import { DiscordAPIError, RateLimitError, REST } from "discord.js";
import type { DiscordConfig } from "../config/discord-config.interface.js";
import type {
	DiscordRestRequest,
	DiscordRestResponse,
	DiscordRestTransport
} from "./discord-rest.gateway.interface.js";
import { DiscordRestTransportError } from "./discord-rest.gateway.interface.js";

/**
 * The only file that touches `discord.js` REST (spec R7, R8). It adapts the library's `REST` manager to
 * the read seam and calls `get` and nothing else: no `post`, `put`, `patch` or `delete` is reachable
 * through it, so the read-only property is structural rather than a convention (R8 boundary).
 *
 * The library's own queue is deliberately turned off — `retries: 0` and every route rejected on rate
 * limit — because R7 puts rate-limit awareness and bounded retries with backoff inside this feature's
 * adapter. A rate limit therefore arrives here as an identified transient failure with Discord's wait,
 * and the adapter decides whether that wait fits the read's budget.
 *
 * Proof note: this is transport glue against a live service, so no test exercises it; the seam it
 * implements is proven by the fake REST layer the tests inject, and the behaviour the spec requires is
 * proven above this boundary. Live Discord access is missing evidence here, not a claim of verified
 * behavior (docs/architecture/testing.md).
 */
export class DiscordJsRestTransport implements DiscordRestTransport {
	private readonly rest: REST;

	public constructor(config: DiscordConfig) {
		this.rest = new REST({
			// The adapter owns retry policy; the library must not retry a 5xx or a timeout on its own (R7).
			retries: 0,
			// Every route surfaces a rate limit instead of the library waiting it out silently (R7 boundary).
			rejectOnRateLimit: () => true
		});

		// The credential stays on this side of the boundary: it is never logged and never returned (R11).
		this.rest.setToken(config.botToken);
	}

	public readonly get = async (request: DiscordRestRequest): Promise<DiscordRestResponse> => {
		const query = new URLSearchParams();
		for (const [key, value] of Object.entries(request.query)) {
			if (value !== undefined) {
				query.set(key, String(value));
			}
		}

		// The explicit per-call timeout the spec requires, enforced outside the library's own settings.
		const signal = AbortSignal.timeout(request.timeoutMs);

		try {
			const payload = await this.rest.get(request.path, { query, signal });

			return { status: 200, payload };
		} catch (error) {
			if (isAbort(error)) {
				throw new DiscordRestTransportError("timeout", `no response within ${request.timeoutMs}ms`);
			}

			// A rate limit or an API status is returned as a status, not thrown: the adapter classifies it.
			if (error instanceof RateLimitError) {
				const retryAfterMs = positiveNumber(error.retryAfter);

				return { status: 429, payload: undefined, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
			}

			if (error instanceof DiscordAPIError) {
				return { status: error.status, payload: undefined };
			}

			throw new DiscordRestTransportError("network", errorName(error));
		}
	};
}

/** The token-bound transport the composition root builds. One instance per Installation. */
export function createDiscordJsRestTransport(config: DiscordConfig): DiscordJsRestTransport {
	return new DiscordJsRestTransport(config);
}

function isAbort(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** A wait Discord did not quantify becomes `undefined`, so the adapter falls back to its own backoff. */
function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

/** Error identity only: a Discord API message may quote payload text, so it never leaves here (R11). */
function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown";
}
