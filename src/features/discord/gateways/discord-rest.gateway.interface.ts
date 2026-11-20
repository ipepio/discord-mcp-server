import type { DiscordRestOperation } from "../models/domain/discord-rest-operation.enum.js";

/**
 * The narrow REST seam behind the Discord gateway adapter (spec R7, R8). Everything above it — retry
 * budget, pagination bounds, validation, application typing — is framework-free and tested against a
 * fake; `discord.js` appears only in the single implementation of this contract.
 *
 * The seam carries reads only: one `get`, no request body, and deliberately no `post`, `patch`, `put` or
 * `delete`. That absence is the structural half of the read-only rule (R8) — a write is not merely
 * unadvertised, it is not expressible through this boundary.
 */

/** Query parameters of a read. `undefined` means the parameter is not sent at all. */
export type DiscordRestQuery = Readonly<Record<string, string | number | boolean | undefined>>;

/**
 * A v10 API path with literal ids already substituted. The type is the constraint: a path must start
 * with `/`, and every id inside it was validated as a snowflake before it could be interpolated.
 */
export type DiscordRestPath = `/${string}`;

/** One bounded read the transport must perform, with the timeout the adapter decided. */
export interface DiscordRestRequest {
	readonly operation: DiscordRestOperation;
	/**
	 * The v10 path, already parameterized with validated snowflakes (`/guilds/123/members`). Ids are
	 * validated by the adapter before they reach here, so a foreign or malformed id can never form a path.
	 */
	readonly path: DiscordRestPath;
	readonly query: DiscordRestQuery;
	readonly timeoutMs: number;
}

/** The HTTP fact as the transport saw it. `payload` is unvalidated JSON; `retryAfterMs` is Discord's own wait. */
export interface DiscordRestResponse {
	readonly status: number;
	readonly payload: unknown;
	readonly retryAfterMs?: number;
}

/**
 * What went wrong below HTTP: a timeout that fired, or a request that never reached Discord. Both are
 * identified transient failures and the adapter decides whether to retry them inside its budget.
 */
export class DiscordRestTransportError extends Error {
	public readonly code = "DISCORD_REST_TRANSPORT";
	public readonly kind: "timeout" | "network";

	constructor(kind: "timeout" | "network", detail: string) {
		super(`Discord REST ${kind} failure: ${detail}`);
		this.name = "DiscordRestTransportError";
		this.kind = kind;
	}
}

/** The only operation the transport seam offers. A write cannot be asked for (R8). */
export interface DiscordRestTransport {
	readonly get: (request: DiscordRestRequest) => Promise<DiscordRestResponse>;
}
