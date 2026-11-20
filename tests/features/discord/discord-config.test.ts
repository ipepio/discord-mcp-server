import { describe, expect, it } from "vitest";
import {
	DISCORD_ENV_VARIABLES,
	loadDiscordConfig,
	requireSnowflake,
	resolveDiscordIntents
} from "../../../src/features/discord/config/discord-config.validator.js";
import { DiscordIntentConfigurationError } from "../../../src/features/discord/config/discord-config.errors.js";
import { InvalidConfigurationError, MissingConfigurationError } from "../../../src/shared/config/config.errors.js";
import { DISCORD_REQUIRED_INTENTS } from "../../../src/features/discord/config/discord-config.interface.js";

/**
 * R9 — configuration and intent validation, through the shared validated-configuration path. A
 * missing or malformed item is a named startup failure; nothing here can reach the network, because
 * the connection is built from the returned contract only.
 */

const VALID_ENV = {
	[DISCORD_ENV_VARIABLES.botToken]: "fake.bot.token.value",
	[DISCORD_ENV_VARIABLES.guildId]: "111111111111111111"
};

describe("R9 — Discord configuration is validated once at startup", () => {
	it("accepts the complete requirement and freezes the contract", () => {
		const config = loadDiscordConfig(VALID_ENV);

		expect(config.guildId).toBe("111111111111111111");
		expect(config.botToken).toBe("fake.bot.token.value");
		expect(config.intents).toEqual(DISCORD_REQUIRED_INTENTS);
		expect(Object.isFrozen(config)).toBe(true);
		expect(Object.isFrozen(config.intents)).toBe(true);
	});

	it("names the missing bot token as a missing configuration variable", () => {
		expect(() => loadDiscordConfig({ [DISCORD_ENV_VARIABLES.guildId]: "111111111111111111" })).toThrow(
			MissingConfigurationError
		);

		expect(() => loadDiscordConfig({ [DISCORD_ENV_VARIABLES.guildId]: "111111111111111111" })).toThrow(
			DISCORD_ENV_VARIABLES.botToken
		);
	});

	it("names an empty bot token as missing rather than accepting a blank credential", () => {
		expect(() => loadDiscordConfig({ ...VALID_ENV, [DISCORD_ENV_VARIABLES.botToken]: "   " })).toThrow(
			MissingConfigurationError
		);
	});

	it("rejects a Guild id that is not a snowflake", () => {
		expect(() => loadDiscordConfig({ ...VALID_ENV, [DISCORD_ENV_VARIABLES.guildId]: "not-a-snowflake" })).toThrow(
			InvalidConfigurationError
		);

		expect(() => loadDiscordConfig({ ...VALID_ENV, [DISCORD_ENV_VARIABLES.guildId]: "not-a-snowflake" })).toThrow(
			DISCORD_ENV_VARIABLES.guildId
		);
	});

	it.each([
		["0123456789012345678", "a leading zero"],
		["1234567890123456789012", "longer than 21 digits"],
		["11111111111111111a", "a non digit"]
	])("rejects the snowflake %s (%s)", (value) => {
		expect(() =>
			requireSnowflake({ [DISCORD_ENV_VARIABLES.guildId]: value }, DISCORD_ENV_VARIABLES.guildId)
		).toThrow(InvalidConfigurationError);
	});

	it("treats an empty Guild id as missing rather than malformed", () => {
		expect(() => requireSnowflake({ [DISCORD_ENV_VARIABLES.guildId]: "" }, DISCORD_ENV_VARIABLES.guildId)).toThrow(
			MissingConfigurationError
		);
	});

	it("accepts the shortest and longest valid snowflakes", () => {
		expect(requireSnowflake({ GUILD: "1" }, "GUILD")).toBe("1");
		expect(requireSnowflake({ GUILD: "123456789012345678901" }, "GUILD")).toBe("123456789012345678901");
	});
});

describe("R9 — the four required intents are validated before any network activity", () => {
	it("accepts the whole requirement", () => {
		expect(resolveDiscordIntents(DISCORD_REQUIRED_INTENTS)).toEqual(DISCORD_REQUIRED_INTENTS);
	});

	it.each([...DISCORD_REQUIRED_INTENTS])("fails naming the missing intent %s", (required) => {
		const declared = DISCORD_REQUIRED_INTENTS.filter((intent) => intent !== required);

		expect(() => resolveDiscordIntents(declared)).toThrow(DiscordIntentConfigurationError);
		expect(() => resolveDiscordIntents(declared)).toThrow(new RegExp(`intent ${required}`));
	});

	it("treats a declaration disabled to an empty list as a missing intent, not as no requirement", () => {
		expect(() => resolveDiscordIntents([])).toThrow(/GUILDS/);
	});

	it("rejects a malformed intent name instead of ignoring it", () => {
		expect(() => resolveDiscordIntents(["GUILDS", "GUILD_MESAGES", "MESSAGE_CONTENT", "GUILD_MEMBERS"])).toThrow(
			/GUILD_MESAGES/
		);
	});

	it("rejects an empty entry in the declaration", () => {
		expect(() =>
			resolveDiscordIntents(["GUILDS", " ", "GUILD_MESSAGES", "MESSAGE_CONTENT", "GUILD_MEMBERS"])
		).toThrow(DiscordIntentConfigurationError);
	});

	it("fails the whole configuration when one intent is missing, naming it", () => {
		const declared = DISCORD_REQUIRED_INTENTS.filter((intent) => intent !== "MESSAGE_CONTENT");

		expect(() => loadDiscordConfig(VALID_ENV, declared)).toThrow(/MESSAGE_CONTENT/);
	});
});
