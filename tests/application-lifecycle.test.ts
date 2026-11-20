import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { ApplicationLifecycle } from "../src/application-lifecycle.js";
import type { ApplicationLifecycleDependencies } from "../src/application-lifecycle.js";
import { PgPoolShutdown } from "../src/shared/persistence/pg-pool.shutdown.js";
import { PG_POOL_TOKEN } from "../src/shared/persistence/persistence.tokens.js";
import type { DiscordEventHandler } from "../src/features/discord/index.js";
import { DiscordEventKind } from "../src/features/discord/index.js";

describe("application lifecycle", () => {
	it("subscribes guild state before ingestion, imports outside delivery, drains before pool close", async () => {
		const calls: string[] = [];
		const subscribe = vi.fn().mockImplementation(() => {
			calls.push("import-subscribe");
			return {
				unsubscribe: () => {
					calls.push("import-unsubscribe");
				}
			};
		});
		let finishImport!: () => void;
		const importWork = new Promise<void>((resolve) => {
			finishImport = resolve;
		});
		// Held in an object so the assertion below reads the listener the lifecycle bound, not a value TypeScript
		// narrowed at the assignment above.
		const accessListener: { current: ((channelId: string) => void) | null } = { current: null };
		let backfillSettled = false;
		let finishBackfill!: () => void;
		const backfillWork = new Promise<void>((resolve) => {
			finishBackfill = resolve;
		});
		const accessBackfill = {
			execute: vi.fn(async () => {
				calls.push("access-backfill");
				await backfillWork;
				backfillSettled = true;
			})
		};
		const deps: ApplicationLifecycleDependencies = {
			guildState: {
				subscribe: () => {
					calls.push("guild-subscribe");
				},
				unsubscribe: () => {
					calls.push("guild-unsubscribe");
				}
			},
			ingestion: {
				subscribe: () => {
					calls.push("ingestion-subscribe");
				},
				unsubscribe: () => {
					calls.push("ingestion-unsubscribe");
				}
			},
			events: { subscribe },
			connection: {
				start: async () => {
					calls.push("start");
				}
			},
			shutdown: {
				shutdown: async () => {
					calls.push("stop-intake");
					await Promise.resolve();
					calls.push("bounded-drain");
					calls.push("socket-close");
				}
			},
			history: {
				execute: vi.fn(async () => {
					calls.push("import");
					await importWork;
				})
			},
			accessGained: {
				bind: (listener) => {
					calls.push("access-bind");
					accessListener.current = listener;
				},
				unbind: () => {
					calls.push("access-unbind");
					accessListener.current = null;
				}
			},
			accessBackfill,
			botUserId: "7",
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: vi.fn() }
		};
		const module = await Test.createTestingModule({
			providers: [
				{ provide: ApplicationLifecycle, useFactory: () => new ApplicationLifecycle(deps) },
				PgPoolShutdown,
				{
					provide: PG_POOL_TOKEN,
					useValue: {
						end: async () => {
							calls.push("pool-close");
						}
					}
				}
			]
		}).compile();
		expect(calls).toEqual([]);
		await module.init();
		expect(calls).toEqual([
			"guild-subscribe",
			"ingestion-subscribe",
			"access-bind",
			"import-subscribe",
			"import",
			"start"
		]);
		const trigger: DiscordEventHandler<typeof DiscordEventKind.resyncNeeded> = subscribe.mock.calls[0]![1];
		const event = {
			kind: DiscordEventKind.resyncNeeded,
			guildId: "1",
			epoch: 1,
			reconnectAttempts: 0
		};
		// The bootstrap run owns the import, so a signal that arrives while it is in flight starts nothing else.
		await trigger(event);
		expect(calls.at(-1)).toBe("start");
		await trigger(event);
		expect(deps.history.execute).toHaveBeenCalledTimes(1);
		expect(deps.history.execute).toHaveBeenCalledWith({ botUserId: "7" });
		finishImport();

		// The gained-access listener starts the one-channel backfill on its own promise: the registry's event
		// application returned before a single history page was read (S5).
		accessListener.current?.("160000000000000201");
		expect(accessBackfill.execute).toHaveBeenCalledWith({ channelId: "160000000000000201" });
		expect(backfillSettled).toBe(false);
		finishBackfill();
		await backfillWork;
		expect(backfillSettled).toBe(true);

		await module.close();
		expect(calls.slice(-8)).toEqual([
			"stop-intake",
			"bounded-drain",
			"socket-close",
			"import-unsubscribe",
			"access-unbind",
			"ingestion-unsubscribe",
			"guild-unsubscribe",
			"pool-close"
		]);
		expect(accessListener.current).toBeNull();
	});

	it("lifecycle-starts-import-at-bootstrap: the import starts once at bootstrap and a resync signal cannot overlap it", async () => {
		let finishImport!: () => void;
		const importWork = new Promise<void>((resolve) => {
			finishImport = resolve;
		});
		const history = {
			execute: vi.fn(async (): Promise<void> => {
				await importWork;
			})
		};
		const subscribe = vi.fn().mockReturnValue({ unsubscribe: () => {} });
		const idle = vi.fn();
		const deps: ApplicationLifecycleDependencies = {
			guildState: { subscribe: idle, unsubscribe: idle },
			ingestion: { subscribe: idle, unsubscribe: idle },
			events: { subscribe },
			connection: { start: async () => {} },
			shutdown: { shutdown: async () => {} },
			history,
			accessGained: { bind: vi.fn(), unbind: vi.fn() },
			accessBackfill: { execute: vi.fn(async () => {}) },
			botUserId: "7",
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: vi.fn() }
		};
		const lifecycle = new ApplicationLifecycle(deps);
		expect(history.execute).not.toHaveBeenCalled();
		// Bootstrap returns without waiting for the import: the local `finishImport` is only called afterwards.
		await lifecycle.onApplicationBootstrap();
		expect(history.execute).toHaveBeenCalledTimes(1);
		expect(history.execute).toHaveBeenCalledWith({ botUserId: "7" });
		const trigger: DiscordEventHandler<typeof DiscordEventKind.resyncNeeded> = subscribe.mock.calls[0]![1];
		const signal = { kind: DiscordEventKind.resyncNeeded, guildId: "1", epoch: 1, reconnectAttempts: 0 };
		// A reconnect signal delivered while the bootstrap run is still in flight starts no second run.
		await trigger(signal);
		expect(history.execute).toHaveBeenCalledTimes(1);
		finishImport();
		await importWork;
		// Let the finished job release the guard, then prove the reconnect subscription still works afterwards.
		await new Promise((resolve) => setTimeout(resolve, 0));
		await trigger(signal);
		expect(history.execute).toHaveBeenCalledTimes(2);
	});
});
