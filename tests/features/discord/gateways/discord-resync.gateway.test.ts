import { describe, expect, it } from "vitest";
import { DiscordConnectionStatus } from "../../../../src/features/discord/models/domain/discord-connection-status.js";
import { DiscordEventKind } from "../../../../src/features/discord/models/domain/discord-event-kind.enum.js";
import { DeliveryRecorder } from "../fakes/delivery-recorder.js";
import type { InstallationOptions } from "../fakes/composed-installation.js";
import { FAST_BACKOFF, composeInstallation, messageFixture } from "../fakes/composed-installation.js";
import { GUILD_ID } from "../fakes/normalize.js";

/**
 * R5 — reconnection signaling. Every transition into a connected state produces exactly one
 * `resync-needed` signal, including the very first one after process start; no signal appears while the
 * connection is unusable; a resume that succeeds does not mask the gap; and a loop of failed attempts is
 * summarized by the single signal of the transition that finally worked, with its attempt count.
 */

interface Watched {
	readonly seen: DeliveryRecorder;
	readonly h: ReturnType<typeof composeInstallation>;
}

async function connected(options: InstallationOptions = {}): Promise<Watched> {
	const h = composeInstallation(options);
	const seen = new DeliveryRecorder(h.stream);
	seen.observe(DiscordEventKind.resyncNeeded);
	seen.observe(DiscordEventKind.messageCreated);

	await h.connection.start();
	await h.stream.settle();

	return { h, seen };
}

describe("R5 — one signal per transition into a connected state", () => {
	it("publishes the first signal on the connection made at startup, scoped to nothing", async () => {
		const { seen, h } = await connected();
		const signals = seen.signals();

		expect(signals).toHaveLength(1);
		expect(signals[0]).toMatchObject({
			kind: DiscordEventKind.resyncNeeded,
			guildId: GUILD_ID,
			epoch: 1,
			reconnectAttempts: 0
		});
		// R3/R5: the process cannot know what changed while it was down, so nothing is narrowed.
		expect(signals[0]?.affectedKinds).toBeUndefined();
		expect(h.counters.snapshot().resyncSignalsPublished).toBe(1);
	});

	it("names no last delivered instant when nothing was ever delivered", async () => {
		const { seen } = await connected();

		expect(seen.signals()[0]?.lastDeliveredInstant).toBeUndefined();
	});

	it("publishes one signal for a connection regained by a successful resume", async () => {
		const { h, seen } = await connected();

		h.emitDisconnect();
		await h.connection.settle();
		await h.stream.settle();

		const signals = seen.signals();
		expect(signals).toHaveLength(2);
		expect(signals[1]).toMatchObject({ epoch: 2, reconnectAttempts: 1 });
		expect(h.counters.snapshot().resyncSignalsPublished).toBe(2);
	});

	it("publishes one signal for the fresh identify that follows a rejected resume", async () => {
		const { h, seen } = await connected({ resume: [{ kind: "rejected", reason: "session expired" }] });

		h.emitDisconnect();
		await h.connection.settle();
		await h.stream.settle();

		expect(seen.signals()).toHaveLength(2);
		expect(seen.signals()[1]).toMatchObject({ epoch: 2, reconnectAttempts: 1 });
		expect(h.factory.clients).toHaveLength(2);
	});

	it("summarizes a loop of failed attempts into one signal carrying the attempt count", async () => {
		const { h, seen } = await connected({
			backoff: FAST_BACKOFF,
			resume: [{ kind: "rejected", reason: "session expired" }],
			login: [
				{ kind: "accept" },
				{ kind: "reject", cause: "unreachable" },
				{ kind: "reject", cause: "unreachable" },
				{ kind: "accept" }
			]
		});

		h.emitDisconnect();
		await h.connection.settle();
		await h.stream.settle();

		const signals = seen.signals();
		expect(signals).toHaveLength(2);
		expect(signals[1]?.reconnectAttempts).toBe(3);
		expect(h.counters.snapshot().resyncSignalsPublished).toBe(2);
	});

	it("does not publish a signal per failed attempt", async () => {
		const { h, seen } = await connected({
			backoff: FAST_BACKOFF,
			resume: [{ kind: "rejected", reason: "session expired" }],
			login: [
				{ kind: "accept" },
				{ kind: "reject", cause: "unreachable" },
				{ kind: "reject", cause: "unreachable" },
				{ kind: "reject", cause: "unreachable" },
				{ kind: "accept" }
			]
		});

		h.emitDisconnect();
		await h.connection.settle();
		await h.stream.settle();

		expect(seen.signals()).toHaveLength(2);
		expect(seen.signals()[1]?.reconnectAttempts).toBe(4);
	});

	it("publishes a further signal for the next transition after a connection that dies immediately", async () => {
		const { h, seen } = await connected();

		h.emitDisconnect();
		await h.connection.settle();
		await h.stream.settle();

		h.emitDisconnect();
		await h.connection.settle();
		await h.stream.settle();

		expect(seen.signals().map((signal) => signal.epoch)).toEqual([1, 2, 3]);
	});
});

