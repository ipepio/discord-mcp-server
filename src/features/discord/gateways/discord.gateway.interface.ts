import type { DiscordIntentName } from "../config/discord-config.interface.js";

/**
 * The narrow connection seam (spec R1). Everything above it — lifecycle, guild filter, normalization,
 * delivery — is framework-free and testable with a fake; `discord.js` appears only in the single
 * implementation of this contract. It exposes receives and reads exclusively: no send, no mutating
 * operation of any kind, which is what makes the read-only property structural (R8).
 */

/** A raw gateway dispatch: the wire event name plus an unvalidated payload, exactly as received. */
export interface RawDiscordEvent {
	readonly eventName: string;
	readonly payload: unknown;
}

/** Why the transport reports the connection as lost. Never carries content or credentials. */
export type DiscordDisconnectCause = "network" | "closed" | "invalidated-session" | "unknown";

export interface DiscordDisconnectNotice {
	readonly cause: DiscordDisconnectCause;
	/** A short technical detail, for example a close code. */
	readonly detail?: string;
}

/** Cause naming a rejected login, so startup can report the reason without parsing a wire error (R1). */
export type DiscordLoginRejectionCause = "invalid-token" | "disallowed-intent" | "unreachable" | "unknown";

/**
 * Thrown by a transport implementation when `login` cannot open a session. The `cause` is a
 * technical name; no token, header or payload ever rides on it.
 */
export class DiscordLoginRejectedError extends Error {
	public readonly code = "DISCORD_LOGIN_REJECTED";
	public readonly rejectionCause: DiscordLoginRejectionCause;
	public readonly intent?: DiscordIntentName;

	constructor(options: {
		readonly cause: DiscordLoginRejectionCause;
		readonly detail: string;
		readonly intent?: DiscordIntentName;
	}) {
		super(
			options.intent === undefined
				? `Discord login rejected (${options.cause}): ${options.detail}`
				: `Discord login rejected (${options.cause} ${options.intent}): ${options.detail}`
		);
		this.name = "DiscordLoginRejectedError";
		this.rejectionCause = options.cause;
		if (options.intent !== undefined) {
			this.intent = options.intent;
		}
	}
}

/** The only two inbound paths a transport implementation may use. */
export interface DiscordGatewayClientHandlers {
	readonly onRawEvent: (event: RawDiscordEvent) => void;
	readonly onDisconnected: (notice: DiscordDisconnectNotice) => void;
}

export interface DiscordGatewayClientConfig {
	readonly botToken: string;
	readonly guildId: string;
	readonly intents: readonly DiscordIntentName[];
}

/**
 * One Gateway session. `login` performs a fresh identify, `resumeSession` attempts to continue the
 * current session and rejects when Discord refuses it, `destroy` tears the client down completely.
 */
export interface DiscordGatewayClient {
	readonly login: () => Promise<void>;
	readonly resumeSession: () => Promise<void>;
	readonly destroy: () => Promise<void>;
	/** The Guilds this connection actually holds, valid once `login` resolved. */
	readonly readGuildIds: () => readonly string[];
}

export interface DiscordGatewayClientFactory {
	readonly create: (
		config: DiscordGatewayClientConfig,
		handlers: DiscordGatewayClientHandlers
	) => DiscordGatewayClient;
}
