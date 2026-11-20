import { describe, expect, it } from "vitest";
import { DiscordEventKind } from "../../../src/features/discord/models/domain/discord-event-kind.enum.js";
import { DiscordConnectionStatus } from "../../../src/features/discord/models/domain/discord-connection-status.js";
import { DiscordStatusGateway } from "../../../src/features/discord/gateways/discord-status.gateway.js";
import {
	REDACTED_FIELD_VALUE,
	StructuredLogger,
	type LogWriter
} from "../../../src/shared/logging/structured-logger.js";
import { composeInstallation, messageFixture, type Installation } from "./fakes/composed-installation.js";
import { DeliveryRecorder } from "./fakes/delivery-recorder.js";
import { GUILD_ID } from "./fakes/normalize.js";
import {
	CHANNEL_ID,
	restHarness,
	REST_FIXTURE_TOKEN,
	REST_SECRET_CONTENT,
	messagePayload
} from "./fakes/rest-harness.js";
import { restClientError, restOk, restRateLimited } from "./fakes/fake-discord-rest-transport.js";
import { DiscordRestFailureError } from "../../../src/features/discord/gateways/discord-rest.errors.js";

/**
 * R11 — observability and log safety, measured through the one status read the feature exposes.
 *
 * The scenario below produces every anomaly the requirement names — a foreign Guild drop, a Guild-less
 * payload, an unknown kind, a rejected payload, a delivery failure, reconnect attempts, resync signals —
 * and then asserts two things: that the status read reports each of them as a count and an instant, and
 * that nothing the fixture puts into a payload ever reaches a log line, an error message or the status
 * transcript. Content passes through this feature in memory only; log safety never blocks delivery.
 */

const FOREIGN_GUILD_ID = "999999999999999999";
const MESSAGE_PATH = `/channels/${CHANNEL_ID}/messages`;

function statusOf(installation: Installation): ReturnType<DiscordStatusGateway["read"]> {
	return new DiscordStatusGateway({
		connection: installation.connection,
		counters: installation.counters,
		delivery: installation.stream,
		gaps: installation.gaps,
		clock: installation.clock,
		logger: installation.logger
	}).read();
}

/** Runs the whole anomaly catalogue through one Installation, with content in every payload. */
async function reportEverything(): Promise<Installation> {
	const h = composeInstallation();
	const seen: DiscordEventKind[] = [];

	h.stream.subscribe(DiscordEventKind.messageCreated, (event) => {
		seen.push(event.kind);
		if (event.kind === DiscordEventKind.messageCreated) {
			throw new Error("the consumer's own failure: R4 says it must not stop the connection");
		}
	});
	h.stream.subscribe(DiscordEventKind.resyncNeeded, (event) => {
		seen.push(event.kind);
	});

	await h.connection.start();
	await h.stream.settle();

	// R3: a known kind whose payload does not validate.
	h.emitRaw("MESSAGE_CREATE", {
		id: "700",
		channel_id: "400",
		guild_id: GUILD_ID,
		content: REST_SECRET_CONTENT,
		timestamp: "not-a-time",
		type: 0
	});
	// R2: another Guild, then a payload that names no Guild at all.
	h.emitRaw("MESSAGE_CREATE", messageFixture({ guild_id: FOREIGN_GUILD_ID }));
	h.emitRaw("MESSAGE_CREATE", { ...messageFixture(), guild_id: undefined });
	// R3: an unknown raw kind, counted by its raw name.
	h.emitRaw("THREAD_MEMBER_LIST_SYNC", { id: "410", guild_id: GUILD_ID, member_ids: ["300"] });
	// R4: a well-formed payload for a kind with no handler, and one that reaches the throwing handler.
	h.emitRaw("MESSAGE_CREATE", messageFixture({ id: "701" }));
	await h.stream.settle();

	// R1, R5: a disconnect and the reconnect attempts that follow it.
	h.emitDisconnect();
	h.advance(5_000);
	await h.connection.settle();
	await h.stream.settle();

	return h;
}

