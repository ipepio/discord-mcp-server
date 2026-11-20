import type {
	DiscordRestPath,
	DiscordRestRequest,
	DiscordRestResponse,
	DiscordRestTransport
} from "../../../../src/features/discord/gateways/discord-rest.gateway.interface.js";
import type { DiscordRestOperation } from "../../../../src/features/discord/models/domain/discord-rest-operation.enum.js";
import { DiscordRestTransportError } from "../../../../src/features/discord/gateways/discord-rest.gateway.interface.js";

/**
 * The discord.js REST test double (spec "Implementation and proof": the REST layer is replaced by a fake
 * exposing the same seam, able to simulate a rate-limit response, a 5xx, a malformed payload and a
 * timeout). No test contacts Discord.
 *
 * Every request is recorded with its path, its query, its timeout and the moment it overlapped another,
 * so R7's bounds are measured rather than assumed: page counts, retry counts, the per-call timeout and
 * "never spawns parallel requests" are all assertions against this file's counters.
 */

/** One scripted answer the transport gives to the next request on its path. */
export type FakeRestReply =
	| { readonly kind: "status"; readonly status: number; readonly payload?: unknown; readonly retryAfterMs?: number }
	| { readonly kind: "timeout" }
	| { readonly kind: "network"; readonly detail: string };

const DEFAULT_OK: FakeRestReply = { kind: "status", status: 200, payload: [] };

export function restOk(payload: unknown): FakeRestReply {
	return { kind: "status", status: 200, payload };
}

/** A 429. `retryAfterMs` is Discord's own wait, absent when the response did not quantify it. */
export function restRateLimited(retryAfterMs?: number): FakeRestReply {
	return { kind: "status", status: 429, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

export function restServerError(status = 500): FakeRestReply {
	return { kind: "status", status, payload: { message: "internal error" } };
}

export function restClientError(status = 400): FakeRestReply {
	return { kind: "status", status, payload: { message: "bad request" } };
}

export function restUnauthorized(): FakeRestReply {
	return { kind: "status", status: 403, payload: { message: "forbidden" } };
}

export function restNotFound(): FakeRestReply {
	return { kind: "status", status: 404, payload: { message: "unknown object" } };
}

/** The transport's own deadline firing: the request never produced a status. */
export function restTimeout(): FakeRestReply {
	return { kind: "timeout" };
}

export function restNetwork(detail = "socket closed"): FakeRestReply {
	return { kind: "network", detail };
}

/** Held across a macrotask so an adapter that overlapped two calls would be seen doing it. */
function yieldTurn(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

export class FakeDiscordRestTransport implements DiscordRestTransport {
	public readonly requests: DiscordRestRequest[] = [];
	/** Requests per path, in call order: the pagination and retry bounds are asserted here. */
	public readonly perPath = new Map<string, number>();
	/** The timeout each request was handed, so "explicit timeout on every call" is asserted per call. */
	public readonly timeouts: number[] = [];

	/** Concurrency witness: two overlapping requests would raise this above 1. */
	public inFlight = 0;
	public maxInFlight = 0;

	private readonly queues = new Map<string, FakeRestReply[]>();
	private readonly defaults: FakeRestReply[] = [];

	/** Scripts the answers for one path, consumed in order. */
	public reply(path: DiscordRestPath | string, ...replies: readonly FakeRestReply[]): this {
		const queue = this.queues.get(path) ?? [];
		queue.push(...replies);
		this.queues.set(path, queue);

		return this;
	}

	/** Scripts answers for any path that has no scripted reply of its own. */
	public defaultReply(...replies: readonly FakeRestReply[]): this {
		this.defaults.push(...replies);

		return this;
	}

	public callsOn(path: string): number {
		return this.perPath.get(path) ?? 0;
	}

	public totalCalls(): number {
		return this.requests.length;
	}

	public lastRequest(): DiscordRestRequest {
		const last = this.requests[this.requests.length - 1];
		if (last === undefined) {
			throw new Error("the fake REST transport received no request");
		}

		return last;
	}

	/** Every operation that was asked for, in call order. */
	public operations(): DiscordRestOperation[] {
		return this.requests.map((request) => request.operation);
	}

	public readonly get = async (request: DiscordRestRequest): Promise<DiscordRestResponse> => {
		this.requests.push({ ...request, query: { ...request.query } });
		this.perPath.set(request.path, (this.perPath.get(request.path) ?? 0) + 1);
		this.timeouts.push(request.timeoutMs);

		this.inFlight += 1;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);

		const reply = this.takeReply(request.path);
		await yieldTurn();
		this.inFlight -= 1;

		if (reply.kind === "timeout") {
			throw new DiscordRestTransportError("timeout", `fake deadline of ${request.timeoutMs}ms fired`);
		}

		if (reply.kind === "network") {
			throw new DiscordRestTransportError("network", reply.detail);
		}

		const base: DiscordRestResponse = { status: reply.status, payload: reply.payload };

		return reply.retryAfterMs === undefined ? base : { ...base, retryAfterMs: reply.retryAfterMs };
	};

	private takeReply(path: string): FakeRestReply {
		const queued = this.queues.get(path);
		const next = queued?.shift();
		if (next !== undefined) {
			return next;
		}

		return this.defaults.shift() ?? DEFAULT_OK;
	}
}
