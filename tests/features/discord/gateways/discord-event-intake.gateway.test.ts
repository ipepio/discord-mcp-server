import { describe, expect, it } from "vitest";
import { DiscordEventIntakeGateway } from "../../../../src/features/discord/gateways/discord-event-intake.gateway.js";
import { DiscordConnectionGateway } from "../../../../src/features/discord/gateways/discord-connection.gateway.js";
import { DiscordEventKind } from "../../../../src/features/discord/models/domain/discord-event-kind.enum.js";
import { DiscordDeclaredGaps } from "../../../../src/features/discord/models/domain/discord-declared-gaps.js";
import { DiscordTransportCounters } from "../../../../src/features/discord/models/domain/discord-transport-counters.js";
import { DEFAULT_RECONNECT_BACKOFF } from "../../../../src/features/discord/models/domain/reconnect-backoff.js";
import type { RawDiscordEvent } from "../../../../src/features/discord/gateways/discord.gateway.interface.js";
import {
	FakeDiscordGatewayClientFactory,
	fakeClock,
	fakeConfig,
	fakeWait,
	RecordingConnectionObserver,
	RecordingProducer
} from "../fakes/fake-discord-gateway-client.js";
import { RecordingLogger } from "../fakes/recording-logger.js";
import { FOREIGN_GUILD_ID, GUILD_ID } from "../fakes/normalize.js";

/**
 * R2 and R3 at the intake: the source Guild filter runs before normalization, an unknown raw kind is
 * counted and logged by its raw name, and a malformed payload is rejected and counted per kind. In all
 * three cases nothing is published and no field is invented.
 */

const MESSAGE_CREATED = {
	id: "500",
	channel_id: "400",
	guild_id: GUILD_ID,
	author: { id: "300", username: "someone", bot: false },
	content: "hello there",
	timestamp: "2026-11-05T10:00:00.000Z",
	type: 0
};

interface Intake {
	readonly intake: DiscordEventIntakeGateway;
	readonly producer: RecordingProducer;
	readonly counters: DiscordTransportCounters;
	readonly logger: RecordingLogger;
}

function intake(): Intake {
	const producer = new RecordingProducer();
	const counters = new DiscordTransportCounters();
	const logger = new RecordingLogger();

	return {
		producer,
		counters,
		logger,
		intake: new DiscordEventIntakeGateway({
			configuredGuildId: GUILD_ID,
			producer,
			counters,
			logger
		})
	};
}

function handle(h: Intake, eventName: string, payload: unknown): void {
	h.intake.handle({ eventName, payload } satisfies RawDiscordEvent);
}

