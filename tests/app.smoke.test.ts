/**
 * Nest module smoke test (docs/architecture/testing.md: "Providers resolve and a real handler
 * instance is wired"). It composes the real application module, so a broken wiring in
 * `src/app.module.ts` or any shared module fails here rather than only at deploy time.
 *
 * No persistent listening server: the HTTP server is bound to an ephemeral port on the loopback
 * interface for the duration of one test and released in `afterEach`. `src/main.ts` is never run, so
 * nothing occupies the configured `APP_PORT`.
 *
 * No database access: `DATABASE_URL` is required by the validated configuration, but the managed pg
 * pool opens no connection until a query runs (see `createPgPool`), and this suite runs none. The
 * value below is deliberately unreachable so that an accidental query fails loudly instead of
 * touching somebody's database.
 */

import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import type { AppConfig } from "../src/shared/config/app-config.interface.js";
import { APP_CONFIG_TOKEN } from "../src/shared/config/config.tokens.js";
import { HealthController } from "../src/shared/http/health.controller.js";
import type { AppLogger } from "../src/shared/logging/logger.interface.js";
import { APP_LOGGER_TOKEN } from "../src/shared/logging/logging.tokens.js";
import type { Pool } from "pg";
import { PG_POOL_TOKEN } from "../src/shared/persistence/persistence.tokens.js";

const TEST_DATABASE_URL = "postgresql://smoke-test:smoke-test@127.0.0.1:1/smoke-test-unused";

const ENVIRONMENT_KEYS = [
	"DATABASE_URL",
	"APP_PORT",
	"LOG_LEVEL",
	"DISCORD_CLIENT_ID",
	"DISCORD_CLIENT_SECRET",
	"PUBLIC_BASE_URL",
	"SESSION_TTL_SECONDS",
	"AUTHORIZATION_LOCAL_DEVELOPMENT"
] as const;

describe("application composition smoke test", () => {
	const originalEnvironment = new Map<string, string | undefined>();
	let application: INestApplication | undefined;
	let server: Server | undefined;

	beforeAll(() => {
		for (const key of ENVIRONMENT_KEYS) {
			originalEnvironment.set(key, process.env[key]);
		}

		process.env["DATABASE_URL"] = TEST_DATABASE_URL;
		process.env["DISCORD_CLIENT_ID"] = "fixture";
		process.env["DISCORD_CLIENT_SECRET"] = "fixture";
		process.env["PUBLIC_BASE_URL"] = "https://hub.example";
		process.env["SESSION_TTL_SECONDS"] = "300";
		delete process.env["AUTHORIZATION_LOCAL_DEVELOPMENT"];
		// Left unset on purpose: the documented defaults (port 3000, level info) must apply on their own.
		delete process.env["APP_PORT"];
		delete process.env["LOG_LEVEL"];
	});

	afterAll(() => {
		for (const [key, value] of originalEnvironment) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	afterEach(async () => {
		const currentApplication = application;
		const currentServer = server;
		application = undefined;
		server = undefined;

		await currentApplication?.close();
		if (currentServer !== undefined && currentServer.listening) {
			await new Promise<void>((resolveClose) => currentServer.close(() => resolveClose()));
		}
	});

	it("resolves the composed application and answers GET /health with 200", async () => {
		const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
		application = moduleRef.createNestApplication();
		// Same as bootstrap: termination hooks must run so the managed pool is closed.
		application.enableShutdownHooks();
		await application.init();

		// Providers resolve to real wired instances through their explicit tokens.
		expect(application.get(HealthController)).toBeInstanceOf(HealthController);
		expect(application.get<AppConfig>(APP_CONFIG_TOKEN).database.url).toBe(TEST_DATABASE_URL);
		expect(application.get<AppLogger>(APP_LOGGER_TOKEN).info).toBeTypeOf("function");
		expect(application.get<Pool>(PG_POOL_TOKEN)).toBeDefined();

		server = application.getHttpServer() as Server;
		await new Promise<void>((resolveListen) => server?.listen(0, "127.0.0.1", resolveListen));
		const { port } = server.address() as AddressInfo;

		const response = await fetch(`http://127.0.0.1:${port}/health`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});
});
