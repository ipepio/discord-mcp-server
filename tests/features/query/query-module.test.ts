import "reflect-metadata";
import { McpAuthenticationGuard } from "../../../src/features/authorization/index.js";
import { Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import {
	QueryModule,
	QUERY_HYBRID_RETRIEVAL_TOKEN,
	QUERY_TOOLS_ADAPTER_TOKEN,
	QUERY_SERVER_METADATA_TOKEN,
	QueryToolsAdapter
} from "../../../src/features/query/index.js";
import {
	GUILD_STATE_STATUS_QUERY_TOKEN,
	GUILD_STATE_USER_ACCESSIBLE_CHANNELS_QUERY_TOKEN,
	GUILD_STATE_GUILD_IDENTITY_QUERY_TOKEN,
	GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN
} from "../../../src/features/guild-state/index.js";
import type { GetServerMetadataQuery } from "../../../src/features/query/index.js";
import { APP_CONFIG_TOKEN } from "../../../src/shared/config/config.tokens.js";
import { PG_POOL_TOKEN } from "../../../src/shared/persistence/persistence.tokens.js";
import { loadQueryConfig } from "../../../src/shared/config/query-config.factory.js";

@Module({
	providers: [
		{
			provide: GUILD_STATE_STATUS_QUERY_TOKEN,
			useValue: { execute: async () => ({ guildId: "1", status: "current" }) }
		},
		{
			provide: GUILD_STATE_USER_ACCESSIBLE_CHANNELS_QUERY_TOKEN,
			useValue: { execute: async () => ({ guildId: "1", channels: [] }) }
		},
		{
			provide: GUILD_STATE_GUILD_IDENTITY_QUERY_TOKEN,
			useValue: {
				execute: async () => ({ status: "registered", guild: { guildId: "1", guildName: "Fixture guild" } })
			}
		},
		{
			provide: GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN,
			useValue: {
				execute: async () => ({
					channels: [],
					botCannotViewChannelIds: [],
					botMembershipRegistered: true
				})
			}
		},
		{
			provide: QUERY_HYBRID_RETRIEVAL_TOKEN,
			useValue: { execute: async () => ({ candidates: [], retrieval: "hybrid" }) }
		}
	],
	exports: [
		GUILD_STATE_STATUS_QUERY_TOKEN,
		GUILD_STATE_USER_ACCESSIBLE_CHANNELS_QUERY_TOKEN,
		GUILD_STATE_GUILD_IDENTITY_QUERY_TOKEN,
		GUILD_STATE_INGESTIBLE_CHANNELS_QUERY_TOKEN,
		QUERY_HYBRID_RETRIEVAL_TOKEN
	]
})
class QuerySeamsModule {}

describe("query Nest composition", () => {
	it("resolves real handlers and adapter behind explicit tokens", async () => {
		const module = await Test.createTestingModule({
			imports: [
				QueryModule.register({ config: loadQueryConfig({}), imports: [QuerySeamsModule], botUserId: "99" })
			]
		})
			.overrideGuard(McpAuthenticationGuard)
			.useValue({ canActivate: () => true })
			.overrideProvider(APP_CONFIG_TOKEN)
			.useValue({ database: { url: "postgres://unused" }, http: { port: 0 }, logging: { level: "error" } })
			.overrideProvider(PG_POOL_TOKEN)
			.useValue({ query: async () => ({ rows: [] }), end: async () => {} })
			.compile();
		try {
			const adapter = module.get<QueryToolsAdapter>(QUERY_TOOLS_ADAPTER_TOKEN);
			expect(adapter).toBeInstanceOf(QueryToolsAdapter);
			expect(
				await adapter.handle(
					{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_channels" } },
					{ userId: "7", sessionId: "resolved", expiresAt: new Date("2099-01-01") }
				)
			).toMatchObject({ result: { isError: false, structuredContent: { data: [] } } });
			expect(
				(await module.get<GetServerMetadataQuery>(QUERY_SERVER_METADATA_TOKEN).execute()).instructions
			).toContain("Fixture guild");
		} finally {
			await module.close();
		}
	});
});
