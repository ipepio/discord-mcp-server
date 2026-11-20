/**
 * Named startup failure of the Discord intent requirement (spec R9). The message names the intent;
 * the configuration variables themselves reuse the shared named errors in `shared/config`.
 */
export class DiscordIntentConfigurationError extends Error {
	public readonly code = "DISCORD_INTENT_INVALID";

	constructor(
		public readonly intent: string,
		reason: string
	) {
		super(`Required Discord intent ${intent} is not usable: ${reason}`);
		this.name = "DiscordIntentConfigurationError";
	}
}
