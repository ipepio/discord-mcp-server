import { describe, expect, it } from "vitest";
import { DiscordRestFailureError } from "../../../../src/features/discord/gateways/discord-rest.errors.js";
import { DiscordRestOperation } from "../../../../src/features/discord/models/domain/discord-rest-operation.enum.js";
import { GUILD_ID } from "../fakes/normalize.js";
import {
	channelPayload,
	guildPayload,
	memberPayload,
	messagePayload,
	overwritePayload,
	REST_SECRET_CONTENT,
	rolePayload,
	threadMemberPayload,
	AUTHOR_ID,
	CHANNEL_ID,
	MESSAGE_ID,
	ROLE_ID,
	restHarness,
	THREAD_ID
} from "../fakes/rest-harness.js";
import {
	restClientError,
	restNetwork,
	restNotFound,
	restOk,
	restRateLimited,
	restServerError,
	restTimeout,
	restUnauthorized
} from "../fakes/fake-discord-rest-transport.js";

/**
 * R7 — the Discord REST boundary: bounded, rate-limit aware, timed out, validated, and typed as
 * application data on the way out. Every case runs against the fake REST transport, so no test contacts
 * Discord and every bound the spec names is asserted as a measured fact.
 */

const MEMBERS_PATH = `/guilds/${GUILD_ID}/members`;
const ROLES_PATH = `/guilds/${GUILD_ID}/roles`;
const CHANNELS_PATH = `/guilds/${GUILD_ID}/channels`;
const GUILD_PATH = `/guilds/${GUILD_ID}`;
const HISTORY_PATH = `/channels/${CHANNEL_ID}/messages`;
const MESSAGE_PATH = `/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`;
const THREAD_MEMBERS_PATH = `/channels/${THREAD_ID}/thread-members`;

