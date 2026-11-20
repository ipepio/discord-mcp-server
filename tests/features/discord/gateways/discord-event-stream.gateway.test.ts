import { describe, expect, it } from "vitest";
import { DiscordEventStreamGateway } from "../../../../src/features/discord/gateways/discord-event-stream.gateway.js";
import type { DiscordEventStreamDependencies } from "../../../../src/features/discord/gateways/discord-event-stream.gateway.js";
import { DiscordEventKind } from "../../../../src/features/discord/models/domain/discord-event-kind.enum.js";
import type {
	DiscordEventHandler,
	DroppedDelivery
} from "../../../../src/features/discord/models/domain/discord-event-stream.interface.js";
import type {
	MessageCreatedEvent,
	NormalizedDiscordEvent
} from "../../../../src/features/discord/models/domain/normalized-discord-event.js";
import { DiscordTransportCounters } from "../../../../src/features/discord/models/domain/discord-transport-counters.js";
import { fakeClock, fakeWait } from "../fakes/fake-discord-gateway-client.js";
import { messageFixture } from "../fakes/composed-installation.js";
import { GUILD_ID, normalizeOne } from "../fakes/normalize.js";
import { RecordingLogger } from "../fakes/recording-logger.js";

/**
 * R4 — delivery of the normalized stream: at-least-once, in receipt order, one handler failure isolated
 * without stopping the other handlers, the later events or the connection, and never retried here. Every
 * case asserts through a real subscription, because "the consumer received it twice, in order" is the
 * promise being tested — not an internal queue shape.
 */

interface Harness {
	readonly stream: DiscordEventStreamGateway;
	readonly counters: DiscordTransportCounters;
	readonly logger: RecordingLogger;
	readonly drops: DroppedDelivery[];
	readonly clock: () => Date;
	readonly advance: (milliseconds: number) => void;
	readonly observe: (kind: DiscordEventKind, handler: DiscordEventHandler) => void;
	readonly received: NormalizedDiscordEvent[];
}

function harness(): Harness {
	const counters = new DiscordTransportCounters();
	const logger = new RecordingLogger();
	const timing = fakeClock();
	const drops: DroppedDelivery[] = [];
	const received: NormalizedDiscordEvent[] = [];

	const deps: DiscordEventStreamDependencies = {
		counters,
		logger,
		clock: timing.clock,
		wait: fakeWait().wait,
		onDroppedDelivery: { declareDroppedDelivery: (drop) => void drops.push(drop) }
	};

	const stream = new DiscordEventStreamGateway(deps);

	return {
		stream,
		counters,
		logger,
		drops,
		received,
		clock: timing.clock,
		advance: timing.advance,
		observe: (kind, handler) => {
			const recording: DiscordEventHandler = async (event) => {
				received.push(event);
				await handler(event);
			};

			stream.subscribe(kind, recording);
		}
	};
}

function messageEvent(messageId: string): MessageCreatedEvent {
	return normalizeOne<MessageCreatedEvent>("MESSAGE_CREATE", messageFixture({ id: messageId }));
}

function roleEvent(roleId: string): NormalizedDiscordEvent {
	return normalizeOne("GUILD_ROLE_CREATE", {
		guild_id: GUILD_ID,
		role: { id: roleId, name: `role-${roleId}` }
	});
}

describe("R4 — delivery is at-least-once, in receipt order", () => {
	it("delivers every published event, in the order the stream received them", async () => {
		const h = harness();
		h.observe(DiscordEventKind.messageCreated, () => undefined);

		h.stream.publish(messageEvent("1"));
		h.stream.publish(messageEvent("2"));
		h.stream.publish(messageEvent("1"));
		await h.stream.settle();

		const ids = (h.received as MessageCreatedEvent[]).map((event) => event.messageId);
		expect(ids).toEqual(["1", "2", "1"]);
	});

	it("delivers a duplicate twice instead of deduplicating it: convergence is the consumer's", async () => {
		const h = harness();
		h.observe(DiscordEventKind.messageCreated, () => undefined);
		const same = messageEvent("7");

		h.stream.publish(same);
		h.stream.publish(same);
		await h.stream.settle();

		expect(h.received).toHaveLength(2);
		expect(h.received[0]).toBe(same);
		expect(h.received[1]).toBe(same);
	});

	it("hands an event only to the handlers registered for its kind", async () => {
		const h = harness();
		const messageHandler = (event: NormalizedDiscordEvent): void => {
			h.received.push(event);
		};

		h.stream.subscribe(DiscordEventKind.messageCreated, messageHandler);
		h.stream.subscribe(DiscordEventKind.roleCreated, (event) => {
			h.received.push(event);
		});

		h.stream.publish(messageEvent("1"));
		h.stream.publish(roleEvent("200"));
		await h.stream.settle();

		expect(h.received.map((event) => event.kind)).toEqual([
			DiscordEventKind.messageCreated,
			DiscordEventKind.roleCreated
		]);
	});

	it("waits for an asynchronous handler before delivering the next event", async () => {
		const h = harness();
		const trace: string[] = [];
		let release = (): void => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		h.stream.subscribe(DiscordEventKind.messageCreated, async (event) => {
			trace.push(`start:${event.messageId}`);
			await gate;
			trace.push(`end:${event.messageId}`);
		});

		h.stream.publish(messageEvent("1"));
		h.stream.publish(messageEvent("2"));
		await Promise.resolve();
		expect(trace).toEqual(["start:1"]);

		release();
		await h.stream.settle();
		expect(trace).toEqual(["start:1", "end:1", "start:2", "end:2"]);
	});

	it("an unsubscribe stops later deliveries and leaves the other handlers running", async () => {
		const h = harness();
		const kept: NormalizedDiscordEvent[] = [];
		h.stream.subscribe(DiscordEventKind.messageCreated, (event) => {
			kept.push(event);
		});
		const removed = h.stream.subscribe(DiscordEventKind.messageCreated, (event) => {
			kept.push(event);
		});

		removed.unsubscribe();
		h.stream.publish(messageEvent("1"));
		await h.stream.settle();

		expect(kept).toHaveLength(1);
	});
});

