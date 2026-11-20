import { describe, expect, it } from "vitest";
import { InvalidMessageIdentifierError } from "../../../src/features/ingestion/models/domain/ingestion-store.errors.js";
import {
	isDiscordIdentifier,
	requireDiscordIdentifier,
	requireSizeBytes
} from "../../../src/features/ingestion/models/domain/discord-identifier.js";

/**
 * The identifier guard every message-store write passes through (docs/architecture/persistence.md: Discord
 * snowflakes are stored as `bigint` and carried as strings). The rule is worth pinning exactly because a wrong
 * id is not a crash but a silently different row: a number coercion of a 19-digit snowflake changes the id, and
 * a padded string would break the equality that idempotency, tombstones and reply references all depend on.
 *
 * This is ingestion's own copy of the rule because the `discord` feature's predicate and guild-state's module are
 * internal to those features; the accepts and refuses below are the same set guild-state pins, and for the same
 * reason.
 */

describe("ingestion Discord identifier guard", () => {
	it("accepts a real snowflake, a one-digit id and the largest value a bigint column holds", () => {
		expect(isDiscordIdentifier("160000000000000001")).toBe(true);
		expect(isDiscordIdentifier("1")).toBe(true);
		expect(isDiscordIdentifier("9223372036854775807")).toBe(true);
	});

	it("refuses anything a bigint column cannot hold, naming the reason (R9)", () => {
		expect(isDiscordIdentifier("")).toBe(false);
		expect(isDiscordIdentifier("0")).toBe(false);
		expect(isDiscordIdentifier("0160000000000000001")).toBe(false);
		expect(isDiscordIdentifier("-160000000000000001")).toBe(false);
		expect(isDiscordIdentifier("1.5")).toBe(false);
		expect(isDiscordIdentifier("160000000000000001n")).toBe(false);
		expect(isDiscordIdentifier("9223372036854775808")).toBe(false);
		expect(isDiscordIdentifier("99999999999999999999")).toBe(false);
		expect(isDiscordIdentifier("16000000000000000e1")).toBe(false);
	});

	it("refuses a value that is not a string at all instead of coercing it", () => {
		for (const candidate of [160000000000000000, Number("160000000000000001"), null, undefined, {}]) {
			expect(isDiscordIdentifier(candidate)).toBe(false);
		}
	});

	it("narrows a storable id and returns the same string, unchanged", () => {
		const messageId = "160000000000000401";
		expect(requireDiscordIdentifier("message.message_id", messageId)).toBe(messageId);
	});

	it("throws a named error carrying the column and the reason, never the payload", () => {
		expect(() => requireDiscordIdentifier("message.author_id", 42)).toThrow(InvalidMessageIdentifierError);
		expect(() => requireDiscordIdentifier("message.author_id", 42)).toThrow(/message\.author_id/);
		expect(() => requireDiscordIdentifier("message.author_id", 42)).toThrow(/not-a-string/);
		expect(() => requireDiscordIdentifier("message.guild_id", "0123")).toThrow(/not-decimal/);
		expect(() => requireDiscordIdentifier("message.channel_id", "9223372036854775808")).toThrow(
			/out-of-bigint-range/
		);
	});
});

describe("ingestion attachment size conversion", () => {
	it("reads a `bigint` column's text back as the same whole number (R11)", () => {
		expect(requireSizeBytes("message_attachment.size_bytes", "1048576")).toBe(1_048_576);
		expect(requireSizeBytes("message_attachment.size_bytes", 0)).toBe(0);
	});

	it("refuses a size it cannot represent exactly instead of rounding it", () => {
		expect(() => requireSizeBytes("message_attachment.size_bytes", "9007199254740993")).toThrow(
			/out-of-safe-integer-range/
		);
		expect(() => requireSizeBytes("message_attachment.size_bytes", "1.5")).toThrow(/not-a-whole-number/);
		expect(() => requireSizeBytes("message_attachment.size_bytes", null)).toThrow(/not-a-whole-number/);
	});
});
