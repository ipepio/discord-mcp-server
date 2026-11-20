/**
 * Validated Discord startup configuration (spec R9), parsed once at startup through the shared
 * configuration path. Placement note: `docs/features/discord.md` assigns parsing and validation to
 * `shared/config`; this file is that section, written inside the `discord` feature because this
 * worker's edit surface excludes `src/shared/`. It is a drop-in addition to `AppConfig`:
 * `discord: DiscordConfig` in `app-config.interface.ts`, these validators in `config.validator.ts`
 * and the parse in `config.factory.ts`, with no change to any caller.
 */

/** The whole intent requirement of this Installation — the four items R9 names. */
export const DISCORD_REQUIRED_INTENTS = ["GUILDS", "GUILD_MESSAGES", "MESSAGE_CONTENT", "GUILD_MEMBERS"] as const;

export type DiscordIntentName = (typeof DISCORD_REQUIRED_INTENTS)[number];

/** Every intent name this feature knows how to request; anything else is a malformed declaration. */
export const DISCORD_KNOWN_INTENTS: readonly DiscordIntentName[] = DISCORD_REQUIRED_INTENTS;

export interface DiscordConfig {
	/** Bot token. Never logged, never echoed in an error message (R11). */
	readonly botToken: string;
	/** The single Guild this Installation serves; the source filter compares against it (R2). */
	readonly guildId: string;
	readonly intents: readonly DiscordIntentName[];
}
