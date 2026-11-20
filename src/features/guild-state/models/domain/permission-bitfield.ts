import { InvalidPermissionBitfieldError } from "./guild-state-registry.errors.js";

/**
 * A Discord permission bitfield exactly as Discord encodes it: a decimal string in `allowed` / `denied` /
 * `permissions` fields, stored in a `text` column (docs/features/guild-state.md R3, R6).
 *
 * The type is a string *alias*, not a number, on purpose. `Number("9007199254740993")` is
 * `9007199254740992`: a bitfield coerced to a JavaScript number loses the highest permission bit silently,
 * which is the exact defect R3 names. Nothing in this feature parses one except the two conversions below.
 *
 * The open decision this comment used to record (docs/adr/0005, O2) is decided, by T7: evaluation works in
 * `BigInt`, and the text form crosses the boundary at exactly two points — {@link toPermissionBits} on the
 * way into a derivation and {@link fromPermissionBits} on the way out. No intermediate value is ever a JS
 * number, so a bit above 2^53 survives every stage of the derivation and the caller gets back the exact
 * decimal text Discord would have sent.
 */
export type PermissionBitfield = string;

/** Discord sends unsigned decimal; a signed, spaced or hexadecimal value is not that encoding. */
const PERMISSION_BITFIELD_PATTERN = /^[0-9]+$/;

/** The empty permission set in Discord's own encoding, used where a row grants nothing. */
export const ZERO_PERMISSION_BITFIELD: PermissionBitfield = "0";

export function isPermissionBitfield(candidate: unknown): candidate is PermissionBitfield {
	return typeof candidate === "string" && PERMISSION_BITFIELD_PATTERN.test(candidate);
}

/** Narrows a value on the way into a bitfield column; `field` names the column for the log line (R14). */
export function requirePermissionBitfield(field: string, candidate: unknown): PermissionBitfield {
	if (!isPermissionBitfield(candidate)) {
		throw new InvalidPermissionBitfieldError(field);
	}
	return candidate;
}

/**
 * The one way a stored bitfield becomes a value the evaluation can operate on: `BigInt` of text already
 * validated as Discord's unsigned decimal encoding. A signed, spaced or hexadecimal value is refused rather
 * than widened into something the derivation would half-understand, and a value that arrived as a JS number
 * is refused here too — which is where R3's coercion defect stops.
 */
export function toPermissionBits(field: string, candidate: unknown): bigint {
	return BigInt(requirePermissionBitfield(field, candidate));
}

/** The one way a derived bit set leaves the domain: the exact decimal text, no `Number`, no padding. */
export function fromPermissionBits(bits: bigint): PermissionBitfield {
	if (bits < 0n) {
		// Clearing bits with `~deny` cannot turn a non-negative set negative, so a negative value here is an
		// arithmetic bug rather than bad data. Rendering it would sign a field Discord never signs.
		throw new InvalidPermissionBitfieldError("effective_permission_bits");
	}
	return bits.toString();
}
