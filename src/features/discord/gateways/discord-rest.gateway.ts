import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import { DiscordRestOperation } from "../models/domain/discord-rest-operation.enum.js";
import { isDiscordSnowflake } from "../models/domain/discord-snowflake.js";
import type {
	DiscordRestPath,
	DiscordRestQuery,
	DiscordRestResponse,
	DiscordRestTransport
} from "./discord-rest.gateway.interface.js";
import { DiscordRestTransportError } from "./discord-rest.gateway.interface.js";
import { DiscordRestFailureError } from "./discord-rest.errors.js";
import type { DiscordRestFailureReason } from "./discord-rest.errors.js";
import type {
	DiscordChannelRecord,
	DiscordGuildSnapshot,
	DiscordMemberRoster,
	DiscordMemberRecord,
	DiscordMessageHistoryPage,
	DiscordMessageRecord,
	DiscordRoleRecord,
	DiscordThreadMemberPage,
	RosterTruncation
} from "../models/domain/discord-rest-results.js";
import type { DiscordRestReadPolicy } from "../models/domain/discord-rest-policy.js";
import {
	DISCORD_MEMBER_PAGE_SIZE_MAX,
	DISCORD_MESSAGE_PAGE_SIZE_MAX,
	DISCORD_THREAD_MEMBER_PAGE_SIZE_MAX,
	classifyRestStatus,
	computeRestRetryDelayMs,
	DEFAULT_DISCORD_REST_READ_POLICY,
	isRestRetryExhausted,
	isWaitWithinBudget,
	restHasMorePage,
	restRateLimitWaitMs
} from "../models/domain/discord-rest-policy.js";
import type {
	DiscordRestOperations,
	MemberRosterRead,
	MessageHistoryRead,
	MessageRead,
	ThreadMemberRead
} from "../models/domain/discord-rest-gateway.interface.js";
import type { DiscordClock, DiscordWait } from "../models/domain/discord-timing.js";
import {
	mapChannelRecords,
	mapGuildSnapshot,
	mapMemberRecords,
	mapMessageRecord,
	mapMessageRecords,
	mapRoleRecords,
	mapThreadMemberRecords
} from "../models/mappers/discord-rest-response.mapper.js";

/**
 * The Discord REST adapter (spec R7): the only place this Installation's Discord REST calls exist. It
 * performs bounded reads against a transport seam, and everything the spec asks of the seam is applied
 * here — an explicit timeout on every call, a bounded page size and page count, bounded retries with
 * backoff for the identified transient failures (429 and 5xx), no retry on a client error, rate-limit
 * waiting inside the call's budget instead of failing fast or fanning out, and payload validation before
 * any result leaves the boundary.
 *
 * It exposes reads only (R8): the transport seam has no write to reach, the guild-scoped reads take no
 * Guild id (the configured one is fixed at construction), and every caller-supplied resource id is
 * validated as a snowflake before it can become part of a request path.
 *
 * O2 note (spec Open decisions): the rate-limit budget below is per adapter instance, which is what the
 * composition root shares when one instance serves bootstrap, resync and backfill. Whether the budget is
 * process-global or per consumer feature stays the owner's decision; nothing here assumes an answer.
 */
export interface DiscordRestGatewayDependencies {
	readonly transport: DiscordRestTransport;
	/** The configured Guild: the only Guild this Installation may read (R2, R9). */
	readonly guildId: string;
	readonly policy: DiscordRestReadPolicy;
	readonly logger: AppLogger;
	readonly clock: DiscordClock;
	readonly wait: DiscordWait;
}

/** One failure the loop classified, kept so the surfaced error names the last thing that went wrong. */
interface LastFailure {
	readonly reason: DiscordRestFailureReason;
	readonly detail: string;
	readonly status?: number;
}

/** One call the adapter will perform: an operation name, a validated path and its query. */
interface RestCall {
	readonly operation: DiscordRestOperation;
	readonly path: DiscordRestPath;
	readonly query: DiscordRestQuery;
}

const NO_ATTEMPT: LastFailure = { reason: "transport", detail: "the read made no completed attempt" };

export class DiscordRestGateway implements DiscordRestOperations {
	private readonly deps: DiscordRestGatewayDependencies;
	/**
	 * One outbound request at a time (R7 boundary): the adapter waits out a rate limit rather than letting
	 * several consumers fan out against the same token. A settled chain never keeps a rejection.
	 */
	private pending: Promise<unknown> = Promise.resolve();

	public constructor(deps: DiscordRestGatewayDependencies) {
		this.deps = deps;
	}

