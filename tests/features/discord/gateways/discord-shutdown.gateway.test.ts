import { describe, expect, it } from "vitest";
import { DiscordConnectionStatus } from "../../../../src/features/discord/models/domain/discord-connection-status.js";
import { DiscordEventKind } from "../../../../src/features/discord/models/domain/discord-event-kind.enum.js";
import { DiscordConnectionStateError } from "../../../../src/features/discord/gateways/discord-connection.errors.js";
import type {
	MessageCreatedEvent,
	NormalizedDiscordEvent
} from "../../../../src/features/discord/models/domain/normalized-discord-event.js";
import type { DiscordShutdownReport } from "../../../../src/features/discord/gateways/discord-shutdown.gateway.js";
import { composeInstallation, messageFixture } from "../fakes/composed-installation.js";
import type { Installation, InstallationOptions } from "../fakes/composed-installation.js";
import { DeliveryRecorder } from "../fakes/delivery-recorder.js";
import { GUILD_ID, normalizeOne } from "../fakes/normalize.js";

/**
 * R6 — clean shutdown: stop accepting, deliver what is already normalized inside a bounded window, close.
 * Every case ends with the connection closed, and every event either reached its handler or is counted per
 * kind inside a declared gap. Nothing in here waits for real time: the injected clock moves when the
 * drain waits, so the window expires on schedule and the slow consumer never gets to hold shutdown open.
 */

interface Started {
	readonly h: Installation;
	readonly seen: DeliveryRecorder;
}

async function started(options: InstallationOptions = {}): Promise<Started> {
	const h = composeInstallation(options);
	const seen = new DeliveryRecorder(h.stream);
	seen.observe(DiscordEventKind.resyncNeeded);
	seen.observe(DiscordEventKind.messageCreated);
	seen.observe(DiscordEventKind.channelCreated);

	await h.connection.start();
	await h.stream.settle();

	return { h, seen };
}

function messageEvent(messageId: string): MessageCreatedEvent {
	return normalizeOne<MessageCreatedEvent>("MESSAGE_CREATE", messageFixture({ id: messageId }));
}

function messageIds(events: readonly NormalizedDiscordEvent[]): string[] {
	return events.map((event) => (event as MessageCreatedEvent).messageId);
}

describe("R6 — the drain delivers what it can inside the window", () => {
	it("delivers every pending event in receipt order and records no gap", async () => {
		const { h, seen } = await started();
		h.emitRaw("MESSAGE_CREATE", messageFixture({ id: "9001" }));
		h.emitRaw("MESSAGE_CREATE", messageFixture({ id: "9002" }));
		h.emitRaw("MESSAGE_CREATE", messageFixture({ id: "9003" }));

		const report = await h.shutdown.shutdown();

		expect(report.drain.delivered).toBe(3);
		expect(report.drain.expired).toBe(false);
		expect(report.drain.undelivered).toEqual([]);
		expect(report.gapDeclared).toBe(false);
		expect(messageIds(seen.ofKind(DiscordEventKind.messageCreated))).toEqual(["9001", "9002", "9003"]);
		expect(h.stream.pendingCount()).toBe(0);
	});

	it("closes the connection it owns and leaves the status disconnected", async () => {
		const { h } = await started();

		const report = await h.shutdown.shutdown();

		expect(report.connectionClosed).toBe(true);
		expect(h.factory.latest().destroyCalls).toBe(1);
		expect(h.factory.liveClients()).toHaveLength(0);
		expect(report.statusAfter).toBe(DiscordConnectionStatus.disconnected);
		expect(h.connection.read().lastDisconnectedInstant).toEqual(h.clock());
	});

	it("reports the drain and flushes the counters to the log before the process leaves", async () => {
		const { h } = await started();
		h.emitRaw("MESSAGE_CREATE", messageFixture({ id: "9004" }));

		await h.shutdown.shutdown();

		const drained = h.logger.messagesMatching("Discord event stream drained").at(-1);
		expect(drained?.fields).toMatchObject({
			guildId: GUILD_ID,
			expired: false,
			delivered: 1,
			undelivered: "none",
			gapDeclared: false
		});

		const flushed = h.logger.messagesMatching("Discord transport counters flushed").at(-1);
		expect(flushed?.fields).toMatchObject({
			guildId: GUILD_ID,
			receivedRawEvents: 1,
			normalizedPerKind: `message-created=1`,
			resyncSignalsPublished: 1
		});
	});

	it("keeps message content out of every shutdown log line", async () => {
		const { h } = await started();
		h.emitRaw("MESSAGE_CREATE", messageFixture({ content: "secret conversation" }));

		await h.shutdown.shutdown();

		expect(h.logger.transcript()).not.toContain("secret conversation");
		expect(h.logger.transcript()).not.toContain("fake.bot.token.value");
	});
});