describe("discord REST adapter — the bounded read contract", () => {
	it("reads the configured Guild snapshot as application data and asks Discord with_counts", async () => {
		const h = restHarness();
		h.transport.reply(GUILD_PATH, restOk(guildPayload()));

		const snapshot = await h.gateway.readGuildSnapshot();

		expect(snapshot).toEqual({
			guildId: GUILD_ID,
			name: "Example Guild HQ",
			ownerId: AUTHOR_ID,
			memberCount: 12_000
		});
		expect(h.transport.lastRequest().path).toBe(GUILD_PATH);
		expect(h.transport.lastRequest().query).toEqual({ with_counts: true });
		expect(h.transport.totalCalls()).toBe(1);
	});

	it("leaves a field Discord did not send absent instead of inventing an empty one (R3, R7)", async () => {
		const h = restHarness();
		h.transport.reply(GUILD_PATH, restOk({ id: GUILD_ID, name: "Only a name" }));

		const snapshot = await h.gateway.readGuildSnapshot();

		expect(Object.prototype.hasOwnProperty.call(snapshot, "ownerId")).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(snapshot, "memberCount")).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(snapshot, "isUnavailable")).toBe(false);
	});

	it("refuses a Guild snapshot that names another Guild: it is a validation failure, not a result", async () => {
		const h = restHarness();
		h.transport.reply(GUILD_PATH, restOk(guildPayload({ id: "999999999999999999" })));

		await expect(h.gateway.readGuildSnapshot()).rejects.toMatchObject({
			code: "DISCORD_REST_READ_FAILED",
			operation: DiscordRestOperation.guildSnapshot,
			reason: "validation",
			fieldPath: "id"
		});
	});

	it("reads the role list with the permission bitfield exactly as Discord sent it", async () => {
		const h = restHarness();
		h.transport.reply(
			ROLES_PATH,
			restOk([rolePayload(), rolePayload({ id: "600000000000000001", managed: true })])
		);

		const roles = await h.gateway.readRoles();

		expect(roles).toEqual([
			{
				guildId: GUILD_ID,
				roleId: ROLE_ID,
				name: "Staff",
				permissionsBitfield: "8",
				position: 3
			},
			{
				guildId: GUILD_ID,
				roleId: "600000000000000001",
				name: "Staff",
				permissionsBitfield: "8",
				position: 3,
				isManaged: true
			}
		]);
	});

	it("reads channels with their permission overwrites as application entries", async () => {
		const h = restHarness();
		h.transport.reply(
			CHANNELS_PATH,
			restOk([
				channelPayload({
					permission_overwrites: [
						overwritePayload(ROLE_ID, 0),
						overwritePayload(AUTHOR_ID, 1, { deny: "2048" })
					]
				})
			])
		);

		const channels = await h.gateway.readChannels();

		expect(channels[0]?.permissionOverwrites).toEqual([
			{ targetId: ROLE_ID, targetType: "role", allowBitfield: "1024", denyBitfield: "0" },
			{ targetId: AUTHOR_ID, targetType: "member", allowBitfield: "1024", denyBitfield: "2048" }
		]);
	});

	it("keeps an explicit empty overwrite set distinct from an absent one (R3, guild-state R10)", async () => {
		const h = restHarness();
		h.transport.reply(
			CHANNELS_PATH,
			restOk([
				channelPayload({ permission_overwrites: [] }),
				channelPayload({ id: "400000000000000009", permission_overwrites: undefined })
			])
		);

		const channels = await h.gateway.readChannels();

		expect(channels[0]?.permissionOverwrites).toEqual([]);
		expect(Object.prototype.hasOwnProperty.call(channels[1] ?? {}, "permissionOverwrites")).toBe(false);
	});

	it("rejects an unresolvable overwrite target naming the operation and the field path (R7 error)", async () => {
		const h = restHarness();
		h.transport.reply(
			CHANNELS_PATH,
			restOk([channelPayload({ permission_overwrites: [overwritePayload(ROLE_ID, 7)] })])
		);

		const failure = await h.gateway.readChannels().catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(DiscordRestFailureError);
		expect((failure as DiscordRestFailureError).reason).toBe("validation");
		expect((failure as DiscordRestFailureError).fieldPath).toBe("channels[0].permission_overwrites[0]");
		expect(h.transport.totalCalls()).toBe(1);
	});

	it("validates every id it puts into a path before the request exists (R2 applied to a read)", async () => {
		const h = restHarness();

		await expect(h.gateway.readMessageHistoryPage({ channelId: "not-a-snowflake" })).rejects.toMatchObject({
			reason: "validation",
			fieldPath: "channelId",
			attempts: 0
		});
		expect(h.transport.totalCalls()).toBe(0);
	});
});

