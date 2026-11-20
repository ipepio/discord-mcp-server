import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { InvalidConfigurationError, MissingConfigurationError } from "../../../src/shared/config/config.errors.js";
import { APP_CONFIG_TOKEN } from "../../../src/shared/config/config.tokens.js";
import type { AppConfig } from "../../../src/shared/config/app-config.interface.js";
import { APP_LOGGER_TOKEN } from "../../../src/shared/logging/logging.tokens.js";
import { DiscordConnectionStatus } from "../../../src/features/discord/models/domain/discord-connection-status.js";
import type { DiscordTransportCounters } from "../../../src/features/discord/models/domain/discord-transport-counters.js";
import { DiscordRestOperation } from "../../../src/features/discord/models/domain/discord-rest-operation.enum.js";
import type { DiscordRestOperations } from "../../../src/features/discord/models/domain/discord-rest-gateway.interface.js";
import type { DiscordStatusQuery } from "../../../src/features/discord/models/domain/discord-status.interface.js";
import type { DiscordRestReadPolicy } from "../../../src/features/discord/models/domain/discord-rest-policy.js";
import { DiscordModule } from "../../../src/features/discord/discord.module.js";
import type { DiscordModuleSettings } from "../../../src/features/discord/discord.module.js";
import type { DiscordEventStreamGateway } from "../../../src/features/discord/gateways/discord-event-stream.gateway.js";
import { DiscordShutdownGateway } from "../../../src/features/discord/gateways/discord-shutdown.gateway.js";
import type { DiscordShutdownReport } from "../../../src/features/discord/gateways/discord-shutdown.gateway.js";
import type { DiscordConnectionGateway } from "../../../src/features/discord/gateways/discord-connection.gateway.js";
import {
	DISCORD_CONFIG_TOKEN,
	DISCORD_CONNECTION_TOKEN,
	DISCORD_COUNTERS_TOKEN,
	DISCORD_EVENT_STREAM_TOKEN,
	DISCORD_GAP_LEDGER_TOKEN,
	DISCORD_REST_OPERATIONS_TOKEN,
	DISCORD_REST_POLICY_TOKEN,
	DISCORD_REST_TRANSPORT_TOKEN,
	DISCORD_SHUTDOWN_TOKEN,
	DISCORD_STATUS_TOKEN
} from "../../../src/features/discord/discord.tokens.js";
import { DISCORD_REQUIRED_INTENTS } from "../../../src/features/discord/config/discord-config.interface.js";
import type { DiscordConfig } from "../../../src/features/discord/config/discord-config.interface.js";
import { DiscordJsRestTransport } from "../../../src/features/discord/gateways/discord-rest.transport.gateway.js";
import { GUILD_ID, normalizeOne } from "./fakes/normalize.js";
import { fakeConfig, FakeDiscordGatewayClientFactory } from "./fakes/fake-discord-gateway-client.js";
import { fakeClock, fakeWait } from "./fakes/fake-discord-gateway-client.js";
import { RecordingLogger } from "./fakes/recording-logger.js";
import { restHarness } from "./fakes/rest-harness.js";
import { messageFixture } from "./fakes/composed-installation.js";
import { restOk } from "./fakes/fake-discord-rest-transport.js";

/**
 * T7 — module composition. A consumer feature imports one module and receives the four things the task
 * names: an event-stream subscription, the status read, the REST operations and the configuration
 * requirements. These cases resolve every exported token through Nest's own injector, prove the two
 * late-bound seams are wired to the resync signaling, and show that a broken configuration fails at
 * composition — before any client exists and before any request is sent (R9).
 */

const appConfig: AppConfig = {
	authorization: {
		discordClientId: "fixture",
		discordClientSecret: "fixture",
		publicBaseUrl: "https://hub.example",
		sessionTtlSeconds: 300
	},
	database: { url: "postgresql://user@localhost:5432/app" },
	http: { port: 3_000 },
	logging: { level: "info" }
};

/**
 * Harness overrides. `restTransport` and `clientFactory` deliberately accept an explicit `undefined`:
 * `composed` already wires both fakes, and the settings spread runs afterwards, so only `undefined`
 * means "let the module build its own discord.js default" (R7, R8).
 */
type ComposedOverrides = Partial<Omit<DiscordModuleSettings, "restTransport" | "clientFactory">> & {
	readonly restTransport?: DiscordModuleSettings["restTransport"] | undefined;
	readonly clientFactory?: DiscordModuleSettings["clientFactory"] | undefined;
};

async function composed(settings: ComposedOverrides = {}) {
	const logger = new RecordingLogger();
	const timing = fakeClock();
	const waiter = fakeWait();
	const transport = restHarness().transport;

	const moduleRef = await Test.createTestingModule({
		imports: [
			DiscordModule.forRoot({
				config: fakeConfig({ guildId: GUILD_ID }),
				restTransport: transport,
				clientFactory: new FakeDiscordGatewayClientFactory() as never,
				logger,
				clock: timing.clock,
				wait: waiter.wait,
				...settings
			} as DiscordModuleSettings)
		]
	})
		.overrideProvider(APP_CONFIG_TOKEN)
		.useValue(appConfig)
		.overrideProvider(APP_LOGGER_TOKEN)
		.useValue(logger)
		.compile();

	// `init()` is what runs the module's lifecycle hooks, including the binding of the two late seams.
	await moduleRef.init();

	return { moduleRef, logger, transport, timing, waiter };
}