describe("R4 error — a throwing consumer handler is isolated", () => {
	it("still delivers to the other handler of the same kind", async () => {
		const h = harness();
		const survivor: NormalizedDiscordEvent[] = [];

		h.stream.subscribe(DiscordEventKind.messageCreated, () => {
			throw new Error("consumer write failed");
		});
		h.stream.subscribe(DiscordEventKind.messageCreated, (event) => {
			survivor.push(event);
		});

		h.stream.publish(messageEvent("1"));
		await h.stream.settle();

		expect(survivor).toHaveLength(1);
	});

	it("still delivers the later events and the other kinds", async () => {
		const h = harness();
		h.observe(DiscordEventKind.messageCreated, () => {
			throw new Error("consumer write failed");
		});
		h.observe(DiscordEventKind.roleCreated, () => undefined);

		h.stream.publish(messageEvent("1"));
		h.stream.publish(messageEvent("2"));
		h.stream.publish(roleEvent("200"));
		await h.stream.settle();

		expect(h.received.map((event) => event.kind)).toEqual([
			DiscordEventKind.messageCreated,
			DiscordEventKind.messageCreated,
			DiscordEventKind.roleCreated
		]);
		expect(h.counters.snapshot().deliveryFailuresPerKind[DiscordEventKind.messageCreated]).toBe(2);
		expect(h.counters.snapshot().deliveryFailuresPerKind[DiscordEventKind.roleCreated]).toBe(0);
	});

	it("does not retry the failing delivery: the handler is called exactly once", async () => {
		const h = harness();
		let attempts = 0;

		h.stream.subscribe(DiscordEventKind.messageCreated, () => {
			attempts += 1;
			throw new Error(`consumer write failed on attempt ${attempts}`);
		});

		h.stream.publish(messageEvent("1"));
		await h.stream.settle();
		await h.stream.settle();

		expect(attempts).toBe(1);
	});

	it("logs the failure with ids and kind, never with content or the consumer's message", async () => {
		const h = harness();
		h.observe(DiscordEventKind.messageCreated, () => {
			throw new Error("insert into messages failed on row 'hello there'");
		});

		h.stream.publish(messageEvent("1"));
		await h.stream.settle();

		const line = h.logger.messagesMatching("Discord event delivery failed").at(-1);
		expect(line?.fields).toMatchObject({
			kind: DiscordEventKind.messageCreated,
			messageId: "1",
			channelId: "400",
			guildId: "111111111111111111",
			reason: "Error"
		});
		expect(h.logger.transcript()).not.toContain("hello there");
		expect(h.logger.transcript()).not.toContain("insert into messages failed");
	});

	it("declares the drop with its kind, so no drop is ever silent (R4 hardening)", async () => {
		const h = harness();
		h.observe(DiscordEventKind.messageCreated, () => {
			throw new Error("consumer write failed");
		});

		h.stream.publish(messageEvent("1"));
		await h.stream.settle();

		expect(h.drops).toHaveLength(1);
		expect(h.drops[0]).toMatchObject({
			reason: "dropped-delivery",
			kinds: [DiscordEventKind.messageCreated],
			count: 1
		});
		expect(h.drops[0]?.ids).toMatchObject({ messageId: "1", channelId: "400" });
	});

	it("keeps every event accounted for: delivered or declared, never silently dropped", async () => {
		const h = harness();
		h.observe(DiscordEventKind.messageCreated, () => undefined);
		h.observe(DiscordEventKind.roleCreated, () => {
			throw new Error("consumer write failed");
		});

		h.stream.publish(messageEvent("1"));
		h.stream.publish(roleEvent("200"));
		await h.stream.settle();

		expect(h.received).toHaveLength(2);
		expect(h.stream.deliveredCount()).toBe(2);
		expect(h.drops).toHaveLength(1);
		expect(h.stream.pendingCount()).toBe(0);
	});
});

describe("R4 delivery facts the resync signal needs", () => {
	it("records the instant of the last delivered event, and none before the first", async () => {
		const h = harness();
		h.observe(DiscordEventKind.messageCreated, () => undefined);
		expect(h.stream.lastDeliveredInstant()).toBeUndefined();

		h.advance(1_500);
		h.stream.publish(messageEvent("1"));
		await h.stream.settle();

		expect(h.stream.lastDeliveredInstant()).toEqual(h.clock());
	});

	it("never lets its own signal become the last delivered event", async () => {
		const h = harness();
		h.observe(DiscordEventKind.messageCreated, () => undefined);

		h.stream.publish(messageEvent("1"));
		await h.stream.settle();
		const delivered = h.stream.lastDeliveredInstant();

		h.advance(10_000);
		h.stream.publish({
			kind: DiscordEventKind.resyncNeeded,
			guildId: "111111111111111111",
			epoch: 2,
			reconnectAttempts: 1
		});
		await h.stream.settle();

		expect(h.stream.lastDeliveredInstant()).toEqual(delivered);
	});
});
