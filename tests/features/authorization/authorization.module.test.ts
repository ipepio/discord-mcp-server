import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { describe, expect, it, vi } from "vitest";
import {
	AuthorizationModule,
	AuthenticateSessionQuery,
	McpAuthenticationGuard,
	GetAuthorizationServerMetadataQuery
} from "../../../src/features/authorization/index.js";
import {
	DiscordModule,
	DISCORD_REQUIRED_INTENTS,
	DISCORD_EVENT_STREAM_TOKEN
} from "../../../src/features/discord/index.js";
import type { DiscordEventConsumer } from "../../../src/features/discord/index.js";
import { GuildStateModule } from "../../../src/features/guild-state/index.js";
import { APP_CONFIG_TOKEN } from "../../../src/shared/config/config.tokens.js";
import { PG_POOL_TOKEN } from "../../../src/shared/persistence/persistence.tokens.js";
import { APP_LOGGER_TOKEN } from "../../../src/shared/logging/logging.tokens.js";
import { StructuredLogger } from "../../../src/shared/logging/structured-logger.js";
import { OAuthController } from "../../../src/features/authorization/controllers/oauth.controller.js";
import { LoginController } from "../../../src/features/authorization/controllers/login.controller.js";
import { RegisterClientCommand } from "../../../src/features/authorization/commands/register-client.command.js";

// A pool-shaped test double: no network. Generic rows remain empty rather than casting driver payloads.
const pool = {
	query: async <Row>() => ({ rows: [] as Row[] }),
	connect: async () => ({ query: async <Row>() => ({ rows: [] as Row[] }), release: () => undefined }),
	end: async () => undefined
};

describe("authorization module composition", () => {
	it("resolves real sibling modules and feature providers without starting a connection or identity call", async () => {
		const discord = DiscordModule.forRoot({
			config: { botToken: "fixture-token", guildId: "123", intents: DISCORD_REQUIRED_INTENTS }
		});
		const guild = GuildStateModule.forRoot({ imports: [discord] });
		const gateway = { resolveUserId: vi.fn().mockResolvedValue("456") };
		const logger = new StructuredLogger("error", () => undefined);
		const moduleRef = await Test.createTestingModule({
			imports: [AuthorizationModule.forRoot({ imports: [discord, guild], gateway })]
		})
			.overrideProvider(APP_CONFIG_TOKEN)
			.useValue({
				database: { url: "postgres://unused@localhost/unused" },
				http: { port: 0 },
				logging: { level: "error" },
				authorization: {
					discordClientId: "id",
					discordClientSecret: "secret",
					publicBaseUrl: "https://hub.example",
					sessionTtlSeconds: 300
				}
			})
			.overrideProvider(PG_POOL_TOKEN)
			.useValue(pool)
			.overrideProvider(APP_LOGGER_TOKEN)
			.useValue(logger)
			.compile();
		const application = moduleRef.createNestApplication();
		await application.init();
		const openApi = SwaggerModule.createDocument(application, new DocumentBuilder().build());
		expect(Object.keys(openApi.paths)).toEqual([]);
		expect(moduleRef.get(AuthenticateSessionQuery)).toBeInstanceOf(AuthenticateSessionQuery);
		expect(moduleRef.get(McpAuthenticationGuard)).toBeInstanceOf(McpAuthenticationGuard);
		expect(moduleRef.get(OAuthController)).toBeInstanceOf(OAuthController);
		expect(moduleRef.get(LoginController)).toBeInstanceOf(LoginController);
		expect(moduleRef.get(RegisterClientCommand)).toBeInstanceOf(RegisterClientCommand);
		expect(moduleRef.get(GetAuthorizationServerMetadataQuery).execute().issuer).toBe("https://hub.example");
		expect(typeof moduleRef.get<DiscordEventConsumer>(DISCORD_EVENT_STREAM_TOKEN).subscribe).toBe("function");
		expect(gateway.resolveUserId).not.toHaveBeenCalled();
		await application.close();
	});
});