describe("R2 — the source Guild filter runs before normalization", () => {
	it("publishes an event of the configured Guild", () => {
		const h = intake();
		handle(h, "MESSAGE_CREATE", MESSAGE_CREATED);

		expect(h.producer.kinds()).toEqual([DiscordEventKind.messageCreated]);
		expect(h.counters.snapshot().normalizedPerKind[DiscordEventKind.messageCreated]).toBe(1);
	});

	it("drops an event of another Guild, counts it and publishes nothing", () => {
		const h = intake();
		handle(h, "MESSAGE_CREATE", { ...MESSAGE_CREATED, guild_id: FOREIGN_GUILD_ID });

		expect(h.producer.published).toEqual([]);
		expect(h.counters.snapshot().droppedAsForeignGuild).toBe(1);
		expect(h.counters.snapshot().droppedForeignGuildIds).toEqual([FOREIGN_GUILD_ID]);
		expect(h.counters.snapshot().normalizedPerKind[DiscordEventKind.messageCreated]).toBe(0);
	});

	it("names the foreign Guild and the raw event in the anomaly log, never the content", () => {
		const h = intake();
		handle(h, "MESSAGE_CREATE", { ...MESSAGE_CREATED, guild_id: FOREIGN_GUILD_ID });

		const line = h.logger.lines.at(-1);
		expect(line?.message).toBe("Discord event dropped by the source Guild filter");
		expect(line?.fields).toEqual({ reason: "foreign", rawEventName: "MESSAGE_CREATE", guildId: FOREIGN_GUILD_ID });
		expect(h.logger.transcript()).not.toContain("hello there");
	});

	it("drops a Guild-less payload, counts it and publishes nothing", () => {
		const h = intake();
		handle(h, "MESSAGE_CREATE", { ...MESSAGE_CREATED, guild_id: undefined });
		handle(h, "CHANNEL_CREATE", { id: "401", type: 0 });

		expect(h.producer.published).toEqual([]);
		expect(h.counters.snapshot().droppedGuildLess).toBe(2);
		expect(h.counters.snapshot().droppedAsForeignGuild).toBe(0);

		const line = h.logger.lines.at(-1);
		expect(line?.fields).toEqual({ reason: "guild-less", rawEventName: "CHANNEL_CREATE" });
	});

	it("counts a direct-message payload without a Guild as an anomaly, not as a foreign Guild", () => {
		const h = intake();
		handle(h, "MESSAGE_CREATE", {
			id: "500",
			channel_id: "400",
			type: 0,
			content: "",
			timestamp: "2026-11-05T10:00:00.000Z",
			author: { id: "300" }
		});

		expect(h.counters.snapshot().droppedGuildLess).toBe(1);
	});

	it("forwards an event of the configured Guild about a resource this Installation has not stored", () => {
		const h = intake();
		handle(h, "CHANNEL_CREATE", { id: "999", guild_id: GUILD_ID, type: 0, name: "created-while-down" });

		expect(h.producer.kinds()).toEqual([DiscordEventKind.channelCreated]);
	});

	it("rejects a Guild id that is not a snowflake instead of comparing it to the configured one", () => {
		const h = intake();
		handle(h, "MESSAGE_CREATE", { ...MESSAGE_CREATED, guild_id: "0111111111111111111" });

		expect(h.producer.published).toEqual([]);
		expect(h.counters.snapshot().droppedGuildLess).toBe(1);
	});
});