describe("T7 — one module, the surface a consumer feature needs", () => {
	it("resolves every exported token to the instance its contract names", async () => {
		const { moduleRef } = await composed();

		expect(moduleRef.get<DiscordConfig>(DISCORD_CONFIG_TOKEN).guildId).toBe(GUILD_ID);
		expect(moduleRef.get<DiscordConfig>(DISCORD_CONFIG_TOKEN).intents).toEqual([...DISCORD_REQUIRED_INTENTS]);
		expect(typeof moduleRef.get<DiscordRestOperations>(DISCORD_REST_OPERATIONS_TOKEN).readMemberRoster).toBe(
			"function"
		);
		expect(typeof moduleRef.get<DiscordStatusQuery>(DISCORD_STATUS_TOKEN).read).toBe("function");
		expect(typeof moduleRef.get<DiscordEventStreamGateway>(DISCORD_EVENT_STREAM_TOKEN).subscribe).toBe("function");
		expect(moduleRef.get<DiscordConnectionGateway>(DISCORD_CONNECTION_TOKEN).read().status).toBe(
			DiscordConnectionStatus.disconnected
		);
		expect(moduleRef.get<DiscordShutdownGateway>(DISCORD_SHUTDOWN_TOKEN)).toBeInstanceOf(DiscordShutdownGateway);
		expect(moduleRef.get<DiscordRestReadPolicy>(DISCORD_REST_POLICY_TOKEN).maxAttempts).toBeGreaterThan(0);
		expect(moduleRef.get<DiscordTransportCounters>(DISCORD_COUNTERS_TOKEN).snapshot().receivedRawEvents).toBe(0);

		await moduleRef.close();
	});

	it("a consumer reads status and performs a bounded REST read through the injected seams", async () => {
		const { moduleRef, transport, logger } = await composed();
		const operations = moduleRef.get<DiscordRestOperations>(DISCORD_REST_OPERATIONS_TOKEN);
		transport.reply(
			`/guilds/${GUILD_ID}/roles`,
			restOk([{ id: "6", name: "Staff", permissions: "8", position: 1 }])
		);

		const roles = await operations.readRoles();
		const status = moduleRef.get<DiscordStatusQuery>(DISCORD_STATUS_TOKEN).read();

		expect(roles).toEqual([
			{ guildId: GUILD_ID, roleId: "6", name: "Staff", permissionsBitfield: "8", position: 1 }
		]);
		expect(transport.operations()).toEqual([DiscordRestOperation.roles]);
		expect(status.connection.status).toBe(DiscordConnectionStatus.disconnected);
		expect(status.delivery.accepting).toBe(true);
		expect(logger.transcript()).not.toContain("Staff");

		await moduleRef.close();
	});

	it("composition binds the drop declaration to the resync signaling (R4, R5)", async () => {
		const { moduleRef, logger } = await composed();
		const stream = moduleRef.get<DiscordEventStreamGateway>(DISCORD_EVENT_STREAM_TOKEN);
		const gaps = moduleRef.get<{ pending: () => readonly { reason: string }[] }>(DISCORD_GAP_LEDGER_TOKEN);

		// Intake closed, so what arrives after is dropped: the declaration must reach the signaling.
		stream.stopAccepting();
		logger.clear();
		const dropped = normalizeOne("MESSAGE_CREATE", messageFixture({ id: "900" }));
		const secret = "content that must stay out of the log";
		stream.publish({ ...dropped, content: secret } as typeof dropped);

		// The gap reached the ledger, which only the resync signaling writes: the binder forwards (R5).
		expect(gaps.pending().map((gap) => gap.reason)).toEqual(["intake-stopped"]);
		expect(logger.transcript()).not.toContain(secret);

		await moduleRef.close();
	});

	it("shutdown is reachable through the module and closes what was never opened (R6)", async () => {
		const { moduleRef } = await composed();

		const report = await moduleRef.get<DiscordShutdownGateway>(DISCORD_SHUTDOWN_TOKEN).shutdown();

		expect(report).toMatchObject({ connectionClosed: true });
		expect((report as DiscordShutdownReport).statusAfter).toBe(DiscordConnectionStatus.disconnected);

		await moduleRef.close();
	});

	it("defaults to the discord.js REST transport, and a harness replaces exactly that seam", async () => {
		const { moduleRef, transport } = await composed();
		const defaultModule = await composed({ restTransport: undefined, clientFactory: undefined });

		expect(moduleRef.get(DISCORD_REST_TRANSPORT_TOKEN)).toBe(transport);
		expect(defaultModule.moduleRef.get(DISCORD_REST_TRANSPORT_TOKEN)).toBeInstanceOf(DiscordJsRestTransport);

		await moduleRef.close();
		await defaultModule.moduleRef.close();
	});

	it("a broken configuration fails at composition, before any client exists (R9)", async () => {
		await expect(
			Test.createTestingModule({ imports: [DiscordModule.forRoot({ env: {} })] })
				.overrideProvider(APP_CONFIG_TOKEN)
				.useValue(appConfig)
				.overrideProvider(APP_LOGGER_TOKEN)
				.useValue(new RecordingLogger())
				.compile()
		).rejects.toThrow(MissingConfigurationError);

		await expect(
			Test.createTestingModule({
				imports: [
					DiscordModule.forRoot({
						env: { DISCORD_BOT_TOKEN: "a-token", DISCORD_GUILD_ID: "not-a-snowflake" }
					})
				]
			})
				.overrideProvider(APP_CONFIG_TOKEN)
				.useValue(appConfig)
				.overrideProvider(APP_LOGGER_TOKEN)
				.useValue(new RecordingLogger())
				.compile()
		).rejects.toThrow(InvalidConfigurationError);
	});

	it("a REST policy outside Discord's page ceiling cannot be composed at all (R7)", () => {
		expect(() =>
			DiscordModule.forRoot({
				config: fakeConfig(),
				restPolicy: { ...restHarness().policy, memberPageSize: 5_000 }
			})
		).toThrow(RangeError);
	});
});