	/** Builds the adapter with the v1 bounds. The composition root may pass tighter ones. */
	public static create(
		deps: Omit<DiscordRestGatewayDependencies, "policy"> & { readonly policy?: DiscordRestReadPolicy }
	): DiscordRestGateway {
		return new DiscordRestGateway({ ...deps, policy: deps.policy ?? DEFAULT_DISCORD_REST_READ_POLICY });
	}

	/** Bootstrap identity uses exactly the same bounded read/retry/validation boundary as other reads. */
	public readonly readBotIdentity = async (): Promise<string> => {
		const payload = await this.execute({
			operation: DiscordRestOperation.botIdentity,
			path: "/users/@me",
			query: {}
		});
		if (typeof payload !== "object" || payload === null || !("id" in payload) || !isDiscordSnowflake(payload.id))
			throw new DiscordRestFailureError({
				operation: DiscordRestOperation.botIdentity,
				reason: "validation",
				attempts: 1,
				fieldPath: "id",
				detail: "Invalid bot identity"
			});
		return payload.id;
	};

	/** GET /guilds/{guild.id} — the configured Guild only, and the response must confirm that. */
	public readonly readGuildSnapshot = async (): Promise<DiscordGuildSnapshot> => {
		const guildId = this.configuredGuildId();
		const payload = await this.execute({
			operation: DiscordRestOperation.guildSnapshot,
			path: `/guilds/${guildId}`,
			query: { with_counts: true }
		});

		const snapshot = mapGuildSnapshot(DiscordRestOperation.guildSnapshot, payload);
		if (snapshot.guildId !== guildId) {
			throw new DiscordRestFailureError({
				operation: DiscordRestOperation.guildSnapshot,
				reason: "validation",
				attempts: 1,
				fieldPath: "id",
				detail: "the response names another Guild than the one that was read"
			});
		}

		return snapshot;
	};

	/** GET /guilds/{guild.id}/roles — a whole role list, or a named failure. */
	public readonly readRoles = async (): Promise<readonly DiscordRoleRecord[]> => {
		const guildId = this.configuredGuildId();
		const payload = await this.execute({
			operation: DiscordRestOperation.roles,
			path: `/guilds/${guildId}/roles`,
			query: {}
		});

		return mapRoleRecords(DiscordRestOperation.roles, guildId, payload);
	};

	/** GET /guilds/{guild.id}/channels — channels and threads with their permission overwrites. */
	public readonly readChannels = async (): Promise<readonly DiscordChannelRecord[]> => {
		const guildId = this.configuredGuildId();
		const payload = await this.execute({
			operation: DiscordRestOperation.channels,
			path: `/guilds/${guildId}/channels`,
			query: {}
		});

		return mapChannelRecords(DiscordRestOperation.channels, guildId, payload);
	};

	/**
	 * GET /guilds/{guild.id}/members — the bounded paginated roster (R7 example: a 12 000-member Guild is
	 * read in bounded pages, each page retried on its own). `complete` is true only when Discord sent a
	 * short final page; a roster that stopped at a bound says which bound stopped it and is never reported
	 * as whole.
	 */
	public readonly readMemberRoster = async (read: MemberRosterRead = {}): Promise<DiscordMemberRoster> => {
		const guildId = this.configuredGuildId();
		const operation = DiscordRestOperation.memberRoster;
		const pageSize = Math.min(this.deps.policy.memberPageSize, DISCORD_MEMBER_PAGE_SIZE_MAX);
		const maxPages = Math.min(read.maxPages ?? this.deps.policy.memberMaxPages, this.deps.policy.memberMaxPages);
		const maxMembers = read.maxMembers;
		const members: DiscordMemberRecord[] = [];
		let pages = 0;
		let after: string | undefined;
		let complete = false;

		while (pages < maxPages) {
			const payload = await this.execute({
				operation,
				path: `/guilds/${guildId}/members`,
				query: { limit: pageSize, ...(after === undefined ? {} : { after }) }
			});

			const page = mapMemberRecords(operation, guildId, payload);
			pages += 1;

			if (maxMembers !== undefined && members.length + page.length > maxMembers) {
				members.push(...page.slice(0, maxMembers - members.length));
				return this.truncated(guildId, members, pages, "member-limit");
			}

			members.push(...page);
			const last = page[page.length - 1];

			if (!restHasMorePage(page.length, pageSize)) {
				complete = true;
				break;
			}

			if (last === undefined) {
				complete = true;
				break;
			}

			after = last.userId;
		}

		if (complete) {
			return Object.freeze({ guildId, members: Object.freeze(members), pages, complete });
		}

		return this.truncated(guildId, members, pages, "page-limit");
	};