describe("R5 error — no signal while the connection is not usable", () => {
	it("publishes nothing when the process never opened a connection", async () => {
		const h = composeInstallation();

		expect(h.published().filter((event) => event.kind === DiscordEventKind.resyncNeeded)).toEqual([]);
		expect(h.counters.snapshot().resyncSignalsPublished).toBe(0);
		expect(h.connection.read().status).toBe(DiscordConnectionStatus.disconnected);
	});

	it("publishes nothing and reports unavailable when the login is refused at startup", async () => {
		const h = composeInstallation({ login: [{ kind: "reject", cause: "invalid-token" }] });
		const seen = new DeliveryRecorder(h.stream);
		seen.observe(DiscordEventKind.resyncNeeded);

		await expect(h.connection.start()).rejects.toThrow();
		await h.stream.settle();

		expect(seen.signals()).toEqual([]);
		expect(h.counters.snapshot().resyncSignalsPublished).toBe(0);
		expect(h.connection.read().status).toBe(DiscordConnectionStatus.unavailable);
	});

	it("publishes nothing when the connection does not hold the configured Guild", async () => {
		const h = composeInstallation({ heldGuildIds: ["222222222222222222"] });

		await h.connection.start();
		await h.stream.settle();

		expect(h.published().filter((event) => event.kind === DiscordEventKind.resyncNeeded)).toEqual([]);
		expect(h.gaps.pending()).toHaveLength(0);
	});
});

describe("R5 — a gap is never masked", () => {
	it("a successful resume still publishes the signal, with the disconnected interval inside it", async () => {
		const { h, seen } = await connected();

		h.emitDisconnect();
		// The payloads that arrive while the session is down are declared, never buffered (R4 boundary).
		h.emitRaw("MESSAGE_CREATE", messageFixture({ id: "900" }));
		expect(h.published().map((event) => event.kind)).toEqual([DiscordEventKind.resyncNeeded]);

		await h.connection.settle();
		await h.stream.settle();

		const signals = seen.signals();
		expect(signals).toHaveLength(2);
		// Unscoped: the consumer resynchronizes everything, because the transport cannot name what it missed.
		expect(signals[1]?.affectedKinds).toBeUndefined();
		expect(h.gaps.pending()).toHaveLength(0);
	});

	it("names the instant of the last event delivered before the gap", async () => {
		const { h, seen } = await connected();

		h.advance(2_000);
		h.emitRaw("MESSAGE_CREATE", messageFixture({ id: "901" }));
		await h.stream.settle();
		const deliveredBeforeGap = h.stream.lastDeliveredInstant();
		expect(deliveredBeforeGap).toEqual(new Date(new Date("2026-11-05T12:00:02.000Z").getTime()));

		h.advance(30_000);
		h.emitDisconnect();
		await h.connection.settle();
		await h.stream.settle();

		expect(seen.signals()[1]?.lastDeliveredInstant).toEqual(deliveredBeforeGap);
	});

	it("keeps the kinds of a narrowed gap for the next transition when nothing can announce them live", async () => {
		const h = composeInstallation();
		const seen = new DeliveryRecorder(h.stream);
		seen.observe(DiscordEventKind.resyncNeeded);

		h.resync.declareDroppedDelivery({
			reason: "dropped-delivery",
			kinds: [DiscordEventKind.messageCreated],
			count: 4
		});
		expect(seen.signals()).toEqual([]);
		expect(h.gaps.pending()).toHaveLength(1);

		await h.connection.start();
		await h.stream.settle();

		expect(seen.signals()).toHaveLength(1);
		expect(seen.signals()[0]?.affectedKinds).toEqual([DiscordEventKind.messageCreated]);
	});
});

describe("R4 hardening through R5 — no drop is ever silent", () => {
	it("announces a failed delivery at once, naming the affected kind", async () => {
		const { h, seen } = await connected();
		seen.fail(DiscordEventKind.messageCreated);

		h.emitRaw("MESSAGE_CREATE", messageFixture({ id: "902" }));
		await h.stream.settle();

		const signals = seen.signals();
		expect(signals).toHaveLength(2);
		expect(signals[1]).toMatchObject({
			epoch: 1,
			affectedKinds: [DiscordEventKind.messageCreated]
		});
		expect(h.counters.snapshot().deliveryFailuresPerKind[DiscordEventKind.messageCreated]).toBe(1);
		// Announced: the ledger keeps nothing back, so the next transition is not polluted by it.
		expect(h.gaps.pending()).toHaveLength(0);
	});

	it("never announces the signal kind itself, so a failing resync handler cannot loop", async () => {
		const h = composeInstallation();
		const seen = new DeliveryRecorder(h.stream);
		seen.observe(DiscordEventKind.resyncNeeded);
		seen.fail(DiscordEventKind.resyncNeeded);

		await h.connection.start();
		await h.stream.settle();

		expect(seen.signals()).toHaveLength(1);
		expect(h.counters.snapshot().deliveryFailuresPerKind[DiscordEventKind.resyncNeeded]).toBe(1);
		expect(h.gaps.pending()).toHaveLength(1);
		expect(h.gaps.pending()[0]?.reason).toBe("dropped-delivery");
	});

	it("delivers the signal in order with the events that follow the reconnect", async () => {
		const { h, seen } = await connected();

		h.emitDisconnect();
		await h.connection.settle();
		h.emitRaw("MESSAGE_CREATE", messageFixture({ id: "903" }));
		await h.stream.settle();

		expect(seen.kinds()).toEqual([
			DiscordEventKind.resyncNeeded,
			DiscordEventKind.resyncNeeded,
			DiscordEventKind.messageCreated
		]);
	});

	it("keeps message content out of every signaling log line", async () => {
		const { h, seen } = await connected();
		seen.fail(DiscordEventKind.messageCreated);

		h.emitRaw("MESSAGE_CREATE", messageFixture({ content: "secret conversation" }));
		await h.stream.settle();

		expect(seen.signals()).toHaveLength(2);
		expect(h.logger.transcript()).not.toContain("secret conversation");
	});
});