describe("R6 boundary — an expiring window ends deliberately, with the loss declared", () => {
	it("counts the undelivered events per kind and declares them as a gap", async () => {
		const { h, seen } = await started({ drainWindowMs: 100 });
		seen.hang(DiscordEventKind.messageCreated);
		h.emitRaw("MESSAGE_CREATE", messageFixture({ id: "9011" }));
		h.emitRaw("MESSAGE_CREATE", messageFixture({ id: "9012" }));
		h.emitRaw("MESSAGE_CREATE", messageFixture({ id: "9013" }));
		h.emitRaw("CHANNEL_CREATE", { id: "9101", guild_id: GUILD_ID, type: 0 });

		const report = await h.shutdown.shutdown();

		expect(report.drain.expired).toBe(true);
		expect(report.drain.windowMs).toBe(100);
		expect(report.drain.undelivered).toEqual([
			{ kind: DiscordEventKind.messageCreated, count: 3 },
			{ kind: DiscordEventKind.channelCreated, count: 1 }
		]);
		expect(report.gapDeclared).toBe(true);
		expect(h.counters.snapshot().undeliveredPerKind[DiscordEventKind.messageCreated]).toBe(3);
		expect(h.counters.snapshot().undeliveredPerKind[DiscordEventKind.channelCreated]).toBe(1);
	});

	it("records the gap with the kinds the next signal must name", async () => {
		const { h } = await started({ drainWindowMs: 100 });
		const seen = new DeliveryRecorder(h.stream);
		seen.observe(DiscordEventKind.messageCreated);
		seen.hang(DiscordEventKind.messageCreated);
		h.emitRaw("MESSAGE_CREATE", messageFixture({ id: "9014" }));
		const report = await h.shutdown.shutdown();

		const gaps = h.gaps.pending().filter((gap) => gap.reason === "drain-expiry");
		expect(gaps).toHaveLength(1);
		expect(gaps[0]?.affectedKinds).toEqual([DiscordEventKind.messageCreated]);
		expect(gaps[0]?.undeliveredCount).toBe(1);
		expect(report.gapDeclared).toBe(true);
	});

	it("logs the loss by kind and closes the connection anyway", async () => {
		const { h, seen } = await started({ drainWindowMs: 50 });
		seen.hang(DiscordEventKind.messageCreated);
		h.emitRaw("MESSAGE_CREATE", messageFixture({ id: "9015" }));
		h.emitRaw("MESSAGE_CREATE", messageFixture({ id: "9016" }));

		const report = await h.shutdown.shutdown();

		const loss = h.logger.messagesMatching("Discord event undelivered at shutdown");
		expect(loss).toHaveLength(1);
		expect(loss[0]?.fields).toMatchObject({ kind: DiscordEventKind.messageCreated, count: 2, windowMs: 50 });
		expect(report.connectionClosed).toBe(true);
		expect(h.factory.latest().destroyCalls).toBe(1);
	});

	it("never extends the window: the polls stop at the bound", async () => {
		const { h, seen } = await started({ drainWindowMs: 100 });
		seen.hang(DiscordEventKind.messageCreated);
		h.emitRaw("MESSAGE_CREATE", messageFixture({ id: "9017" }));
		const pollsBefore = h.delays.length;

		const report = await h.shutdown.shutdown();

		const polls = h.delays.slice(pollsBefore);
		const waited = polls.reduce((total, delay) => total + delay, 0);
		expect(report.drain.expired).toBe(true);
		expect(waited).toBeLessThanOrEqual(100 + 25);
	});

	it("refuses, counts and declares an event that arrives after the shutdown began", async () => {
		const { h, seen } = await started();
		await h.shutdown.shutdown();

		h.deliver(messageEvent("9031"));

		expect(h.stream.isAccepting()).toBe(false);
		expect(h.stream.pendingCount()).toBe(0);
		expect(messageIds(seen.ofKind(DiscordEventKind.messageCreated))).not.toContain("9031");
		expect(h.counters.snapshot().undeliveredPerKind[DiscordEventKind.messageCreated]).toBe(1);
		expect(h.gaps.pending().some((gap) => gap.reason === "intake-stopped")).toBe(true);

		const refusal = h.logger.messagesMatching("Discord event refused").at(-1);
		expect(refusal?.fields).toMatchObject({ kind: DiscordEventKind.messageCreated, messageId: "9031" });
	});

	it("stops routing inbound payloads at the connection, so nothing new is normalized", async () => {
		const { h } = await started();
		await h.shutdown.shutdown();

		h.connection.receiveRaw({ eventName: "MESSAGE_CREATE", payload: messageFixture({ id: "9032" }) });

		expect(h.published().filter((event) => event.kind === DiscordEventKind.messageCreated)).toEqual([]);
		expect(h.counters.snapshot().receivedRawEvents).toBe(1);
		expect(h.gaps.pending().some((gap) => gap.reason === "intake-stopped")).toBe(true);
	});
});