	/**
	 * GET /channels/{channel.id}/messages — one bounded history page for ingestion's backfill (R7). The
	 * page keeps Discord's own order and reports whether another page can be asked for; deciding whether to
	 * ask is ingestion's policy, not this transport's.
	 */
	public readonly readMessageHistoryPage = async (read: MessageHistoryRead): Promise<DiscordMessageHistoryPage> => {
		const operation = DiscordRestOperation.messageHistory;
		const channelId = this.requireResourceId(operation, "channelId", read.channelId);
		if (read.before !== undefined && read.after !== undefined) {
			throw new DiscordRestFailureError({
				operation,
				reason: "client-error",
				attempts: 0,
				fieldPath: "before",
				detail: "a history page is asked for in one direction, before or after, never both"
			});
		}

		const limit = Math.min(
			read.limit ?? this.deps.policy.messagePageSize,
			this.deps.policy.messagePageSize,
			DISCORD_MESSAGE_PAGE_SIZE_MAX
		);
		const payload = await this.execute({
			operation,
			path: `/channels/${channelId}/messages`,
			query: {
				limit,
				...(read.before === undefined
					? {}
					: { before: this.requireResourceId(operation, "before", read.before) }),
				...(read.after === undefined ? {} : { after: this.requireResourceId(operation, "after", read.after) })
			}
		});

		const messages = mapMessageRecords(operation, channelId, payload);
		const hasMore = restHasMorePage(messages.length, limit);
		const oldest = messages[messages.length - 1];

		return Object.freeze({
			channelId,
			messages: Object.freeze(messages),
			requestedLimit: limit,
			hasMore,
			...(hasMore && oldest !== undefined ? { nextBeforeId: oldest.messageId } : {})
		});
	};

	/**
	 * GET /channels/{channel.id}/messages/{message.id} — one message, read whole (docs/features/ingestion.md
	 * R5: a Gateway update that did not carry every field is reconciled against this read before anything is
	 * overwritten). The bound is structural: one request, one resource, no page and no scan. R7 applies to it
	 * exactly as to the paginated reads — explicit timeout, bounded retries for 429/5xx only, a client error
	 * surfaced as it is, and a response that does not confirm the channel and message ids read as a named
	 * validation failure rather than as a result. Guild scoping is by the channel: this route has no Guild
	 * parameter, and a response naming another channel is refused at its field path.
	 */
	public readonly readMessage = async (read: MessageRead): Promise<DiscordMessageRecord> => {
		const operation = DiscordRestOperation.message;
		const channelId = this.requireResourceId(operation, "channelId", read.channelId);
		const messageId = this.requireResourceId(operation, "messageId", read.messageId);
		const payload = await this.execute({
			operation,
			path: `/channels/${channelId}/messages/${messageId}`,
			query: {}
		});

		return mapMessageRecord(operation, channelId, messageId, payload);
	};

	/**
	 * GET /channels/{thread.id}/thread-members — the thread-member read Discord allows on this endpoint.
	 * A thread this Installation cannot see is a named technical failure (`unauthorized`), never invented
	 * membership.
	 */
	public readonly readThreadMembers = async (read: ThreadMemberRead): Promise<DiscordThreadMemberPage> => {
		const operation = DiscordRestOperation.threadMembers;
		const threadId = this.requireResourceId(operation, "threadId", read.threadId);
		const limit = Math.min(
			read.limit ?? this.deps.policy.threadMemberPageSize,
			this.deps.policy.threadMemberPageSize,
			DISCORD_THREAD_MEMBER_PAGE_SIZE_MAX
		);
		const payload = await this.execute({
			operation,
			path: `/channels/${threadId}/thread-members`,
			query: {
				limit,
				...(read.after === undefined ? {} : { after: this.requireResourceId(operation, "after", read.after) })
			}
		});

		const members = mapThreadMemberRecords(operation, threadId, payload);
		const hasMore = restHasMorePage(members.length, limit);
		const last = members[members.length - 1];

		return Object.freeze({
			threadId,
			members: Object.freeze(members),
			requestedLimit: limit,
			hasMore,
			...(hasMore && last !== undefined ? { nextAfterId: last.userId } : {})
		});
	};

