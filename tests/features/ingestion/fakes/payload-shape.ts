/**
 * Payload shapes for the tests of events that arrive *incomplete* (docs/features/ingestion.md R5, R10, R11).
 *
 * `exactOptionalPropertyTypes` is enabled project-wide, and it refuses exactly the confusion these cases are
 * about: writing `content: undefined` is not the same value as a payload that carried no content — it is a key
 * holding `undefined`, which a real Discord object never produces. A partial update therefore has to be built
 * by leaving the key out, and a test states which keys it means to leave out.
 *
 * The single cast in this file is deliberate and narrow: the shape of the result is the caller's type
 * parameter, and the fields are the caller's own literal, so nothing is being asserted away — the helper only
 * tells the compiler what the runtime object already is. Production code never sees this: it is a fixture
 * builder for the two kinds of payload a command has to treat differently.
 */

/** One application payload, with the named fields genuinely absent rather than set to `undefined`. */
export function payloadOf<T>(fields: Readonly<Record<string, unknown>>, omit: readonly string[] = []): T {
	return Object.fromEntries(Object.entries(fields).filter(([key]) => !omit.includes(key))) as T;
}

/** The same rule applied to an object that was already built: the key goes, and `undefined` does not replace it. */
export function withoutKey<T extends object>(record: T, key: string): T {
	return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key)) as T;
}