describe("R6 — shutdown ends the Installation", () => {
	it("starts no reconnect and publishes no further signal once it began", async () => {
		const { h, seen } = await started();
		await h.shutdown.shutdown();

		h.connection.handleDisconnected({ cause: "network" });
		await h.connection.settle();
		await h.stream.settle();

		expect(seen.signals()).toHaveLength(1);
		expect(h.factory.clients).toHaveLength(1);
		expect(h.factory.totalLoginCalls()).toBe(1);
		expect(h.counters.snapshot().reconnectAttempts).toBe(0);
	});

	it("refuses a second start instead of opening another connection", async () => {
		const { h } = await started();
		await h.shutdown.shutdown();

		await expect(h.connection.start()).rejects.toBeInstanceOf(DiscordConnectionStateError);
		expect(h.factory.clients).toHaveLength(1);
	});

	it("is idempotent for a connection that was already gone", async () => {
		const { h } = await started();
		const first: DiscordShutdownReport = await h.shutdown.shutdown();
		const second = await h.shutdown.shutdown();

		expect(first.connectionClosed).toBe(true);
		expect(second.connectionClosed).toBe(true);
		expect(second.drain.delivered).toBe(0);
		expect(h.factory.latest().destroyCalls).toBe(1);
	});
});

describe("R6 error — a connection that will not close cleanly never blocks shutdown", () => {
	it("logs the refused closure and still delivers and reports", async () => {
		const { h, seen } = await started();
		h.emitRaw("MESSAGE_CREATE", messageFixture({ id: "9021" }));
		await h.stream.settle();
		h.factory.latest().destroyThrows = true;

		const report = await h.shutdown.shutdown();

		expect(report.connectionClosed).toBe(false);
		expect(report.closureReason).toBe("Error");
		expect(report.drain.delivered).toBeGreaterThanOrEqual(0);
		expect(report.statusAfter).toBe(DiscordConnectionStatus.disconnected);
		expect(h.logger.messagesMatching("Discord connection did not close cleanly")).toHaveLength(1);
		expect(h.logger.messagesMatching("Discord event stream drained")).toHaveLength(1);
		expect(seen.signals()).toHaveLength(1);
	});
});

describe("R6 through R5 — the next start covers the declared gap", () => {
	it("declares the loss now and leaves an unscoped signal for the process that follows", async () => {
		const { h, seen } = await started({ drainWindowMs: 50 });
		seen.hang(DiscordEventKind.messageCreated);
		h.emitRaw("MESSAGE_CREATE", messageFixture({ id: "9022" }));
		h.emitRaw("CHANNEL_CREATE", { id: "9109", guild_id: GUILD_ID, type: 0 });

		const report = await h.shutdown.shutdown();

		// The gap this shutdown leaves behind is recorded with its kinds...
		const pending = h.gaps.pending().filter((gap) => gap.reason === "drain-expiry");
		expect(pending).toHaveLength(1);
		expect(pending[0]?.affectedKinds).toEqual([DiscordEventKind.messageCreated, DiscordEventKind.channelCreated]);
		expect(report.gapDeclared).toBe(true);

		// ...and a fresh process declares the interval by publishing its first unscoped signal (R5).
		const nextStart = composeInstallation();
		const nextSeen = new DeliveryRecorder(nextStart.stream);
		nextSeen.observe(DiscordEventKind.resyncNeeded);
		await nextStart.connection.start();
		await nextStart.stream.settle();

		expect(nextSeen.signals()).toHaveLength(1);
		expect(nextSeen.signals()[0]?.epoch).toBe(1);
		expect(nextSeen.signals()[0]?.affectedKinds).toBeUndefined();
		expect(nextStart.counters.snapshot().undeliveredPerKind[DiscordEventKind.messageCreated]).toBe(0);
	});
});
