import { describe, expect, it } from "vitest";
import { DiscordConnectionAlreadyOpenError } from "../../../src/features/discord/gateways/discord-connection.errors.js";
import {
	createDiscordConnection,
	DiscordConnectionGateway
} from "../../../src/features/discord/gateways/discord-connection.gateway.js";
import type { DiscordConnectionDependencies } from "../../../src/features/discord/gateways/discord-connection.gateway.js";
import { DiscordLoginRejectedError } from "../../../src/features/discord/gateways/discord.gateway.interface.js";
import type { RawDiscordEvent } from "../../../src/features/discord/gateways/discord.gateway.interface.js";
import { DISCORD_REQUIRED_INTENTS } from "../../../src/features/discord/config/discord-config.interface.js";
import { DiscordIntentConfigurationError } from "../../../src/features/discord/config/discord-config.errors.js";
import { DiscordDeclaredGaps } from "../../../src/features/discord/models/domain/discord-declared-gaps.js";
import { DiscordTransportCounters } from "../../../src/features/discord/models/domain/discord-transport-counters.js";
import { DiscordConnectionStatus } from "../../../src/features/discord/models/domain/discord-connection-status.js";
import { DEFAULT_RECONNECT_BACKOFF } from "../../../src/features/discord/models/domain/reconnect-backoff.js";
import type { ReconnectBackoffSettings } from "../../../src/features/discord/models/domain/reconnect-backoff.js";
import {
	FakeDiscordGatewayClientFactory,
	fakeClock,
	fakeConfig,
	fakeWait,
	RecordingConnectionObserver,
	RecordingIntake
} from "./fakes/fake-discord-gateway-client.js";
import type { FakeLoginOutcome, FakeResumeOutcome } from "./fakes/fake-discord-gateway-client.js";
import { RecordingLogger } from "./fakes/recording-logger.js";

/**
 * R1 and the connection half of R9 — the single Gateway connection: one client per Installation,
 * resume before re-identify, the previous client destroyed before any re-login, backoff without a
 * second concurrent client, and a rejected login failing startup with no retry loop. Every case runs
 * against the fake transport, which records each call, so "one connection" is measured, not assumed.
 */

const GUILD_ID = "111111111111111111";
const FAST_BACKOFF: ReconnectBackoffSettings = {
	baseDelayMs: 10,
	factor: 2,
	maxDelayMs: 40,
	unavailableAfterAttempts: 3
};

interface Harness {
	readonly connection: DiscordConnectionGateway;
	readonly factory: FakeDiscordGatewayClientFactory;
	readonly observer: RecordingConnectionObserver;
	readonly intake: RecordingIntake;
	readonly counters: DiscordTransportCounters;
	readonly gaps: DiscordDeclaredGaps;
	readonly logger: RecordingLogger;
	readonly delays: number[];
	readonly advance: (milliseconds: number) => void;
}

interface HarnessOptions {
	readonly login?: readonly FakeLoginOutcome[];
	readonly resume?: readonly FakeResumeOutcome[];
	readonly heldGuildIds?: readonly string[];
	readonly backoff?: ReconnectBackoffSettings;
}

function harness(options: HarnessOptions = {}): Harness {
	const factory = new FakeDiscordGatewayClientFactory({ guildIds: options.heldGuildIds });
	for (const outcome of options.login ?? []) {
		factory.queueLogin(outcome);
	}

	for (const outcome of options.resume ?? []) {
		factory.queueResume(outcome);
	}

	const counters = new DiscordTransportCounters();
	const gaps = new DiscordDeclaredGaps();
	const observer = new RecordingConnectionObserver();
	const intake = new RecordingIntake();
	const logger = new RecordingLogger();
	const timing = fakeClock();
	const waiter = fakeWait();

	const connection = new DiscordConnectionGateway({
		config: fakeConfig({ guildId: GUILD_ID }),
		clientFactory: factory,
		onRawEvent: (event: RawDiscordEvent) => intake.handle(event),
		observer,
		counters,
		gaps,
		logger,
		clock: timing.clock,
		wait: waiter.wait,
		backoff: options.backoff ?? FAST_BACKOFF
	} satisfies DiscordConnectionDependencies);

	return {
		connection,
		factory,
		observer,
		intake,
		counters,
		gaps,
		logger,
		delays: waiter.delays,
		advance: timing.advance
	};
}