describe("R11 — the status read reports what the requirement names", () => {
	it("carries connection state, the counter catalogue, the delivery facts and the pending gaps", async () => {
		const h = await reportEverything();
		const status = statusOf(h);

		expect(status.connection.status).toBe(DiscordConnectionStatus.connected);
		expect(status.connection.epoch).toBeGreaterThanOrEqual(1);
		expect(status.connection.lastConnectedInstant).toBeInstanceOf(Date);
		expect(status.connection.lastDisconnectedInstant).toBeInstanceOf(Date);
		expect(status.observedAt).toBeInstanceOf(Date);

		const counters = status.counters;
		expect(counters.receivedRawEvents).toBe(5);
		expect(counters.droppedAsForeignGuild).toBe(1);
		expect(counters.droppedForeignGuildIds).toEqual([FOREIGN_GUILD_ID]);
		expect(counters.droppedGuildLess).toBe(1);
		expect(counters.rejectedPayloadPerKind[DiscordEventKind.messageCreated]).toBe(1);
		expect(counters.unknownKindByRawName).toEqual({ THREAD_MEMBER_LIST_SYNC: 1 });
		expect(counters.normalizedPerKind[DiscordEventKind.messageCreated]).toBe(1);
		expect(counters.deliveryFailuresPerKind[DiscordEventKind.messageCreated]).toBe(1);
		expect(counters.reconnectAttempts).toBeGreaterThanOrEqual(1);
		expect(counters.resyncSignalsPublished).toBeGreaterThanOrEqual(2);

		expect(status.delivery.accepting).toBe(true);
		expect(status.delivery.pending).toBe(0);
		expect(status.delivery.handlerCountByKind[DiscordEventKind.messageCreated]).toBe(1);
		expect(status.delivery.handlerCountByKind[DiscordEventKind.channelCreated]).toBe(0);
		expect(status.delivery.lastDeliveredInstant).toBeInstanceOf(Date);
	});

	it("reports a gap the shutdown declared until a signal summarizes it (R6, R5)", async () => {
		const h = composeInstallation({ drainWindowMs: 50 });
		const seen = new DeliveryRecorder(h.stream);
		seen.observe(DiscordEventKind.messageCreated);
		seen.hang(DiscordEventKind.messageCreated);
		await h.connection.start();
		await h.stream.settle();

		// A consumer that never answers: the bounded window ends it and writes the loss off as a gap (R6).
		h.emitRaw("MESSAGE_CREATE", messageFixture({ id: "777" }));
		const report = await h.shutdown.shutdown();
		const status = statusOf(h);

		expect(report.drain.expired).toBe(true);
		expect(report.gapDeclared).toBe(true);
		expect(status.pendingGaps.map((gap) => gap.reason)).toEqual(["drain-expiry"]);
		expect(status.counters.undeliveredPerKind[DiscordEventKind.messageCreated]).toBe(1);
		expect(status.connection.status).toBe(DiscordConnectionStatus.disconnected);
		expect(status.delivery.accepting).toBe(false);
	});

	it("logs the status read itself as ids and counts only", async () => {
		const h = await reportEverything();
		h.logger.clear();

		statusOf(h);

		const line = h.logger.lines.at(-1);
		expect(line?.message).toBe("Discord feature status read");
		expect(Object.keys(line?.fields ?? {}).sort()).toEqual([
			"delivered",
			"droppedAsForeignGuild",
			"epoch",
			"observedAt",
			"pending",
			"pendingGaps",
			"receivedRawEvents",
			"reconnectAttempts",
			"status"
		]);
	});
});

