import { describe, expect, it } from "vitest";
import {
	DEFAULT_MESSAGE_STORE_BOUNDS,
	createIngestionConfig
} from "../../../src/features/ingestion/config/ingestion-config.interface.js";
import {
	InvalidMessageBatchError,
	InvalidMessageIdentifierError
} from "../../../src/features/ingestion/models/domain/ingestion-store.errors.js";

/**
 * The feature's own composition input (docs/features/ingestion.md R1, R3; docs/architecture/shared.md:
 * configuration is validated once at startup, never read ad hoc from the environment). Nothing in the store
 * reads a `process.env`, so what this validator refuses is the only protection a misconfigured deployment
 * gets — and the bounds it produces are the bounds every batch statement in the repository obeys.
 *
 * Two facts are pinned because a later task depends on them rather than because they are obvious: the Guild id
 * arrives already validated from the `discord` feature but is checked again here, so a message store can never
 * be scoped to a Guild the connection is not serving (R1); and a tightened batch is clamped to the repository
 * ceiling instead of being honoured literally.
 */

const GUILD_ID = "160000000000000001";

describe("ingestion configuration — the Guild the store is scoped to (R1)", () => {
	it("accepts the configured Guild id and keeps it as the string every statement binds", () => {
		const config = createIngestionConfig({ guildId: GUILD_ID });

		expect(config.guildId).toBe(GUILD_ID);
		expect(typeof config.guildId).toBe("string");
	});

	it("refuses a Guild id a `bigint` column cannot hold instead of building an unscopeable store", () => {
		// A malformed id here is not a cosmetic problem: every read, tombstone and exclusion in the feature is
		// guild-scoped by this value, so a wrong one silently scopes nothing.
		expect(() => createIngestionConfig({ guildId: "160000000000000001 " })).toThrow(InvalidMessageIdentifierError);
		expect(() => createIngestionConfig({ guildId: "9223372036854775808" })).toThrow(/out-of-bigint-range/);
		expect(() => createIngestionConfig({ guildId: "" })).toThrow(/ingestion\.guild_id/);
	});
});

describe("ingestion configuration — the bounds every write obeys", () => {
	it("keeps the declared defaults when a deployment names no bounds", () => {
		const config = createIngestionConfig({ guildId: GUILD_ID });

		expect(config.store).toEqual(DEFAULT_MESSAGE_STORE_BOUNDS);
		expect(config.store.writeBatchSize).toBeGreaterThan(0);
		expect(config.store.exclusionPageSize).toBeGreaterThan(0);
	});

	it("keeps the defaults a partial block does not name, so tightening one bound cannot erase the other", () => {
		expect(createIngestionConfig({ guildId: GUILD_ID, store: { writeBatchSize: 50 } }).store).toEqual({
			writeBatchSize: 50,
			exclusionPageSize: DEFAULT_MESSAGE_STORE_BOUNDS.exclusionPageSize
		});
		expect(createIngestionConfig({ guildId: GUILD_ID, store: { exclusionPageSize: 25 } }).store).toEqual({
			writeBatchSize: DEFAULT_MESSAGE_STORE_BOUNDS.writeBatchSize,
			exclusionPageSize: 25
		});
	});

	it("clamps a raised batch to the repository ceiling rather than honouring it literally", () => {
		const config = createIngestionConfig({ guildId: GUILD_ID, store: { writeBatchSize: 100_000 } });

		// The ceiling is what keeps one statement's array parameter bounded (docs/architecture/persistence.md).
		expect(config.store.writeBatchSize).toBe(1_000);
	});

	it("refuses a bound that is not a positive whole number, naming the setting that broke", () => {
		for (const writeBatchSize of [0, -1, 1.5, Number.NaN]) {
			expect(() => createIngestionConfig({ guildId: GUILD_ID, store: { writeBatchSize } })).toThrow(
				InvalidMessageBatchError
			);
		}
		// The exclusion page has no ceiling to clamp to, so a nonsense value is a refusal, not a default.
		expect(() => createIngestionConfig({ guildId: GUILD_ID, store: { exclusionPageSize: 0 } })).toThrow(
			/store\.exclusionPageSize/
		);
		expect(() => createIngestionConfig({ guildId: GUILD_ID, store: { exclusionPageSize: Number.NaN } })).toThrow(
			InvalidMessageBatchError
		);
	});
});