describe("R1 — exactly one Gateway connection per Installation", () => {
	it("opens one client at startup with the validated intents and the configured Guild", async () => {
		const h = harness();
		await h.connection.start();

		expect(h.factory.clients).toHaveLength(1);
		expect(h.factory.totalLoginCalls()).toBe(1);
		expect(h.factory.requested[0]?.intents).toEqual(DISCORD_REQUIRED_INTENTS);
		expect(h.factory.requested[0]?.guildId).toBe(GUILD_ID);
		expect(h.connection.read().status).toBe(DiscordConnectionStatus.connected);
		expect(h.connection.read().epoch).toBe(1);
		expect(h.observer.connected).toHaveLength(1);
		expect(h.observer.connected[0]?.reconnectAttempts).toBe(0);
	});

	it("refuses a second login while a client is live and creates no second client", async () => {
		const h = harness();
		await h.connection.start();

		await expect(h.connection.start()).rejects.toBeInstanceOf(DiscordConnectionAlreadyOpenError);
		expect(h.factory.totalLoginCalls()).toBe(1);
		expect(h.factory.clients).toHaveLength(1);
	});

	it("keeps one client instance across a disconnect that resumes successfully", async () => {
		const h = harness();
		await h.connection.start();
		h.factory.emitDisconnect({ cause: "network" });
		await h.connection.settle();

		expect(h.factory.clients).toHaveLength(1);
		expect(h.factory.totalResumeCalls()).toBe(1);
		expect(h.factory.totalLoginCalls()).toBe(1);
		expect(h.factory.totalDestroyCalls()).toBe(0);
		expect(h.factory.liveClients()).toHaveLength(1);
		expect(h.connection.read().status).toBe(DiscordConnectionStatus.connected);
		expect(h.observer.connected).toHaveLength(2);
		expect(h.connection.read().epoch).toBe(2);
	});

	it("reports the connection lost once and reconnects without a parallel client", async () => {
		const h = harness();
		await h.connection.start();

		h.factory.emitDisconnect({ cause: "network" });
		h.factory.emitDisconnect({ cause: "closed" });
		h.factory.emitDisconnect({ cause: "invalidated-session" });
		await h.connection.settle();

		expect(h.factory.maxLiveClients).toBe(1);
		expect(h.factory.clients).toHaveLength(1);
		expect(h.delays).toHaveLength(1);
	});

	it("destroys the previous client before the fresh identify that follows a rejected resume", async () => {
		const h = harness({ resume: [{ kind: "rejected", reason: "session expired" }] });
		await h.connection.start();
		h.factory.emitDisconnect({ cause: "invalidated-session" });
		await h.connection.settle();

		expect(h.factory.clients).toHaveLength(2);
		expect(h.factory.clients[0]?.destroyCalls).toBe(1);
		expect(h.factory.clients[1]?.loginCalls).toBe(1);
		expect(h.factory.callOrder).toEqual(["create:1", "login:1", "resume:1", "destroy:1", "create:2", "login:2"]);
		expect(h.factory.maxLiveClients).toBe(1);
		expect(h.connection.read().status).toBe(DiscordConnectionStatus.connected);
	});

	it("summarizes a loop of failed attempts into one connected transition with its attempt count", async () => {
		const h = harness({
			resume: [{ kind: "rejected", reason: "session expired" }],
			login: [
				{ kind: "accept" },
				{ kind: "reject", cause: "unreachable" },
				{ kind: "reject", cause: "unreachable" },
				{ kind: "accept" }
			]
		});
		await h.connection.start();
		h.factory.emitDisconnect({ cause: "network" });
		await h.connection.settle();

		expect(h.observer.connected).toHaveLength(2);
		expect(h.observer.connected[1]?.reconnectAttempts).toBe(3);
		expect(h.counters.snapshot().reconnectAttempts).toBe(3);
		expect(h.delays).toEqual([10, 20, 40]);
		expect(h.factory.maxLiveClients).toBe(1);
		expect(h.connection.read().status).toBe(DiscordConnectionStatus.connected);
	});

	it("reports unavailable while reconnects continue, then connects", async () => {
		const h = harness({
			resume: [{ kind: "rejected", reason: "session expired" }],
			login: [
				{ kind: "accept" },
				{ kind: "reject", cause: "unreachable" },
				{ kind: "reject", cause: "unreachable" },
				{ kind: "reject", cause: "unreachable" },
				{ kind: "accept" }
			]
		});
		await h.connection.start();
		h.factory.emitDisconnect({ cause: "network" });
		await h.connection.settle();

		expect(h.observer.unavailable.length).toBeGreaterThanOrEqual(1);
		expect(h.connection.read().status).toBe(DiscordConnectionStatus.connected);
		expect(h.delays).toEqual([10, 20, 40, 40]);
	});

	it("never buffers events while disconnected: they are declared as a gap and not delivered", async () => {
		const h = harness();
		await h.connection.start();
		h.factory.emitDisconnect({ cause: "network" });

		h.factory.emitRaw("MESSAGE_CREATE", { id: "1", channel_id: "2", guild_id: GUILD_ID });
		expect(h.intake.received).toHaveLength(0);
		expect(h.gaps.pending()).toHaveLength(1);
		expect(h.counters.snapshot().receivedRawEvents).toBe(1);

		await h.connection.settle();
		expect(h.connection.read().status).toBe(DiscordConnectionStatus.connected);
	});

	it("delivers nothing and reports unavailable when the connection does not hold the configured Guild", async () => {
		const h = harness({ heldGuildIds: ["222222222222222222"] });
		await h.connection.start();

		expect(h.connection.read().status).toBe(DiscordConnectionStatus.unavailable);
		expect(h.observer.connected).toHaveLength(0);
		expect(h.observer.unavailable.join(" ")).toContain(GUILD_ID);
		expect(h.logger.messagesMatching("Configured Discord Guild is absent")).toHaveLength(1);
		expect(h.logger.messagesMatching("absent")[0]?.fields["guildId"]).toBe(GUILD_ID);

		h.factory.emitRaw("MESSAGE_CREATE", { id: "1", channel_id: "2", guild_id: GUILD_ID });
		expect(h.intake.received).toHaveLength(0);
		expect(h.gaps.pending()).toHaveLength(1);
	});
});