describe("R11 — no log line, error message or status field carries content or a credential", () => {
	it("scans every line the whole anomaly run emitted, through the recording logger", async () => {
		const h = await reportEverything();
		const transcript = h.logger.transcript();

		expect(transcript).not.toContain(REST_SECRET_CONTENT);
		expect(transcript).not.toContain(REST_FIXTURE_TOKEN);
		expect(transcript).not.toContain("hello there");
		expect(JSON.stringify(statusOf(h))).not.toContain(REST_SECRET_CONTENT);
	});

	it("scans the field names this feature ever emits, across the whole anomaly run", async () => {
		const h = await reportEverything();
		// The strongest form of the rule: the feature never even names a field that could hold one.
		const forbiddenKeys = h.logger.lines.flatMap((line) =>
			Object.keys(line.fields).filter((key) =>
				/content|text|body|payload|token|authorization|secret|credential/i.test(key)
			)
		);

		expect(forbiddenKeys).toEqual([]);

		// The one name-shaped field R11 asks for is a raw event name, and it carries the name only.
		const rawNames = h.logger.lines
			.map((line) => line.fields["rawEventName"])
			.filter((value): value is string => typeof value === "string");

		expect(rawNames.length).toBeGreaterThan(0);
		expect(rawNames.every((name) => /^[A-Z][A-Z_]*$/.test(name))).toBe(true);
	});

	it("scans real structured log output, including the credential redaction layer", () => {
		const lines: string[] = [];
		const writer: LogWriter = (line) => lines.push(line);
		const structured = new StructuredLogger(
			"debug",
			writer,
			{ feature: "discord" },
			() => new Date("2026-11-05T10:00:00.000Z")
		);

		// The shapes this feature actually logs: ids, kinds, counts, a route and a wait (R11).
		structured.info("Discord message event normalized", {
			kind: DiscordEventKind.messageCreated,
			guildId: GUILD_ID,
			messageId: "500"
		});
		structured.warn("Discord REST read retrying within its budget", {
			operation: MESSAGE_PATH,
			route: MESSAGE_PATH,
			status: 429,
			waitMs: 250
		});
		// A credential-shaped field is redacted by the shared logger rather than emitted (shared/logging).
		structured.error("Discord login rejected", {
			token: REST_FIXTURE_TOKEN,
			authorization: `Bot ${REST_FIXTURE_TOKEN}`
		});

		const output = lines.join("\n");
		expect(output).toContain(`"route":"${MESSAGE_PATH}"`);
		expect(output).toContain(REDACTED_FIELD_VALUE);
		expect(output).not.toContain(REST_SECRET_CONTENT);
		expect(output).not.toContain(REST_FIXTURE_TOKEN);
	});

	it("keeps message content out of a REST validation failure and out of the retry log", async () => {
		const h = restHarness();
		h.transport.reply(MESSAGE_PATH, restRateLimited(120), restOk([messagePayload("500000000000000001")]));

		const page = await h.gateway.readMessageHistoryPage({ channelId: CHANNEL_ID });
		expect(page.messages[0]?.content).toBe(REST_SECRET_CONTENT);

		const retryLine = h.logger.transcript();
		expect(retryLine).toContain(MESSAGE_PATH);
		expect(retryLine).toContain("120");
		expect(retryLine).not.toContain(REST_SECRET_CONTENT);
	});

	it("names a client error by route and status, never by the response body", async () => {
		const h = restHarness();
		h.transport.reply(MESSAGE_PATH, restClientError(400));

		const failure = await h.gateway
			.readMessageHistoryPage({ channelId: CHANNEL_ID })
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(DiscordRestFailureError);
		const message = (failure as DiscordRestFailureError).message;
		expect(message).toContain("status 400");
		expect(message).not.toContain(REST_SECRET_CONTENT);
		expect(h.logger.transcript()).not.toContain(REST_SECRET_CONTENT);
	});

	it("reports a rejected payload as a field path, not as the value that failed (R3, R11)", async () => {
		const h = restHarness();
		h.transport.reply(
			MESSAGE_PATH,
			restOk([{ ...messagePayload("500000000000000002"), timestamp: REST_SECRET_CONTENT }])
		);

		const failure = await h.gateway
			.readMessageHistoryPage({ channelId: CHANNEL_ID })
			.catch((error: unknown) => error);
		const text = `${(failure as DiscordRestFailureError).message} ${h.logger.transcript()}`;

		expect((failure as DiscordRestFailureError).fieldPath).toBe("messages[0].timestamp");
		expect(text).not.toContain(REST_SECRET_CONTENT);
	});
});
