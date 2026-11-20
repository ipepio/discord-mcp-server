import { Module, RequestMethod } from "@nestjs/common";
import type { DynamicModule, MiddlewareConsumer, ModuleMetadata, NestModule } from "@nestjs/common";
import { ConfigModule } from "../../shared/config/config.module.js";
import { APP_CONFIG_TOKEN } from "../../shared/config/config.tokens.js";
import { authorizationRateLimits } from "../../shared/config/authorization-config.js";
import type { AppConfig } from "../../shared/config/app-config.interface.js";
import { PersistenceModule } from "../../shared/persistence/persistence.module.js";
import { PG_POOL_TOKEN } from "../../shared/persistence/persistence.tokens.js";
import { LoggingModule } from "../../shared/logging/logging.module.js";
import { APP_LOGGER_TOKEN } from "../../shared/logging/logging.tokens.js";
import type { AppLogger } from "../../shared/logging/logger.interface.js";
import { DISCORD_CONFIG_TOKEN, DISCORD_EVENT_STREAM_TOKEN } from "../discord/index.js";
import type { DiscordConfig, DiscordEventConsumer } from "../discord/index.js";
import { GUILD_STATE_MEMBERSHIP_STATUS_QUERY_TOKEN, GUILD_STATE_STATUS_QUERY_TOKEN } from "../guild-state/index.js";
import type { GetMembershipStatusQuery, GetGuildStateStatusQuery } from "../guild-state/index.js";
import { PostgresAuthorizationStoreRepository } from "./repositories/postgres-authorization-store.repository.js";
import type { AuthorizationSqlExecutor } from "./repositories/postgres-authorization-store.repository.js";
import type { AuthorizationStoreRepository } from "./repositories/authorization-store.repository.js";
import { HttpDiscordOAuthGateway } from "./gateways/discord-oauth.gateway.js";
import type { DiscordOAuthGateway } from "./gateways/discord-oauth.gateway.interface.js";
import { RequireCurrentMembershipQuery } from "./queries/require-current-membership.query.js";
import { AuthenticateSessionQuery } from "./queries/authenticate-session.query.js";
import { GetAuthorizationServerMetadataQuery } from "./queries/get-authorization-server-metadata.query.js";
import { BeginLoginCommand } from "./commands/begin-login.command.js";
import { RegisterClientCommand } from "./commands/register-client.command.js";
import { CompleteLoginCommand } from "./commands/complete-login.command.js";
import { ExchangeAuthorizationCodeCommand } from "./commands/exchange-authorization-code.command.js";
import { RotateRefreshTokenCommand } from "./commands/rotate-refresh-token.command.js";
import { RevokeUserSessionsCommand } from "./commands/revoke-user-sessions.command.js";
import { RevokeSessionCommand } from "./commands/revoke-session.command.js";
import { PurgeExpiredSessionsCommand } from "./commands/purge-expired-sessions.command.js";
import { AuthorizationAuditGateway } from "./gateways/authorization-audit.gateway.js";
import { OAuthController } from "./controllers/oauth.controller.js";
import { LoginController } from "./controllers/login.controller.js";
import { AUTHORIZATION_PUBLIC_BASE_URL_TOKEN, McpAuthenticationGuard } from "./controllers/mcp-authentication.guard.js";
import { LandingController } from "./controllers/landing.controller.js";
import { FirstPartyLoginController } from "./controllers/first-party-login.controller.js";
import { FirstPartyClientSeeder } from "./bootstrap/first-party-client.seeder.js";
import { AUTHORIZATION_RATE_LIMITER_TOKEN, AUTHORIZATION_STORE_TOKEN } from "./authorization.tokens.js";
import { InMemoryFixedWindowRateLimiter } from "./gateways/rate-limit.gateway.js";
import { RateLimitMiddleware } from "./controllers/rate-limit.middleware.js";
import { RATE_LIMITED_ROUTES, rateLimitRules } from "./models/domain/rate-limit-policy.js";
import { MembershipEndSubscription } from "./gateways/membership-end-subscription.gateway.js";

