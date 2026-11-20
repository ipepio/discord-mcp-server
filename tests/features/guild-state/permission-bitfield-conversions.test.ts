import { describe, expect, it } from "vitest";
import { InvalidPermissionBitfieldError } from "../../../src/features/guild-state/models/domain/guild-state-registry.errors.js";
import {
	fromPermissionBits,
	requirePermissionBitfield,
	toPermissionBits
} from "../../../src/features/guild-state/models/domain/permission-bitfield.js";

/**
 * The two conversions T7 added to the bitfield module, and the decision they embody (docs/features/
 * guild-state.md R3; docs/adr/0005 O2, decided by T7): evaluation runs in `BigInt`, text crosses the
 * boundary here and nowhere else. `requirePermissionBitfield` keeps the storage rule; these two keep the
 * arithmetic rule, in one direction each.
 */

describe("toPermissionBits — the only way in (R3)", () => {
	it("reads Discord's unsigned decimal text exactly", () => {
		expect(toPermissionBits("guild_role.permissions_bitfield", "0")).toBe(0n);
		expect(toPermissionBits("guild_role.permissions_bitfield", "1024")).toBe(1024n);
		expect(toPermissionBits("channel_permission_overwrite.allow_bitfield", "4503599627370496")).toBe(2n ** 52n);
	});

	it("keeps a value above Number.MAX_SAFE_INTEGER whole instead of rounding it", () => {
		const text = "9007199254740993"; // 2^53 + 1, the exact case R3 names.
		expect(toPermissionBits("guild_role.permissions_bitfield", text)).toBe(2n ** 53n + 1n);
		// The contrast is the defect: the same text through Number loses the low bit.
		expect(Number(text)).toBe(9007199254740992);
	});

	it("refuses anything Discord did not send, rather than widening it", () => {
		for (const candidate of ["-1", "+8", " 8", "0x400", "", "1e3", "NaN"]) {
			expect(() => toPermissionBits("guild_role.permissions_bitfield", candidate), candidate).toThrow(
				InvalidPermissionBitfieldError
			);
		}
	});

	it("refuses a value that arrived as a JavaScript number, where the damage is already done (R3)", () => {
		expect(() => toPermissionBits("guild_role.permissions_bitfield", 1024)).toThrow(InvalidPermissionBitfieldError);
		expect(() => toPermissionBits("guild_role.permissions_bitfield", null)).toThrow(InvalidPermissionBitfieldError);
	});
});

describe("fromPermissionBits — the only way out (R3)", () => {
	it("renders the exact decimal text, with no sign, padding or exponent", () => {
		expect(fromPermissionBits(0n)).toBe("0");
		expect(fromPermissionBits(1024n | 65536n)).toBe("66560");
		expect(fromPermissionBits(2n ** 53n + 1n)).toBe("9007199254740993");
	});

	it("round-trips every documented magnitude without loss", () => {
		for (const text of ["0", "8", "1024", "3377699720527872", "4503599627370496", "9007199254740993"]) {
			expect(fromPermissionBits(toPermissionBits("guild_role.permissions_bitfield", text))).toBe(text);
		}
	});

	it("refuses a negative result, because that is an arithmetic bug and not a permission set", () => {
		expect(() => fromPermissionBits(~0n)).toThrow(InvalidPermissionBitfieldError);
		expect(() => fromPermissionBits(-1n)).toThrow(InvalidPermissionBitfieldError);
	});

	it("stays the validator the storage path already was", () => {
		expect(requirePermissionBitfield("guild_role.permissions_bitfield", fromPermissionBits(2n ** 52n))).toBe(
			"4503599627370496"
		);
	});
});