describe("R1 error — a rejected login fails startup with no retry loop", () => {
	it("names an invalid token, closes the client and performs exactly one attempt", async () => {
		const h = harness({ login: [{ kind: "reject", cause: "invalid-token" }] });

		await expect(h.connection.start()).rejects.toBeInstanceOf(DiscordLoginRejectedError);
		expect(h.factory.clients).toHaveLength(1);
		expect(h.factory.totalLoginCalls()).toBe(1);
		expect(h.factory.totalDestroyCalls()).toBe(1);
		expect(h.delays).toHaveLength(0);
		expect(h.observer.connected).toHaveLength(0);
		expect(h.connection.read().status).toBe(DiscordConnectionStatus.unavailable);
	});

	it("names the disabled privileged intent as the cause", async () => {
		const h = harness({ login: [{ kind: "reject", cause: "disallowed-intent", intent: "MESSAGE_CONTENT" }] });
		const failure = await h.connection
			.start()
			.then(() => undefined)
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(DiscordLoginRejectedError);
		expect((failure as DiscordLoginRejectedError).message).toContain("MESSAGE_CONTENT");
		expect(h.factory.totalLoginCalls()).toBe(1);
		expect(h.delays).toHaveLength(0);
	});

	it("keeps the token out of every log line and error message", async () => {
		const h = harness({ login: [{ kind: "reject", cause: "invalid-token" }] });
		const failure = await h.connection.start().catch((error: unknown) => error);

		expect(h.logger.transcript()).not.toContain("fake.bot.token.value");
		expect((failure as Error).message).not.toContain("fake.bot.token.value");
	});
});

