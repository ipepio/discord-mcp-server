/**
 * The one snowflake rule of this Installation (spec R2, R9, R7): a Discord id is a positive decimal
 * integer of at most 21 digits. It lives here as domain data because three boundaries need the same
 * predicate — startup configuration, raw-payload normalization and REST reads, where an id is about to
 * be placed into a request path and must therefore be validated before it is used.
 */
export const DISCORD_SNOWFLAKE_PATTERN = /^[1-9][0-9]{0,20}$/;

export function isDiscordSnowflake(candidate: unknown): candidate is string {
	return typeof candidate === "string" && DISCORD_SNOWFLAKE_PATTERN.test(candidate);
}