describe("discord REST adapter — pagination and batch bounds", () => {
	it("walks a bounded member roster page by page and reports it complete on the short final page", async () => {
		const h = restHarness();
		h.transport.reply(
			MEMBERS_PATH,
			restOk([memberPayload("111111111111111111"), memberPayload("222222222222222222")]),
			restOk([memberPayload("333333333333333333")])
		);

		const roster = await h.gateway.readMemberRoster();

		expect(roster.complete).toBe(true);
		expect(roster.pages).toBe(2);
		expect(roster.members.map((member) => member.userId)).toEqual([
			"111111111111111111",
			"222222222222222222",
			"333333333333333333"
		]);
		expect(roster.members[0]?.roleIds).toEqual([ROLE_ID]);
		expect(roster.members[0]?.joinedInstant).toEqual(new Date("2026-01-02T03:04:05.000Z"));
		expect(h.transport.callsOn(MEMBERS_PATH)).toBe(2);
	});

	it("sends the page bound as the limit and the last member as the cursor", async () => {
		const h = restHarness();
		h.transport.reply(
			MEMBERS_PATH,
			restOk([memberPayload("111111111111111111"), memberPayload("222222222222222222")]),
			restOk([memberPayload("333333333333333333")])
		);

		await h.gateway.readMemberRoster();

		expect(h.transport.requests[0]?.query).toEqual({ limit: 2 });
		expect(h.transport.requests[1]?.query).toEqual({ limit: 2, after: "222222222222222222" });
	});

	it("never reports a roster that stopped at its page bound as complete (R7 example)", async () => {
		const h = restHarness();
		// Every page comes back full, so the bound is what stops the read.
		for (let page = 0; page < 4; page += 1) {
			h.transport.reply(
				MEMBERS_PATH,
				restOk([memberPayload(`8${page}0000000000000000`), memberPayload(`8${page}1000000000000000`)])
			);
		}

		const roster = await h.gateway.readMemberRoster();

		expect(roster.complete).toBe(false);
		expect(roster.truncatedBy).toBe("page-limit");
		expect(roster.pages).toBe(3);
		expect(roster.members).toHaveLength(6);
		expect(h.transport.callsOn(MEMBERS_PATH)).toBe(3);
	});

	it("stops at a caller's member bound and says which bound stopped it", async () => {
		const h = restHarness();
		for (let page = 0; page < 4; page += 1) {
			h.transport.reply(
				MEMBERS_PATH,
				restOk([memberPayload(`9${page}0000000000000000`), memberPayload(`9${page}1000000000000000`)])
			);
		}

		const roster = await h.gateway.readMemberRoster({ maxMembers: 3 });

		expect(roster.complete).toBe(false);
		expect(roster.truncatedBy).toBe("member-limit");
		expect(roster.members).toHaveLength(3);
		expect(h.transport.callsOn(MEMBERS_PATH)).toBe(2);
	});

	it("clamps a page-size request to the policy bound and never to more than Discord allows", async () => {
		const h = restHarness({ policy: { memberPageSize: 1_000 } });
		h.transport.reply(MEMBERS_PATH, restOk([]));

		await h.gateway.readMemberRoster();

		expect(h.transport.lastRequest().query["limit"]).toBe(1_000);

		const history = await h.gateway.readMessageHistoryPage({ channelId: CHANNEL_ID, limit: 500 });

		expect(history.requestedLimit).toBe(100);
		expect(h.transport.lastRequest().query["limit"]).toBe(100);
	});

	it("returns a history page in Discord's own order and names the cursor of the older page", async () => {
		const h = restHarness({ policy: { messagePageSize: 3 } });
		h.transport.reply(
			HISTORY_PATH,
			restOk([
				messagePayload("500000000000000003"),
				messagePayload("500000000000000002"),
				messagePayload("500000000000000001", { content: "older" })
			])
		);

		const page = await h.gateway.readMessageHistoryPage({ channelId: CHANNEL_ID });

		expect(page.messages.map((message) => message.messageId)).toEqual([
			"500000000000000003",
			"500000000000000002",
			"500000000000000001"
		]);
		expect(page.hasMore).toBe(true);
		expect(page.nextBeforeId).toBe("500000000000000001");
		expect(page.messages[0]?.content).toBe(REST_SECRET_CONTENT);
	});

	it("preserves REST webhook provenance so overlapping backfill cannot clear it", async () => {
		const h = restHarness();
		h.transport.reply(HISTORY_PATH, restOk([messagePayload(MESSAGE_ID, { webhook_id: "500000000000000099" })]));
		const page = await h.gateway.readMessageHistoryPage({ channelId: CHANNEL_ID });
		expect(page.messages[0]?.webhookId).toBe("500000000000000099");
	});

	it("reports a short history page as the end of what it was asked for, never as the end of the channel", async () => {
		const h = restHarness({ policy: { messagePageSize: 100 } });
		h.transport.reply(HISTORY_PATH, restOk([messagePayload(MESSAGE_ID)]));

		const page = await h.gateway.readMessageHistoryPage({ channelId: CHANNEL_ID, before: "500000000000000009" });

		expect(page.hasMore).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(page, "nextBeforeId")).toBe(false);
		expect(h.transport.lastRequest().query).toEqual({ limit: 100, before: "500000000000000009" });
	});

	it("refuses a history read that asks for both directions and sends nothing", async () => {
		const h = restHarness();

		await expect(
			h.gateway.readMessageHistoryPage({ channelId: CHANNEL_ID, before: "1", after: "2" })
		).rejects.toMatchObject({ reason: "client-error", fieldPath: "before" });
		expect(h.transport.totalCalls()).toBe(0);
	});

	it("reads a bounded thread-member page where the API allows it", async () => {
		const h = restHarness();
		h.transport.reply(
			THREAD_MEMBERS_PATH,
			restOk([
				threadMemberPayload(AUTHOR_ID),
				threadMemberPayload("300000000000000001", { join_timestamp: undefined })
			])
		);

		const page = await h.gateway.readThreadMembers({ threadId: THREAD_ID });

		expect(page.members).toEqual([
			{ threadId: THREAD_ID, userId: AUTHOR_ID, joinInstant: new Date("2026-11-05T09:00:00.000Z") },
			{ threadId: THREAD_ID, userId: "300000000000000001" }
		]);
		expect(page.hasMore).toBe(false);
		expect(h.transport.lastRequest().query).toEqual({ limit: 100 });
	});

	it("rejects a thread-member payload that belongs to another thread", async () => {
		const h = restHarness();
		h.transport.reply(THREAD_MEMBERS_PATH, restOk([threadMemberPayload(AUTHOR_ID, { id: "400000000000000099" })]));

		await expect(h.gateway.readThreadMembers({ threadId: THREAD_ID })).rejects.toMatchObject({
			reason: "validation",
			fieldPath: "thread_members[0].id"
		});
	});
});

