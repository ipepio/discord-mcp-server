import type { DiscordRestGatewayDependencies } from "../../../../src/features/discord/gateways/discord-rest.gateway.js";
import { DiscordRestGateway } from "../../../../src/features/discord/gateways/discord-rest.gateway.js";
import type { DiscordRestReadPolicy } from "../../../../src/features/discord/models/domain/discord-rest-policy.js";
import { DEFAULT_DISCORD_REST_READ_POLICY } from "../../../../src/features/discord/models/domain/discord-rest-policy.js";
import { GUILD_ID } from "./normalize.js";
import { FakeDiscordRestTransport } from "./fake-discord-rest-transport.js";
import { fakeClock, fakeWait } from "./fake-discord-gateway-client.js";
import { RecordingLogger } from "./recording-logger.js";

/**
 * The REST harness: the adapter under test over the fake transport, with a deterministic clock, a wait
 * that records instead of sleeping, and a logger whose transcript the assertions scan. This is the only
 * place a test composes the REST boundary, so the bounds the spec names (page size, page count, attempts,
 * budget, timeout) are always the ones a test chose rather than the deployment defaults.
 */

export const CHANNEL_ID = "400000000000000000";
export const THREAD_ID = "400000000000000001";
export const AUTHOR_ID = "300000000000000000";
export const MESSAGE_ID = "500000000000000000";
export const ROLE_ID = "600000000000000000";

/** Message text that must never appear in a log line or an error message (R11). */
export const REST_SECRET_CONTENT = "top-secret-message-content-must-never-be-logged";
/** A credential-shaped value that must never appear in a log line or an error message (R11). */
export const REST_FIXTURE_TOKEN = "bot.token-MUST-NEVER-APPEAR-IN-LOGS";

/** Bounds a test wants different from the defaults the production adapter runs with. */
export type RestPolicyOverrides = Partial<DiscordRestReadPolicy>;

export interface RestHarness {
	readonly gateway: DiscordRestGateway;
	readonly transport: FakeDiscordRestTransport;
	readonly logger: RecordingLogger;
	readonly delays: number[];
	readonly policy: DiscordRestReadPolicy;
	readonly advance: (milliseconds: number) => void;
}

/** The v1 defaults, shrunk so a bounded test never waits on the production bounds. */
export function restPolicy(overrides: RestPolicyOverrides = {}): DiscordRestReadPolicy {
	return Object.freeze({
		...DEFAULT_DISCORD_REST_READ_POLICY,
		timeoutMs: 1_000,
		maxAttempts: 3,
		baseDelayMs: 100,
		factor: 2,
		maxDelayMs: 1_000,
		budgetMs: 3_000,
		maxSingleWaitMs: 2_000,
		memberPageSize: 2,
		memberMaxPages: 3,
		...overrides
	});
}

export function restHarness(
	options: { readonly policy?: RestPolicyOverrides; readonly guildId?: string } = {}
): RestHarness {
	const transport = new FakeDiscordRestTransport();
	const logger = new RecordingLogger();
	const timing = fakeClock();
	const waiter = fakeWait();
	const policy = restPolicy(options.policy ?? {});

	const gateway = new DiscordRestGateway({
		transport,
		guildId: options.guildId ?? GUILD_ID,
		policy,
		logger,
		clock: timing.clock,
		wait: waiter.wait
	} satisfies DiscordRestGatewayDependencies);

	return {
		gateway,
		transport,
		logger,
		delays: waiter.delays,
		policy,
		advance: timing.advance
	};
}

/** Discord's own REST guild object, in wire shape. */
export function guildPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: GUILD_ID,
		name: "Example Guild HQ",
		icon: "hash-value",
		owner_id: AUTHOR_ID,
		member_count: 12_000,
		...overrides
	};
}

export function rolePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: ROLE_ID,
		name: "Staff",
		permissions: "8",
		position: 3,
		color: 16_711_935,
		...overrides
	};
}

export function overwritePayload(
	id: string,
	type: number,
	overrides: Record<string, unknown> = {}
): Record<string, unknown> {
	return { id, type, allow: "1024", deny: "0", ...overrides };
}

export function channelPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: CHANNEL_ID,
		type: 0,
		name: "general",
		position: 1,
		parent_id: "700000000000000000",
		permission_overwrites: [overwritePayload(ROLE_ID, 0)],
		...overrides
	};
}

export function memberPayload(userId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		user: { id: userId, username: `user-${userId}`, bot: false },
		roles: [ROLE_ID],
		nick: `nick-${userId}`,
		joined_at: "2026-01-02T03:04:05.000Z",
		pending: false,
		...overrides
	};
}

export function messagePayload(messageId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: messageId,
		channel_id: CHANNEL_ID,
		guild_id: GUILD_ID,
		author: { id: AUTHOR_ID, username: "someone", bot: false },
		content: REST_SECRET_CONTENT,
		timestamp: "2026-11-05T10:00:00.000Z",
		type: 0,
		pinned: false,
		attachments: [],
		...overrides
	};
}

export function threadMemberPayload(userId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: THREAD_ID,
		user_id: userId,
		join_timestamp: "2026-11-05T09:00:00.000Z",
		flags: 0,
		...overrides
	};
}
