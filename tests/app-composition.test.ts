import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { ModulesContainer } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module.js";
import { ApplicationLifecycle } from "../src/application-lifecycle.js";
import * as discord from "../src/features/discord/index.js";
import * as guildState from "../src/features/guild-state/index.js";
import * as ingestion from "../src/features/ingestion/index.js";
import * as query from "../src/features/query/index.js";
import {
	AuthorizationModule,
	AuthenticateSessionQuery,
	McpAuthenticationGuard
} from "../src/features/authorization/index.js";
import { SemanticIndexModule, HYBRID_RETRIEVAL } from "../src/features/semantic-index/index.js";
import { EMBEDDING_WORKER } from "../src/features/semantic-index/semantic-index.tokens.js";
import { APP_CONFIG_TOKEN } from "../src/shared/config/config.tokens.js";
import { PG_POOL_TOKEN } from "../src/shared/persistence/persistence.tokens.js";
import { loadAppConfig } from "../src/shared/config/config.factory.js";
const env = {
	IMPORT_MODE: "full",
	DATABASE_URL: "postgres://unused",
	DISCORD_BOT_TOKEN: "fixture",
	DISCORD_GUILD_ID: "1",
	DISCORD_CLIENT_ID: "123",
	DISCORD_CLIENT_SECRET: "fixture",
	PUBLIC_BASE_URL: "https://hub.example",
	SESSION_TTL_SECONDS: "300",
	EMBEDDING_PROVIDER: "openai",
	EMBEDDING_MODEL: "text-embedding-3-small",
	EMBEDDING_DIMENSION: "1536",
	EMBEDDING_API_KEY: "fixture"
};

describe("application composition", () => {
	it("resolves every public token and constructs exactly one instance of each feature module without network I/O", async () => {
		const pool = { query: vi.fn(), end: vi.fn() };
		const module = await Test.createTestingModule({ imports: [AppModule.forRoot({ botUserId: "7", env })] })
			.overrideProvider(PG_POOL_TOKEN)
			.useValue(pool)
			.overrideProvider(EMBEDDING_WORKER)
			.useValue({})
			.compile();
		try {
			const container = module.get(ModulesContainer);
			for (const moduleClass of [
				discord.DiscordModule,
				guildState.GuildStateModule,
				ingestion.IngestionModule,
				query.QueryModule,
				AuthorizationModule,
				SemanticIndexModule
			]) {
				const instances = [...container.values()].filter((entry) => entry.metatype === moduleClass);
				expect(instances).toHaveLength(1);
			}
			for (const exports of [discord, guildState, ingestion, query]) {
				for (const [name, token] of Object.entries(exports))
					if (name.endsWith("_TOKEN") && typeof token === "string") {
						expect(module.get(token)).toBeDefined();
						expect([...container.values()].filter((entry) => entry.providers.has(token))).toHaveLength(1);
					}
			}
			for (const token of [
				HYBRID_RETRIEVAL,
				AuthenticateSessionQuery,
				McpAuthenticationGuard,
				ApplicationLifecycle
			])
				expect(module.get(token)).toBeDefined();
			expect(module.get(APP_CONFIG_TOKEN)).toEqual(loadAppConfig(env));
			// One injection token, exported by the producer, is what the query module wires.
			expect(HYBRID_RETRIEVAL).toBe(query.QUERY_HYBRID_RETRIEVAL_TOKEN);
			expect([...container.values()].filter((entry) => entry.providers.has(HYBRID_RETRIEVAL))).toHaveLength(1);
			expect(pool.query).not.toHaveBeenCalled();
		} finally {
			await module.close();
		}
	});
});