/**
 * One message read whole by id — the reconciliation read docs/features/ingestion.md R5 puts before any
 * partial Gateway update may overwrite stored state. It is a read like every other read here, so the same
 * four promises are asserted on it: one bounded request for one resource, ids validated before a path is
 * built, a response that does not confirm the resource refused as a named validation failure, and transient
 * failures retried inside the bound while a client error is surfaced as it is.
 */
describe("discord REST adapter — one message whole by id", () => {
	it("reads the message as application data, with no query and the policy timeout on the single request", async () => {
		const h = restHarness({ policy: { timeoutMs: 2_500 } });
		h.transport.reply(
			MESSAGE_PATH,
			restOk(messagePayload(MESSAGE_ID, { edited_timestamp: "2026-11-05T12:00:00.000Z" }))
		);

		const message = await h.gateway.readMessage({ channelId: CHANNEL_ID, messageId: MESSAGE_ID });

		expect(message).toEqual({
			messageId: MESSAGE_ID,
			channelId: CHANNEL_ID,
			authorId: AUTHOR_ID,
			content: REST_SECRET_CONTENT,
			createdInstant: new Date("2026-11-05T10:00:00.000Z"),
			messageType: "default",
			authorUsername: "someone",
			authorIsBot: false,
			isPinned: false,
			editedInstant: new Date("2026-11-05T12:00:00.000Z"),
			attachments: []
		});
		expect(h.transport.lastRequest().path).toBe(MESSAGE_PATH);
		expect(h.transport.lastRequest().query).toEqual({});
		expect(h.transport.lastRequest().operation).toBe(DiscordRestOperation.message);
		expect(h.transport.timeouts).toEqual([2_500]);
		expect(h.transport.totalCalls()).toBe(1);
	});

	it("leaves a field Discord did not send absent, so a reconciliation never sees an invented empty (R3)", async () => {
		const h = restHarness();
		h.transport.reply(MESSAGE_PATH, restOk(messagePayload(MESSAGE_ID, { edited_timestamp: null })));

		const message = await h.gateway.readMessage({ channelId: CHANNEL_ID, messageId: MESSAGE_ID });

		expect(Object.prototype.hasOwnProperty.call(message, "editedInstant")).toBe(false);
	});

	it("validates both ids of the read before any request exists, so neither can become path data (R2 applied to a read)", async () => {
		const h = restHarness();

		await expect(
			h.gateway.readMessage({ channelId: "not-a-snowflake", messageId: MESSAGE_ID })
		).rejects.toMatchObject({
			reason: "validation",
			fieldPath: "channelId",
			operation: DiscordRestOperation.message
		});
		await expect(h.gateway.readMessage({ channelId: CHANNEL_ID, messageId: "0" })).rejects.toMatchObject({
			reason: "validation",
			fieldPath: "messageId"
		});
		expect(h.transport.totalCalls()).toBe(0);
	});

	it("refuses a response that names another message than the one read, rather than returning it", async () => {
		const h = restHarness();
		h.transport.reply(MESSAGE_PATH, restOk(messagePayload("500000000000000999")));

		await expect(h.gateway.readMessage({ channelId: CHANNEL_ID, messageId: MESSAGE_ID })).rejects.toMatchObject({
			reason: "validation",
			fieldPath: "id",
			attempts: 1
		});
		// One call: a payload Discord sent wrong is a decision, not a transient failure to retry.
		expect(h.transport.callsOn(MESSAGE_PATH)).toBe(1);
	});

	it("refuses a response from another channel than the container the read was scoped to", async () => {
		const h = restHarness();
		h.transport.reply(MESSAGE_PATH, restOk(messagePayload(MESSAGE_ID, { channel_id: "400000000000000099" })));

		await expect(h.gateway.readMessage({ channelId: CHANNEL_ID, messageId: MESSAGE_ID })).rejects.toMatchObject({
			reason: "validation",
			fieldPath: "channel_id"
		});
	});

	it("names the missing field of a malformed message payload, because a reconciliation cannot invent it (R7 error)", async () => {
		const h = restHarness();
		h.transport.reply(
			MESSAGE_PATH,
			restOk({ id: MESSAGE_ID, channel_id: CHANNEL_ID, timestamp: "2026-01-01T00:00:00.000Z" })
		);

		await expect(h.gateway.readMessage({ channelId: CHANNEL_ID, messageId: MESSAGE_ID })).rejects.toMatchObject({
			reason: "validation",
			fieldPath: "author"
		});
		expect(h.transport.callsOn(MESSAGE_PATH)).toBe(1);
	});

	it("retries a transient failure of the reconciliation read inside its bound and returns the message", async () => {
		const h = restHarness();
		h.transport.reply(MESSAGE_PATH, restServerError(), restRateLimited(150), restOk(messagePayload(MESSAGE_ID)));

		const message = await h.gateway.readMessage({ channelId: CHANNEL_ID, messageId: MESSAGE_ID });

		expect(message.messageId).toBe(MESSAGE_ID);
		expect(h.transport.callsOn(MESSAGE_PATH)).toBe(3);
		expect(h.delays).toEqual([100, 150]);
	});

	it("never retries a client error, so a deferred reconciliation costs one request and says which failure it was", async () => {
		const forbidden = restHarness();
		forbidden.transport.reply(MESSAGE_PATH, restUnauthorized());
		await expect(
			forbidden.gateway.readMessage({ channelId: CHANNEL_ID, messageId: MESSAGE_ID })
		).rejects.toMatchObject({ reason: "unauthorized", status: 403, attempts: 1 });

		const missing = restHarness();
		missing.transport.reply(MESSAGE_PATH, restNotFound());
		await expect(
			missing.gateway.readMessage({ channelId: CHANNEL_ID, messageId: MESSAGE_ID })
		).rejects.toMatchObject({ reason: "not-found", status: 404, attempts: 1 });

		expect(forbidden.transport.callsOn(MESSAGE_PATH)).toBe(1);
		expect(missing.transport.callsOn(MESSAGE_PATH)).toBe(1);
	});

	it("keeps message content out of every line a failed reconciliation read writes (R11)", async () => {
		const h = restHarness();
		for (let attempt = 0; attempt < 3; attempt += 1) {
			h.transport.reply(MESSAGE_PATH, restServerError());
		}
		// The body would carry the text: the failure path must never have handed it to the logger.
		h.transport.reply(MESSAGE_PATH, restOk(messagePayload(MESSAGE_ID)));

		await expect(h.gateway.readMessage({ channelId: CHANNEL_ID, messageId: MESSAGE_ID })).rejects.toMatchObject({
			reason: "server-error",
			operation: DiscordRestOperation.message
		});

		expect(h.logger.transcript()).not.toContain(REST_SECRET_CONTENT);
		expect(h.logger.messagesMatching("Discord REST read retrying within its budget")).toHaveLength(2);
	});
});