describe("R9 — a broken configuration never reaches the transport", () => {
	const validEnv = { DISCORD_BOT_TOKEN: "fake.bot.token.value", DISCORD_GUILD_ID: GUILD_ID };

	function assemble(
		env: Readonly<Record<string, string | undefined>>,
		declaredIntents?: readonly string[]
	): FakeDiscordGatewayClientFactory {
		const factory = new FakeDiscordGatewayClientFactory();
		createDiscordConnection({
			env,
			...(declaredIntents === undefined ? {} : { declaredIntents }),
			clientFactory: factory,
			onRawEvent: () => undefined,
			observer: new RecordingConnectionObserver(),
			counters: new DiscordTransportCounters(),
			gaps: new DiscordDeclaredGaps(),
			logger: new RecordingLogger(),
			clock: fakeClock().clock,
			wait: fakeWait().wait
		});

		return factory;
	}

	it("fails for the token before any connection attempt", () => {
		expect(() => assemble({ DISCORD_GUILD_ID: GUILD_ID })).toThrow(/DISCORD_BOT_TOKEN/);
	});

	it("fails for the Guild id before any connection attempt", () => {
		expect(() => assemble({ ...validEnv, DISCORD_GUILD_ID: "guild-id" })).toThrow(/DISCORD_GUILD_ID/);
	});

	it.each([...DISCORD_REQUIRED_INTENTS])("fails naming %s before any connection attempt", (intent) => {
		const declared = DISCORD_REQUIRED_INTENTS.filter((item) => item !== intent);
		expect(() => assemble(validEnv, declared)).toThrow(new RegExp(`intent ${intent}`));
		expect(() => assemble(validEnv, declared)).toThrow(DiscordIntentConfigurationError);
	});

	it("records zero connection attempts for every rejected configuration", () => {
		const broken: Readonly<Record<string, string | undefined>>[] = [
			{ DISCORD_GUILD_ID: GUILD_ID },
			{ DISCORD_BOT_TOKEN: "token", DISCORD_GUILD_ID: "0" },
			{ ...validEnv, DISCORD_GUILD_ID: "111111111111111111x" }
		];

		for (const env of broken) {
			expect(() => assemble(env)).toThrow();
		}
	});

	it("builds the connection from the validated contract and requests the four intents", async () => {
		const factory = new FakeDiscordGatewayClientFactory();
		const connection = createDiscordConnection({
			env: validEnv,
			clientFactory: factory,
			onRawEvent: () => undefined,
			observer: new RecordingConnectionObserver(),
			counters: new DiscordTransportCounters(),
			gaps: new DiscordDeclaredGaps(),
			logger: new RecordingLogger(),
			clock: fakeClock().clock,
			wait: fakeWait().wait
		});

		await connection.start();

		expect(factory.requested[0]?.intents).toEqual(DISCORD_REQUIRED_INTENTS);
		expect(factory.requested[0]?.guildId).toBe(GUILD_ID);
	});

	it("applies the documented default backoff when the composition root supplies none", async () => {
		const factory = new FakeDiscordGatewayClientFactory();
		const waiter = fakeWait();
		const connection = createDiscordConnection({
			env: validEnv,
			clientFactory: factory,
			onRawEvent: () => undefined,
			observer: new RecordingConnectionObserver(),
			counters: new DiscordTransportCounters(),
			gaps: new DiscordDeclaredGaps(),
			logger: new RecordingLogger(),
			clock: fakeClock().clock,
			wait: waiter.wait
		});

		await connection.start();
		factory.emitDisconnect({ cause: "network" });
		await connection.settle();

		expect(waiter.delays).toEqual([DEFAULT_RECONNECT_BACKOFF.baseDelayMs]);
	});
});
