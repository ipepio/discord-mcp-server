import type { EnvSource } from "../../../shared/config/app-config.interface.js";
import { InvalidConfigurationError } from "../../../shared/config/config.errors.js";
import { requireText } from "../../../shared/config/config.validator.js";
import { DiscordIntentConfigurationError } from "./discord-config.errors.js";
import type { DiscordConfig, DiscordIntentName } from "./discord-config.interface.js";
import { DISCORD_KNOWN_INTENTS, DISCORD_REQUIRED_INTENTS } from "./discord-config.interface.js";

/**
 * Environment variables this feature requires. They belong to `shared/config`'s registry: adding a
 * variable means adding a name here plus its validator, never a scattered `process.env` read.
 */
export const DISCORD_ENV_VARIABLES = {
	botToken: "DISCORD_BOT_TOKEN",
	guildId: "DISCORD_GUILD_ID"
} as const;

/** Discord snowflakes are positive decimal integers of at most 21 digits. */
const SNOWFLAKE_PATTERN = /^[1-9][0-9]{0,20}$/;

/** Required non-empty value that must be a Discord snowflake. */
export function requireSnowflake(env: Readonly<Record<string, string | undefined>>, name: string): string {
	const value = requireText(env, name);
	if (!SNOWFLAKE_PATTERN.test(value)) {
		throw new InvalidConfigurationError(name, "must be a Discord snowflake: 1 to 21 digits with no leading zero");
	}

	return value;
}

function isKnownIntent(candidate: string): candidate is DiscordIntentName {
	return (DISCORD_KNOWN_INTENTS as readonly string[]).includes(candidate);
}

/**
 * Validates the declared intent set before any network activity: every required intent must be
 * declared, every declared item must be a known intent name, and an unknown item is a malformed
 * declaration rather than a silently ignored one (R9).
 */
export function resolveDiscordIntents(declared: readonly string[]): readonly DiscordIntentName[] {
	const names = new Set<string>();

	for (const item of declared) {
		const candidate = item.trim();
		if (candidate === "") {
			throw new DiscordIntentConfigurationError(item, "the declaration contains an empty entry");
		}

		if (!isKnownIntent(candidate)) {
			throw new DiscordIntentConfigurationError(
				candidate,
				`unknown intent name; this Installation knows ${DISCORD_KNOWN_INTENTS.join(", ")}`
			);
		}

		names.add(candidate);
	}

	for (const required of DISCORD_REQUIRED_INTENTS) {
		if (!names.has(required)) {
			throw new DiscordIntentConfigurationError(
				required,
				"it is not declared, so the connection would be closed by Discord for a missing or disabled intent"
			);
		}
	}

	return DISCORD_REQUIRED_INTENTS.filter((intent) => names.has(intent));
}

/**
 * Parses and validates the Discord section once, at startup. The declared intent set defaults to the
 * requirement R9 states; a missing token, a malformed Guild id or an incomplete intent set throws
 * before any client is constructed, so no network activity can happen behind a broken configuration.
 */
export function loadDiscordConfig(
	env: EnvSource,
	declaredIntents: readonly string[] = DISCORD_REQUIRED_INTENTS
): DiscordConfig {
	const config: DiscordConfig = {
		botToken: requireText(env, DISCORD_ENV_VARIABLES.botToken),
		guildId: requireSnowflake(env, DISCORD_ENV_VARIABLES.guildId),
		intents: resolveDiscordIntents(declaredIntents)
	};

	return Object.freeze({
		botToken: config.botToken,
		guildId: config.guildId,
		intents: Object.freeze([...config.intents])
	});
}