const STORE = AUTHORIZATION_STORE_TOKEN;
const GATEWAY = "AUTHORIZATION_DISCORD_OAUTH_GATEWAY";
export interface AuthorizationModuleSettings {
	/** Supply the SAME Discord and guild-state module instances used by the rest of the application. */
	readonly imports: NonNullable<ModuleMetadata["imports"]>;
	readonly gateway?: DiscordOAuthGateway;
}

@Module({})
export class AuthorizationModule implements NestModule {
	/** Applies the O3 limiter to the four public OAuth endpoints and the product `/mcp` surface. */
	public configure(consumer: MiddlewareConsumer): void {
		consumer.apply(RateLimitMiddleware).forRoutes(
			...RATE_LIMITED_ROUTES.map((route) => ({
				path: route.path,
				method: route.method === "POST" ? RequestMethod.POST : RequestMethod.GET
			}))
		);
	}

	public static forRoot(settings: AuthorizationModuleSettings): DynamicModule {
		return {
			module: AuthorizationModule,
			imports: [ConfigModule, PersistenceModule, LoggingModule, ...settings.imports],
			controllers: [OAuthController, LoginController, LandingController, FirstPartyLoginController],
			providers: [
				{
					provide: FirstPartyClientSeeder,
					inject: [STORE, AUTHORIZATION_PUBLIC_BASE_URL_TOKEN, APP_LOGGER_TOKEN],
					useFactory: (store: AuthorizationStoreRepository, baseUrl: string, logger: AppLogger) =>
						new FirstPartyClientSeeder(store, `${baseUrl.replace(/\/+$/, "")}/login/callback`, logger)
				},
				{
					provide: AuthorizationAuditGateway,
					useFactory: (logger: AppLogger) => new AuthorizationAuditGateway(logger),
					inject: [APP_LOGGER_TOKEN]
				},
				{
					provide: RevokeSessionCommand,
					useFactory: (store: AuthorizationStoreRepository) => new RevokeSessionCommand(store),
					inject: [STORE]
				},
				{
					provide: PurgeExpiredSessionsCommand,
					useFactory: (store: AuthorizationStoreRepository) => new PurgeExpiredSessionsCommand(store),
					inject: [STORE]
				},
				{
					provide: STORE,
					useFactory: (pool: AuthorizationSqlExecutor) => new PostgresAuthorizationStoreRepository(pool),
					inject: [PG_POOL_TOKEN]
				},
				{
					provide: AUTHORIZATION_RATE_LIMITER_TOKEN,
					useFactory: (app: AppConfig) =>
						new InMemoryFixedWindowRateLimiter({
							buckets: Object.fromEntries(
								rateLimitRules(authorizationRateLimits(app.authorization)).map((rule) => [
									rule.route,
									{ limit: rule.limit, windowSeconds: rule.windowSeconds }
								])
							)
						}),
					inject: [APP_CONFIG_TOKEN]
				},
				{
					provide: AUTHORIZATION_PUBLIC_BASE_URL_TOKEN,
					useFactory: (app: AppConfig) => app.authorization.publicBaseUrl,
					inject: [APP_CONFIG_TOKEN]
				},
				{
					provide: GATEWAY,
					useFactory: (app: AppConfig): DiscordOAuthGateway =>
						settings.gateway ??
						new HttpDiscordOAuthGateway({
							clientId: app.authorization.discordClientId,
							clientSecret: app.authorization.discordClientSecret,
							redirectUri: `${app.authorization.publicBaseUrl}/oauth/discord/callback`,
							fetch: globalThis.fetch
						}),
					inject: [APP_CONFIG_TOKEN]
				},
				{
					provide: RequireCurrentMembershipQuery,
					useFactory: (status: GetGuildStateStatusQuery, membership: GetMembershipStatusQuery) =>
						new RequireCurrentMembershipQuery({ status, membership }),
					inject: [GUILD_STATE_STATUS_QUERY_TOKEN, GUILD_STATE_MEMBERSHIP_STATUS_QUERY_TOKEN]
				},
				{
					provide: GetAuthorizationServerMetadataQuery,
					useFactory: (base: string) => new GetAuthorizationServerMetadataQuery(base),
					inject: [AUTHORIZATION_PUBLIC_BASE_URL_TOKEN]
				},
				{
					provide: RegisterClientCommand,
					useFactory: (store: AuthorizationStoreRepository) => new RegisterClientCommand(store),
					inject: [STORE]
				},
				{
					provide: BeginLoginCommand,
					useFactory: (store: AuthorizationStoreRepository, app: AppConfig) =>
						new BeginLoginCommand({
							store,
							publicBaseUrl: app.authorization.publicBaseUrl,
							discordClientId: app.authorization.discordClientId
						}),
					inject: [STORE, APP_CONFIG_TOKEN]
				},
				{
					provide: CompleteLoginCommand,
					useFactory: (
						store: AuthorizationStoreRepository,
						gateway: DiscordOAuthGateway,
						gate: RequireCurrentMembershipQuery,
						audit: AuthorizationAuditGateway
					) => new CompleteLoginCommand({ store, gateway, gate, audit }),
					inject: [STORE, GATEWAY, RequireCurrentMembershipQuery, AuthorizationAuditGateway]
				},
				{
					provide: ExchangeAuthorizationCodeCommand,
					useFactory: (
						store: AuthorizationStoreRepository,
						gate: RequireCurrentMembershipQuery,
						app: AppConfig,
						audit: AuthorizationAuditGateway
					) =>
						new ExchangeAuthorizationCodeCommand({
							store,
							gate,
							audit,
							sessionTtlSeconds: app.authorization.sessionTtlSeconds
						}),
					inject: [STORE, RequireCurrentMembershipQuery, APP_CONFIG_TOKEN, AuthorizationAuditGateway]
				},
				{
					provide: AuthenticateSessionQuery,
					useFactory: (store: AuthorizationStoreRepository, gate: RequireCurrentMembershipQuery) =>
						new AuthenticateSessionQuery({ store, gate }),
					inject: [STORE, RequireCurrentMembershipQuery]
				},
				{
					provide: RotateRefreshTokenCommand,
					useFactory: (
						store: AuthorizationStoreRepository,
						gate: RequireCurrentMembershipQuery,
						app: AppConfig,
						audit: AuthorizationAuditGateway
					) =>
						new RotateRefreshTokenCommand({
							store,
							gate,
							audit,
							sessionTtlSeconds: app.authorization.sessionTtlSeconds
						}),
					inject: [STORE, RequireCurrentMembershipQuery, APP_CONFIG_TOKEN, AuthorizationAuditGateway]
				},
				{
					provide: McpAuthenticationGuard,
					useFactory: (query: AuthenticateSessionQuery, base: string, logger: AppLogger) =>
						new McpAuthenticationGuard(query, base, logger),
					inject: [AuthenticateSessionQuery, AUTHORIZATION_PUBLIC_BASE_URL_TOKEN, APP_LOGGER_TOKEN]
				},
				{
					provide: RevokeUserSessionsCommand,
					useFactory: (store: AuthorizationStoreRepository, logger: AppLogger) =>
						new RevokeUserSessionsCommand({ store, logger }),
					inject: [STORE, APP_LOGGER_TOKEN]
				},
				{
					provide: MembershipEndSubscription,
					useFactory: (
						events: DiscordEventConsumer,
						revoke: RevokeUserSessionsCommand,
						config: DiscordConfig
					) => new MembershipEndSubscription({ events, revoke, guildId: config.guildId }),
					inject: [DISCORD_EVENT_STREAM_TOKEN, RevokeUserSessionsCommand, DISCORD_CONFIG_TOKEN]
				}
			],
			exports: [
				AuthenticateSessionQuery,
				GetAuthorizationServerMetadataQuery,
				McpAuthenticationGuard,
				AUTHORIZATION_PUBLIC_BASE_URL_TOKEN
			]
		};
	}
}
