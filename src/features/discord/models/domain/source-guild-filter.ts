/**
 * The source Guild filter (spec R2). It runs on the raw payload, before any normalization, because an
 * event of another Guild must never reach a mapper, a counter of normalized kinds or a consumer.
 *
 * A payload carries its Guild either in `guild_id` or, for the events whose payload is the Guild
 * object itself, in `id`. Anything else — no field, a non-string, a malformed snowflake — counts as a
 * payload without a Guild rather than being guessed at or repaired.
 */

/** Raw events whose payload is the Guild itself: the Guild id is the payload's own `id`. */
const GUILD_SELF_EVENTS: readonly string[] = ["GUILD_CREATE", "GUILD_UPDATE", "GUILD_DELETE"];

const SNOWFLAKE_PATTERN = /^[1-9][0-9]{0,20}$/;

export type SourceGuildDecision =
	| { readonly outcome: "configured"; readonly guildId: string }
	| { readonly outcome: "foreign"; readonly guildId: string }
	| { readonly outcome: "guild-less" };

export function sourceGuildIdOf(rawEventName: string, payload: unknown): string | undefined {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		return undefined;
	}

	const record = payload as Readonly<Record<string, unknown>>;
	const field = GUILD_SELF_EVENTS.includes(rawEventName) ? "id" : "guild_id";
	const candidate = record[field];

	return typeof candidate === "string" && SNOWFLAKE_PATTERN.test(candidate) ? candidate : undefined;
}

export function decideSourceGuild(
	rawEventName: string,
	payload: unknown,
	configuredGuildId: string
): SourceGuildDecision {
	const guildId = sourceGuildIdOf(rawEventName, payload);

	if (guildId === undefined) {
		return { outcome: "guild-less" };
	}

	return guildId === configuredGuildId ? { outcome: "configured", guildId } : { outcome: "foreign", guildId };
}
