import { Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";
import type { EnvSource } from "./app-config.interface.js";
import { APP_CONFIG_TOKEN } from "./config.tokens.js";
import { loadAppConfig, readProcessEnv } from "./config.factory.js";

const APP_ENV_SOURCE_TOKEN = "APP_ENV_SOURCE";
@Module({})
class ConfigEnvironmentModule {}

/**
 * Reads the process environment exactly once, at composition time. Every other module receives the
 * validated `AppConfig` through `APP_CONFIG_TOKEN`; direct `process.env` reads elsewhere are
 * forbidden by the architecture rules.
 */
@Module({
	providers: [
		{
			provide: APP_CONFIG_TOKEN,
			useFactory: (env?: EnvSource) => loadAppConfig(env ?? readProcessEnv()),
			inject: [{ token: APP_ENV_SOURCE_TOKEN, optional: true }]
		}
	],
	exports: [APP_CONFIG_TOKEN]
})
export class ConfigModule {
	/** Installs one explicit startup source for every static ConfigModule import, without duplicating
	 * ConfigModule or its providers. The static auxiliary graph retains its process-environment default.
	 */
	public static forRoot(env: EnvSource): DynamicModule {
		return {
			module: ConfigEnvironmentModule,
			global: true,
			providers: [{ provide: APP_ENV_SOURCE_TOKEN, useValue: Object.freeze({ ...env }) }],
			exports: [APP_ENV_SOURCE_TOKEN]
		};
	}
}
