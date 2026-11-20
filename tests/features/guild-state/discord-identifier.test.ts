import { describe, expect, it } from "vitest";
import {
	isDiscordIdentifier,
	requireDiscordIdentifier
} from "../../../src/features/guild-state/models/domain/discord-identifier.js";
import { InvalidDiscordIdentifierError } from "../../../src/features/guild-state/models/domain/guild-state-registry.errors.js";

/**
 * R9 — Discord ids are the registry's natural keys, carried as strings and stored in `bigint` columns.
 * Two separate failures are being prevented: a snowflake widened into a JavaScript number loses digits,
 * and a value wider than `bigint` would fail somewhere inside a PostgreSQL cast instead of at the
 * contract. The range test is done on the text, so no comparison here needs a numeric coercion either.
 */

const BIGINT_MAX = "9223372036854775807";

describe("discord identifier — accepted shape (R9)", () => {
	it("accepts a snowflake-shaped decimal string", () => {
		expect(isDiscordIdentifier("1")).toBe(true);
		expect(isDiscordIdentifier("123456789012345678")).toBe(true);
		expect(isDiscordIdentifier(BIGINT_MAX)).toBe(true);
	});

	it("passes the exact text through, which is what a natural key must do", () => {
		const id = "123456789012345678";
		expect(requireDiscordIdentifier("guild_role.role_id", id)).toBe(id);
	});
});

describe("discord identifier — rejected shape (R9, R1)", () => {
	it("refuses non-strings, so a widened id cannot enter the registry", () => {
		for (const candidate of [1, 123456789012345678n, Number.MAX_SAFE_INTEGER, null, undefined, {}, [], ""]) {
			expect(isDiscordIdentifier(candidate), String(candidate)).toBe(false);
		}
		expect(() => requireDiscordIdentifier("guild.guild_id", 123_456)).toThrow(InvalidDiscordIdentifierError);
	});

	it("refuses text that is not a plain positive decimal", () => {
		for (const candidate of ["0", "007", "-1", "+1", "1e18", "1_000", " 12", "abc", "9223372036854775808"]) {
			expect(isDiscordIdentifier(candidate), candidate).toBe(false);
		}
	});

	it("names the reason the write failed, without echoing the value (R14)", () => {
		expect(() => requireDiscordIdentifier("channel.channel_id", 7)).toThrowError(
			expect.objectContaining({ reason: "not-a-string", field: "channel.channel_id" })
		);
		expect(() => requireDiscordIdentifier("channel.channel_id", "0")).toThrowError(
			expect.objectContaining({ reason: "not-decimal" })
		);
		expect(() => requireDiscordIdentifier("channel.channel_id", "99999999999999999999")).toThrowError(
			expect.objectContaining({ reason: "out-of-bigint-range" })
		);
	});

	it("draws the bigint line at the boundary, compared as text (no precision loss in the guard)", () => {
		expect(isDiscordIdentifier(BIGINT_MAX)).toBe(true);
		expect(isDiscordIdentifier("9223372036854775808")).toBe(false);
		expect(isDiscordIdentifier(`${BIGINT_MAX}9`)).toBe(false);
	});

	it("reports the field that was rejected, so an anomaly is attributable", () => {
		let caught: unknown;
		try {
			requireDiscordIdentifier("thread_membership.user_id", "nope");
		} catch (failure) {
			caught = failure;
		}
		expect(caught).toBeInstanceOf(InvalidDiscordIdentifierError);
		expect((caught as InvalidDiscordIdentifierError).field).toBe("thread_membership.user_id");
		expect((caught as InvalidDiscordIdentifierError).name).toBe("InvalidDiscordIdentifierError");
	});
});
