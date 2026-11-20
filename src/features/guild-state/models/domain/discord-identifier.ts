import { InvalidDiscordIdentifierError } from "./guild-state-registry.errors.js";

/**
 * A Discord resource id (snowflake) as the registry carries it: a JS **string**, stored in a `bigint`
 * column (docs/features/guild-state.md R9). The string rule is not decoration — the largest snowflakes do
 * not survive `Number`, and a repository that read them as numbers would produce wrong ids in audit rows.
 * `pg` returns `int8` as a string, so the read path is already honest; this predicate guards the write path.
 */
export type DiscordIdentifier = string;

/** Decimal, no sign, no leading zero. Snowflakes are positive and never written with padding. */
const DISCORD_IDENTIFIER_PATTERN = /^[1-9][0-9]*$/;

/** PostgreSQL `bigint` tops out at 2^63-1. Compared as text: the range rule never needs a numeric coercion. */
const BIGINT_MAX_DIGITS = "9223372036854775807";

export function isDiscordIdentifier(candidate: unknown): candidate is DiscordIdentifier {
	if (typeof candidate !== "string" || !DISCORD_IDENTIFIER_PATTERN.test(candidate)) {
		return false;
	}
	if (candidate.length < BIGINT_MAX_DIGITS.length) {
		return true;
	}
	return candidate.length === BIGINT_MAX_DIGITS.length && candidate <= BIGINT_MAX_DIGITS;
}

/**
 * Narrows a value on the way into a registry table. `field` names the column in the log line so an
 * anomaly is attributable without printing the payload (R14).
 */
export function requireDiscordIdentifier(field: string, candidate: unknown): DiscordIdentifier {
	if (typeof candidate !== "string") {
		throw new InvalidDiscordIdentifierError(field, "not-a-string");
	}
	if (!DISCORD_IDENTIFIER_PATTERN.test(candidate)) {
		throw new InvalidDiscordIdentifierError(field, "not-decimal");
	}
	if (!isDiscordIdentifier(candidate)) {
		throw new InvalidDiscordIdentifierError(field, "out-of-bigint-range");
	}
	return candidate;
}