describe("R3 — unknown kinds and malformed payloads", () => {
	it("counts an unknown raw kind by its raw name and publishes nothing", () => {
		const h = intake();
		handle(h, "SOME_NEW_DISCORD_EVENT", { id: "500", guild_id: GUILD_ID });

		expect(h.producer.published).toEqual([]);
		expect(h.counters.snapshot().unknownKindByRawName).toEqual({ SOME_NEW_DISCORD_EVENT: 1 });

		const line = h.logger.lines.at(-1);
		expect(line?.message).toBe("Unknown Discord event kind");
		expect(line?.fields).toEqual({ rawEventName: "SOME_NEW_DISCORD_EVENT" });
	});

	it("counts THREAD_MEMBER_LIST_SYNC as unknown rather than inventing membership additions", () => {
		const h = intake();
		handle(h, "THREAD_MEMBER_LIST_SYNC", { id: "410", guild_id: GUILD_ID, member_ids: ["300"] });

		expect(h.producer.published).toEqual([]);
		expect(h.counters.snapshot().unknownKindByRawName).toEqual({ THREAD_MEMBER_LIST_SYNC: 1 });
	});

	it("counts each unknown raw name separately", () => {
		const h = intake();
		handle(h, "EVENT_A", { guild_id: GUILD_ID });
		handle(h, "EVENT_A", { guild_id: GUILD_ID });
		handle(h, "EVENT_B", { guild_id: GUILD_ID });

		expect(h.counters.snapshot().unknownKindByRawName).toEqual({ EVENT_A: 2, EVENT_B: 1 });
	});

	it("rejects a malformed payload, counts it per kind and publishes nothing", () => {
		const h = intake();
		handle(h, "MESSAGE_CREATE", { ...MESSAGE_CREATED, channel_id: undefined });

		expect(h.producer.published).toEqual([]);
		expect(h.counters.snapshot().rejectedPayloadPerKind[DiscordEventKind.messageCreated]).toBe(1);
		expect(h.counters.snapshot().normalizedPerKind[DiscordEventKind.messageCreated]).toBe(0);
	});

	it("reports the failing field path and never the offending value", () => {
		const h = intake();
		handle(h, "MESSAGE_CREATE", { ...MESSAGE_CREATED, content: "secret conversation", id: "bad-snowflake" });

		const line = h.logger.lines.at(-1);
		expect(line?.message).toBe("Discord payload rejected by normalization");
		expect(line?.fields).toMatchObject({
			kind: DiscordEventKind.messageCreated,
			rawEventName: "MESSAGE_CREATE",
			fieldPath: "id",
			guildId: GUILD_ID
		});
		expect(h.logger.transcript()).not.toContain("secret conversation");
	});

	it("keeps counting other kinds after a rejection: one bad payload never stops the intake", () => {
		const h = intake();
		handle(h, "MESSAGE_CREATE", { ...MESSAGE_CREATED, id: "nope" });
		handle(h, "MESSAGE_CREATE", MESSAGE_CREATED);
		handle(h, "GUILD_ROLE_DELETE", { guild_id: GUILD_ID, role_id: "200" });

		expect(h.producer.kinds()).toEqual([DiscordEventKind.messageCreated, DiscordEventKind.roleDeleted]);
		expect(h.counters.snapshot().rejectedPayloadPerKind[DiscordEventKind.messageCreated]).toBe(1);
	});

	it("rejects a payload that is not an object at all instead of publishing an empty event", () => {
		const h = intake();
		handle(h, "MESSAGE_CREATE", "text");

		expect(h.producer.published).toEqual([]);
		expect(h.counters.snapshot().rejectedPayloadPerKind[DiscordEventKind.messageCreated]).toBe(0);
		expect(h.counters.snapshot().droppedGuildLess).toBe(1);
	});
});

describe("R2 through the connection — the filter is the first thing a raw payload meets", () => {
	async function connected(): Promise<{
		readonly factory: FakeDiscordGatewayClientFactory;
		readonly producer: RecordingProducer;
		readonly counters: DiscordTransportCounters;
		readonly connection: DiscordConnectionGateway;
	}> {
		const factory = new FakeDiscordGatewayClientFactory();
		const producer = new RecordingProducer();
		const counters = new DiscordTransportCounters();
		const logger = new RecordingLogger();
		const intakeGateway = new DiscordEventIntakeGateway({
			configuredGuildId: GUILD_ID,
			producer,
			counters,
			logger
		});
		const connection = new DiscordConnectionGateway({
			config: fakeConfig({ guildId: GUILD_ID }),
			clientFactory: factory,
			onRawEvent: (event: RawDiscordEvent) => intakeGateway.handle(event),
			observer: new RecordingConnectionObserver(),
			counters,
			gaps: new DiscordDeclaredGaps(),
			logger,
			clock: fakeClock().clock,
			wait: fakeWait().wait,
			backoff: DEFAULT_RECONNECT_BACKOFF
		});

		await connection.start();

		return { factory, producer, counters, connection };
	}

	it("normalizes and publishes only the configured Guild's events", async () => {
		const h = await connected();

		h.factory.emitRaw("MESSAGE_CREATE", { ...MESSAGE_CREATED, guild_id: FOREIGN_GUILD_ID });
		h.factory.emitRaw("MESSAGE_CREATE", MESSAGE_CREATED);

		expect(h.producer.kinds()).toEqual([DiscordEventKind.messageCreated]);
		expect(h.counters.snapshot().droppedAsForeignGuild).toBe(1);
		expect(h.counters.snapshot().normalizedPerKind[DiscordEventKind.messageCreated]).toBe(1);
		expect(h.counters.snapshot().receivedRawEvents).toBe(2);
	});
});
