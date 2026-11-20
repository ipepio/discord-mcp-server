/**
 * Named failures of the single-connection lifecycle (spec R1). The rejected-login error itself is part
 * of the transport contract in `discord.gateway.interface.ts`, because a transport implementation is
 * the one that names the cause. Messages never carry a token or any payload content.
 */

/** A second connection attempt while one is live: a programming error, never a supported state. */
export class DiscordConnectionAlreadyOpenError extends Error {
	public readonly code = "DISCORD_CONNECTION_ALREADY_OPEN";

	constructor(public readonly epoch: number) {
		super(`A Gateway connection is already open for this Installation (epoch ${epoch}); login is not repeated`);
		this.name = "DiscordConnectionAlreadyOpenError";
	}
}

/** A lifecycle path that needs a client it does not hold: an internal invariant, never user input. */
export class DiscordConnectionStateError extends Error {
	public readonly code = "DISCORD_CONNECTION_STATE";

	constructor(detail: string) {
		super(`Discord Gateway connection is in an unusable state: ${detail}`);
		this.name = "DiscordConnectionStateError";
	}
}
