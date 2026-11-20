import { describe, expect, it } from "vitest";
import {
	DEFAULT_REGISTRY_WRITE_BATCH_SIZE,
	MAX_REGISTRY_WRITE_BATCH_SIZE,
	resolveWriteBatchSize,
	splitWriteBatch
} from "../../../src/features/guild-state/repositories/registry-write-batch.js";
import {
	DEFAULT_GUILD_BOOTSTRAP_BOUNDS,
	createGuildStateConfig
} from "../../../src/features/guild-state/config/guild-state-config.interface.js";
import {
	InvalidDiscordIdentifierError,
	InvalidRegistryBatchError
} from "../../../src/features/guild-state/models/domain/guild-state-registry.errors.js";

/**
 * The bounds persistence.md asks every batch write to declare ("batch writes must declare a page or key
 * bound before execution"), and the configuration that carries them. Rows in a batch become one bound array
 * per column, so the bound is an element count: without it, a roster page of ten thousand members would turn
 * into a single statement of unbounded size, and a replayed page would stop being a no-op (R9).
 */

describe("registry write batch bounds (R2, R9; persistence.md)", () => {
	it("declares a default a caller can read and a ceiling a caller cannot raise past", () => {
		expect(DEFAULT_REGISTRY_WRITE_BATCH_SIZE).toBe(200);
		expect(resolveWriteBatchSize(DEFAULT_REGISTRY_WRITE_BATCH_SIZE)).toBe(DEFAULT_REGISTRY_WRITE_BATCH_SIZE);
		expect(resolveWriteBatchSize(1_000_000)).toBe(MAX_REGISTRY_WRITE_BATCH_SIZE);
		expect(resolveWriteBatchSize(1)).toBe(1);
	});

	it("refuses a bound that is not a positive whole number instead of guessing one", () => {
		for (const configured of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => resolveWriteBatchSize(configured), String(configured)).toThrow(InvalidRegistryBatchError);
		}
	});

	it("splits in input order, with no empty group to write", () => {
		const rows = Array.from({ length: 997 }, (_, index) => index);
		const batches = splitWriteBatch(rows, 200);
		expect(batches.map((batch) => batch.length)).toEqual([200, 200, 200, 200, 197]);
		expect(batches.flat()).toEqual(rows);
		expect(splitWriteBatch([], 200)).toEqual([]);
	});

	it("keeps every group inside the declared bound", () => {
		const rows = Array.from({ length: 5_000 }, (_, index) => `${index + 1}`);
		for (const batch of splitWriteBatch(rows, DEFAULT_REGISTRY_WRITE_BATCH_SIZE)) {
			expect(batch.length).toBeLessThanOrEqual(DEFAULT_REGISTRY_WRITE_BATCH_SIZE);
		}
	});
});

describe("guild-state configuration (R1, R2)", () => {
	it("takes the configured guild id from the discord feature and validates it on the way in", () => {
		const config = createGuildStateConfig({ guildId: "160000000000000001" });
		expect(config.guildId).toBe("160000000000000001");
		expect(() => createGuildStateConfig({ guildId: "not-a-snowflake" })).toThrow(InvalidDiscordIdentifierError);
		expect(() => createGuildStateConfig({ guildId: "0" })).toThrow(InvalidDiscordIdentifierError);
	});

	it("keeps the documented v1 bounds when the deployment names none", () => {
		const { bootstrap } = createGuildStateConfig({ guildId: "160000000000000001" });
		expect(bootstrap).toEqual(DEFAULT_GUILD_BOOTSTRAP_BOUNDS);
		expect(bootstrap.rosterMaxPages).toBe(20);
		expect(bootstrap.writeBatchSize).toBe(DEFAULT_REGISTRY_WRITE_BATCH_SIZE);
	});

	it("lets a deployment tighten one bound without dropping the other (absent is never empty)", () => {
		const { bootstrap } = createGuildStateConfig({
			guildId: "160000000000000001",
			bootstrap: { writeBatchSize: 50 }
		});
		expect(bootstrap.writeBatchSize).toBe(50);
		expect(bootstrap.rosterMaxPages).toBe(DEFAULT_GUILD_BOOTSTRAP_BOUNDS.rosterMaxPages);
	});

	it("clamps an oversized batch and refuses a broken page bound at composition, not mid-bootstrap", () => {
		expect(
			createGuildStateConfig({ guildId: "160000000000000001", bootstrap: { writeBatchSize: 9_999 } }).bootstrap
				.writeBatchSize
		).toBe(MAX_REGISTRY_WRITE_BATCH_SIZE);
		expect(() =>
			createGuildStateConfig({ guildId: "160000000000000001", bootstrap: { rosterMaxPages: 0 } })
		).toThrow(InvalidRegistryBatchError);
		expect(() =>
			createGuildStateConfig({ guildId: "160000000000000001", bootstrap: { rosterMaxPages: 2.5 } })
		).toThrow(InvalidRegistryBatchError);
	});

	it("freezes the shared defaults so no caller can widen a bound by mutating them", () => {
		expect(Object.isFrozen(DEFAULT_GUILD_BOOTSTRAP_BOUNDS)).toBe(true);
	});
});