describe("discord REST adapter — transient failures, retries and budget", () => {
	it("waits out a 429 inside its budget and retries the page, honouring Discord's own wait", async () => {
		const h = restHarness();
		h.transport.reply(ROLES_PATH, restRateLimited(250), restOk([rolePayload()]));

		const roles = await h.gateway.readRoles();

		expect(roles).toHaveLength(1);
		expect(h.transport.callsOn(ROLES_PATH)).toBe(2);
		expect(h.delays).toEqual([250]);
		expect(h.logger.messagesMatching("Discord REST read retrying within its budget")).toHaveLength(1);
	});

	it("falls back to its own backoff when a 429 does not quantify the wait", async () => {
		const h = restHarness();
		h.transport.reply(ROLES_PATH, restRateLimited(), restOk([]));

		await h.gateway.readRoles();

		expect(h.delays).toEqual([h.policy.baseDelayMs]);
	});

	it("retries a 5xx with bounded backoff and reports the attempts it used", async () => {
		const h = restHarness();
		h.transport.reply(ROLES_PATH, restServerError(), restServerError(), restOk([rolePayload()]));

		const roles = await h.gateway.readRoles();

		expect(roles).toHaveLength(1);
		expect(h.transport.callsOn(ROLES_PATH)).toBe(3);
		expect(h.delays).toEqual([100, 200]);
	});

	it("gives up after the bounded attempt count and names the failure instead of looping", async () => {
		const h = restHarness();
		for (let attempt = 0; attempt < 5; attempt += 1) {
			h.transport.reply(ROLES_PATH, restServerError(503));
		}

		const failure = await h.gateway.readRoles().catch((error: unknown) => error);

		expect((failure as DiscordRestFailureError).reason).toBe("server-error");
		expect((failure as DiscordRestFailureError).status).toBe(503);
		expect((failure as DiscordRestFailureError).attempts).toBe(3);
		expect(h.transport.callsOn(ROLES_PATH)).toBe(3);
	});

	it("refuses a rate-limit wait that does not fit the budget rather than stalling the consumer", async () => {
		const h = restHarness({ policy: { maxSingleWaitMs: 200 } });
		h.transport.reply(ROLES_PATH, restRateLimited(10_000), restOk([]));

		const failure = await h.gateway.readRoles().catch((error: unknown) => error);

		expect((failure as DiscordRestFailureError).reason).toBe("rate-limit");
		expect((failure as DiscordRestFailureError).status).toBe(429);
		expect(h.transport.callsOn(ROLES_PATH)).toBe(1);
		expect(h.delays).toEqual([]);
	});

	it("treats a timeout as transient, retries it inside the bound, and surfaces it named when the bound runs out", async () => {
		const h = restHarness();
		h.transport.reply(ROLES_PATH, restTimeout(), restTimeout(), restTimeout());

		const failure = await h.gateway.readRoles().catch((error: unknown) => error);

		expect((failure as DiscordRestFailureError).reason).toBe("timeout");
		expect((failure as DiscordRestFailureError).attempts).toBe(3);
		expect(h.transport.callsOn(ROLES_PATH)).toBe(3);
	});

	it("surfaces a successful timeout-free read after one timeout, so a single stall does not fail the read", async () => {
		const h = restHarness();
		h.transport.reply(ROLES_PATH, restTimeout(), restOk([rolePayload()]));

		await expect(h.gateway.readRoles()).resolves.toHaveLength(1);
		expect(h.transport.callsOn(ROLES_PATH)).toBe(2);
	});

	it("names a request that never reached Discord as a transport failure", async () => {
		const h = restHarness();
		for (let attempt = 0; attempt < 3; attempt += 1) {
			h.transport.reply(GUILD_PATH, restNetwork());
		}

		await expect(h.gateway.readGuildSnapshot()).rejects.toMatchObject({ reason: "transport", attempts: 3 });
	});

	it("never retries a client error and names it as it is (R7)", async () => {
		const h = restHarness();
		h.transport.reply(ROLES_PATH, restClientError(), restOk([rolePayload()]));

		const failure = await h.gateway.readRoles().catch((error: unknown) => error);

		expect((failure as DiscordRestFailureError).reason).toBe("client-error");
		expect((failure as DiscordRestFailureError).status).toBe(400);
		expect((failure as DiscordRestFailureError).attempts).toBe(1);
		expect(h.transport.callsOn(ROLES_PATH)).toBe(1);
		expect(h.delays).toEqual([]);
	});

	it("reports a permission failure and an absent resource as distinct named failures, without any write", async () => {
		const forbidden = restHarness();
		forbidden.transport.reply(THREAD_MEMBERS_PATH, restUnauthorized());
		await expect(forbidden.gateway.readThreadMembers({ threadId: THREAD_ID })).rejects.toMatchObject({
			reason: "unauthorized",
			status: 403,
			attempts: 1
		});

		const missing = restHarness();
		missing.transport.reply(HISTORY_PATH, restNotFound());
		await expect(missing.gateway.readMessageHistoryPage({ channelId: CHANNEL_ID })).rejects.toMatchObject({
			reason: "not-found",
			status: 404
		});
		expect(forbidden.transport.totalCalls()).toBe(1);
		expect(missing.transport.totalCalls()).toBe(1);
	});

	it("does not retry a payload that failed validation: a malformed response is a decision, not a transient", async () => {
		const h = restHarness();
		h.transport.reply(ROLES_PATH, restOk([{ name: "a role without an id" }]), restOk([]));

		const failure = await h.gateway.readRoles().catch((error: unknown) => error);

		expect((failure as DiscordRestFailureError).reason).toBe("validation");
		expect((failure as DiscordRestFailureError).fieldPath).toBe("roles[0].id");
		expect(h.transport.callsOn(ROLES_PATH)).toBe(1);
	});

	it("passes the policy timeout to every request it makes, including the second page", async () => {
		const h = restHarness({ policy: { timeoutMs: 2_500 } });
		h.transport.reply(
			MEMBERS_PATH,
			restOk([memberPayload("111111111111111111"), memberPayload("222222222222222222")]),
			restOk([memberPayload("333333333333333333")])
		);

		await h.gateway.readMemberRoster();

		expect(h.transport.timeouts).toEqual([2_500, 2_500]);
	});

	it("never overlaps two Discord requests, even across two concurrent consumer reads", async () => {
		const h = restHarness();
		h.transport.reply(ROLES_PATH, restRateLimited(10), restOk([rolePayload()]));
		h.transport.reply(CHANNELS_PATH, restOk([channelPayload()]));

		const [roles, channels] = await Promise.all([h.gateway.readRoles(), h.gateway.readChannels()]);

		expect(roles).toHaveLength(1);
		expect(channels).toHaveLength(1);
		expect(h.transport.maxInFlight).toBe(1);
	});

	it("fails the whole roster when a page cannot be read: a partial roster never leaves as a result", async () => {
		const h = restHarness();
		h.transport.reply(
			MEMBERS_PATH,
			restOk([memberPayload("111111111111111111"), memberPayload("222222222222222222")]),
			restServerError()
		);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			h.transport.reply(MEMBERS_PATH, restServerError());
		}

		await expect(h.gateway.readMemberRoster()).rejects.toBeInstanceOf(DiscordRestFailureError);
	});
});
