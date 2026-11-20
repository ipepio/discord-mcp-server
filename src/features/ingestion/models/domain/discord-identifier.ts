import { InvalidMessageIdentifierError } from "./ingestion-store.errors.js";

/**
 * A Discord resource id (snowflake) as the message store carries it: a JS **string**, stored in a `bigint`
 * column (docs/features/ingestion.md R9's sibling rule, docs/features/guild-state.md R9,
 * docs/architecture/persistence.md "Discord snowflakes: store as `bigint`, read and write as strings").
 * The string rule is not decoration — the largest snowflakes do not survive `Number`, and a store that read
 * message ids as numbers would produce wrong ids in every log line and every exclusion list.
 *
 * This guard is ingestion's own copy of the rule for a boundary reason, not a duplicate by habit: the
 * `discord` feature's snowflake predicate and guild-state's identifier module are both internal to their
 * features (docs/architecture/structure.md: "Cross-feature calls go through an intentional public use case
 * or contract"), and guild-state set the precedent of each consumer feature owning its own validator.
 * The rule itself is identical, and its unit test pins the same accepts and refuses.
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
 * Narrows a value on the way into a message-store table. `field` names the column so an anomaly is
 * attributable without printing a payload (R12: ids and names are log-safe, message text never is).
 */
export function requireDiscordIdentifier(field: string, candidate: unknown): DiscordIdentifier {
	if (typeof candidate !== "string") {
		throw new InvalidMessageIdentifierError(field, "not-a-string");
	}
	if (!DISCORD_IDENTIFIER_PATTERN.test(candidate)) {
		throw new InvalidMessageIdentifierError(field, "not-decimal");
	}
	if (!isDiscordIdentifier(candidate)) {
		throw new InvalidMessageIdentifierError(field, "out-of-bigint-range");
	}
	return candidate;
}

/**
 * `size_bytes` is a `bigint` column and `MessageAttachmentMetadata.sizeBytes` is a number, so the two
 * representations meet here. `pg` hands `int8` back as text, which is why the read path parses rather than
 * trusts: a value outside the safe integer range is refused loudly instead of silently rounded into a wrong
 * file size (persistence.md: "a `bigint` column arrives as a string unless a parser is registered").
 */
export function requireSizeBytes(field: string, candidate: unknown): number {
	const text = typeof candidate === "number" ? String(candidate) : candidate;
	if (typeof text !== "string" || !/^-?[0-9]+$/.test(text)) {
		throw new InvalidMessageIdentifierError(field, "not-a-whole-number");
	}
	const size = Number(text);
	if (!Number.isSafeInteger(size)) {
		throw new InvalidMessageIdentifierError(field, "out-of-safe-integer-range");
	}
	return size;
}
