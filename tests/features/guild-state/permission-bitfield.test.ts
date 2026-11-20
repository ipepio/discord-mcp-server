import { describe, expect, it } from "vitest";
import {
	ZERO_PERMISSION_BITFIELD,
	isPermissionBitfield,
	requirePermissionBitfield
} from "../../../src/features/guild-state/models/domain/permission-bitfield.js";
import { InvalidPermissionBitfieldError } from "../../../src/features/guild-state/models/domain/guild-state-registry.errors.js";

/**
 * R3 — the bitfield rule. Discord encodes permissions as an unsigned decimal *string*, and the registry
 * stores that exact text: a bitfield can exceed the JavaScript safe-integer range, so coercion is not a
 * rounding problem but a silent loss of the highest permissions. These tests pin the shape the column
 * (`permissions_bitfield ~ '^[0-9]+$'`, `migrations/1_guild_state_registry.ts`) will accept, and prove the
 * domain refuses anything else before a statement is ever assembled.
 */

const A_REAL_SNOWFLAKE_SIZED_BITFIELD = "9223372036854775808"; // 2^63: beyond `bigint` range as a number
const EVERY_PERMISSION_BITFIELD = "18014398509481983";

describe("permission bitfield — accepted shape (R3)", () => {
	it("accepts Discord's own unsigned decimal text", () => {
		expect(isPermissionBitfield("0")).toBe(true);
		expect(isPermissionBitfield("1")).toBe(true);
		expect(isPermissionBitfield("1024")).toBe(true);
		expect(isPermissionBitfield(EVERY_PERMISSION_BITFIELD)).toBe(true);
	});

	it("accepts values no JavaScript number could hold, unchanged (R3)", () => {
		expect(isPermissionBitfield(A_REAL_SNOWFLAKE_SIZED_BITFIELD)).toBe(true);
		// The exactness the rule promises: the text round-trips with no digit lost...
		expect(requirePermissionBitfield("guild_role.permissions_bitfield", A_REAL_SNOWFLAKE_SIZED_BITFIELD)).toBe(
			A_REAL_SNOWFLAKE_SIZED_BITFIELD
		);
		// ...whereas the coercion R3 forbids would silently drop the low bit.
		expect(String(Number("9007199254740993"))).toBe("9007199254740992");
	});

	it("names the empty permission set in Discord's own encoding", () => {
		expect(ZERO_PERMISSION_BITFIELD).toBe("0");
		expect(isPermissionBitfield(ZERO_PERMISSION_BITFIELD)).toBe(true);
	});
});

describe("permission bitfield — rejected shape (R3)", () => {
	it("refuses anything that is not Discord's decimal text", () => {
		for (const candidate of ["", " 0", "0 ", "-1", "+1", "1.0", "1e3", "0x10", "1_000", "abc", "12,34"]) {
			expect(isPermissionBitfield(candidate), candidate).toBe(false);
		}
	});

	it("refuses non-strings, including a number that would have been the coercion", () => {
		for (const candidate of [0, 1024, Number(EVERY_PERMISSION_BITFIELD), null, undefined, {}, [], true]) {
			expect(isPermissionBitfield(candidate), String(candidate)).toBe(false);
		}
	});

	it("throws the named error and carries the column, not the payload (R14)", () => {
		const failure = new InvalidPermissionBitfieldError("guild_role.permissions_bitfield");
		expect(() => requirePermissionBitfield("guild_role.permissions_bitfield", "-1")).toThrow(
			InvalidPermissionBitfieldError
		);
		expect(() => requirePermissionBitfield("channel_permission_overwrite.allow_bitfield", "nope")).toThrow(
			"channel_permission_overwrite.allow_bitfield"
		);
		// The rejected value never reaches the message: an anomaly names the field and the reason only.
		expect(failure.message).not.toContain("-1");
		expect(failure.field).toBe("guild_role.permissions_bitfield");
		expect(failure.name).toBe("InvalidPermissionBitfieldError");
	});

	it("returns the same text it was given rather than a normalized one (no merge, no reformat)", () => {
		const given = "0001024";
		expect(requirePermissionBitfield("guild_role.permissions_bitfield", given)).toBe(given);
	});
});