	/**
	 * One bounded request: explicit timeout, transient failures retried with backoff inside the waiting
	 * budget, everything else surfaced as it is. Validation happens on the way out of this method's
	 * caller, so an invalid payload leaves as the named failure it is and is never retried.
	 */
	private async execute(request: RestCall): Promise<unknown> {
		const policy = this.deps.policy;
		let attempt = 0;
		let waitedMs = 0;
		let last: LastFailure = NO_ATTEMPT;

		for (;;) {
			attempt += 1;
			let response: DiscordRestResponse;

			try {
				response = await this.enqueue(request);
			} catch (error) {
				const transportFailure = error instanceof DiscordRestTransportError ? error.kind : undefined;
				last =
					transportFailure === "timeout"
						? { reason: "timeout", detail: `no response within ${policy.timeoutMs}ms` }
						: { reason: "transport", detail: "the request did not complete" };

				const delay = computeRestRetryDelayMs(attempt, policy);
				if (isRestRetryExhausted(attempt, policy) || !isWaitWithinBudget(delay, waitedMs, policy)) {
					break;
				}

				waitedMs += delay;
				this.reportRetry(request.operation, request.path, attempt, delay, last);
				await this.deps.wait(delay);
				continue;
			}

			const status = classifyRestStatus(response.status);
			if (status === "success") {
				return response.payload;
			}

			last = {
				reason: restFailureReason(status, response.status),
				detail: `status ${response.status}`,
				status: response.status
			};

			// R7: only 429 and 5xx are identified transient failures. A client error is surfaced as it is.
			if (status !== "rate-limit" && status !== "transient") {
				break;
			}

			const waitMs =
				status === "rate-limit"
					? restRateLimitWaitMs(response.retryAfterMs, attempt, policy)
					: computeRestRetryDelayMs(attempt, policy);

			if (isRestRetryExhausted(attempt, policy) || !isWaitWithinBudget(waitMs, waitedMs, policy)) {
				break;
			}

			waitedMs += waitMs;
			this.reportRetry(request.operation, request.path, attempt, waitMs, last, response.retryAfterMs);
			await this.deps.wait(waitMs);
		}

		throw new DiscordRestFailureError({
			operation: request.operation,
			reason: last.reason,
			attempts: attempt,
			detail: last.detail,
			...(last.status === undefined ? {} : { status: last.status })
		});
	}

	/** Queues the request behind whatever the adapter is already doing: one request at a time. */
	private enqueue(request: RestCall): Promise<DiscordRestResponse> {
		const run = () => this.deps.transport.get({ ...request, timeoutMs: this.deps.policy.timeoutMs });
		const settled = this.pending.then(run, run);
		this.pending = settled.then(
			() => undefined,
			() => undefined
		);

		return settled;
	}

	/**
	 * R11: a transient response is logged with the route, the status and the wait it produced — never a
	 * response body and never content. The instant is the injected clock's, so the record is testable.
	 */
	private reportRetry(
		operation: DiscordRestOperation,
		path: DiscordRestPath,
		attempt: number,
		waitMs: number,
		failure: LastFailure,
		retryAfterMs?: number
	): void {
		this.deps.logger.warn("Discord REST read retrying within its budget", {
			operation,
			route: path,
			attempt,
			reason: failure.reason,
			...(failure.status === undefined ? {} : { status: failure.status }),
			waitMs,
			...(retryAfterMs === undefined ? {} : { retryAfterMs }),
			instant: this.deps.clock().toISOString()
		});
	}

	private truncated(
		guildId: string,
		members: readonly DiscordMemberRecord[],
		pages: number,
		truncatedBy: RosterTruncation
	): DiscordMemberRoster {
		return Object.freeze({
			guildId,
			members: Object.freeze([...members]),
			pages,
			complete: false,
			truncatedBy
		});
	}

	/** The configured Guild, re-checked: a broken assembly cannot make this adapter read another Guild. */
	private configuredGuildId(): string {
		if (!isDiscordSnowflake(this.deps.guildId)) {
			throw new DiscordRestFailureError({
				operation: DiscordRestOperation.guildSnapshot,
				reason: "validation",
				attempts: 0,
				fieldPath: "guildId",
				detail: "the configured Guild id is not a snowflake"
			});
		}

		return this.deps.guildId;
	}

	/** A caller-supplied resource id becomes path data only after it proves it is a snowflake. */
	private requireResourceId(operation: DiscordRestOperation, field: string, value: string): string {
		if (!isDiscordSnowflake(value)) {
			throw new DiscordRestFailureError({
				operation,
				reason: "validation",
				attempts: 0,
				fieldPath: field,
				detail: "expected a Discord snowflake string"
			});
		}

		return value;
	}
}

/** The status class as the boundary's named reason. `transient` and `rate-limit` only reach here exhausted. */
function restFailureReason(status: ReturnType<typeof classifyRestStatus>, code: number): DiscordRestFailureReason {
	switch (status) {
		case "rate-limit":
			return "rate-limit";
		case "transient":
			return "server-error";
		case "unauthorized":
			return "unauthorized";
		case "not-found":
			return "not-found";
		case "client-error":
			return "client-error";
		case "success":
			throw new DiscordRestFailureError({
				operation: DiscordRestOperation.guildSnapshot,
				reason: "validation",
				attempts: 0,
				detail: `status ${code} was classified as a success inside a failure path`
			});
	}
}
