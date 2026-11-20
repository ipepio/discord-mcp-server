import { Client, GatewayIntentBits } from "discord.js";
import type { CloseEvent } from "discord.js";
import type { DiscordIntentName } from "../config/discord-config.interface.js";
import { DISCORD_KNOWN_INTENTS } from "../config/discord-config.interface.js";
import type {
	DiscordGatewayClient,
	DiscordGatewayClientConfig,
	DiscordGatewayClientFactory,
	DiscordGatewayClientHandlers
} from "./discord.gateway.interface.js";
import { DiscordLoginRejectedError } from "./discord.gateway.interface.js";

/**
 * The only file that touches `discord.js` for the Gateway (spec R1, R3, R8): it adapts the client to
 * the narrow connection seam and uses receives and reads only — no mutating method is reachable
 * through it, and no discord.js type leaves this file.
 *
 * Proof note: this is transport glue against a live service, so no test exercises it; the contract it
 * implements is proven by the fake exposing the same seam. Live Discord access is therefore missing
 * evidence here, not a claim of verified behavior (docs/architecture/testing.md).
 */

/** Discord's intent bit values, named exactly as the developer portal names them. */
const INTENT_BITS: Readonly<Record<DiscordIntentName, GatewayIntentBits>> = Object.freeze({
	GUILDS: GatewayIntentBits.Guilds,
	GUILD_MEMBERS: GatewayIntentBits.GuildMembers,
	GUILD_MESSAGES: GatewayIntentBits.GuildMessages,
	MESSAGE_CONTENT: GatewayIntentBits.MessageContent
});

/** Gateway close codes: 4013 disallowed intent, 4014 disabled token, 4015 revoked token. */
const DISALLOWED_INTENTS_CLOSE_CODE = 4013;
const TOKEN_CLOSE_CODES: readonly number[] = [4014, 4015];

/** Error names discord.js raises when the token itself is refused. */
const TOKEN_ERROR_NAMES: readonly string[] = ["TokenInvalidError", "UnauthorizedError"];

/** Budget for Discord to confirm a session or a resume before the lifecycle treats it as refused. */
const CONFIRMATION_BUDGET_MS = 30_000;

/** The gateway dispatch envelope: `t` is the raw event name, `d` the unvalidated payload. */
interface GatewayDispatchEnvelope {
	readonly t?: unknown;
	readonly d?: unknown;
}

function intentBitfield(intents: readonly DiscordIntentName[]): number {
	return intents.reduce((bits, intent) => bits | INTENT_BITS[intent], 0);
}

/** Discord names the offending privileged intent in the close reason; only known names are kept. */
function namedIntent(reason: string): DiscordIntentName | undefined {
	return DISCORD_KNOWN_INTENTS.find((intent) => reason.toUpperCase().includes(intent));
}

function rejectionFromClose(event: CloseEvent): DiscordLoginRejectedError {
	const reason = typeof event.reason === "string" ? event.reason : "";
	const intent = namedIntent(reason);

	if (event.code === DISALLOWED_INTENTS_CLOSE_CODE) {
		return new DiscordLoginRejectedError({
			cause: "disallowed-intent",
			detail: `close code ${event.code}`,
			...(intent === undefined ? {} : { intent })
		});
	}

	return new DiscordLoginRejectedError({
		cause: TOKEN_CLOSE_CODES.includes(event.code) ? "invalid-token" : "unknown",
		detail: `close code ${event.code}`
	});
}

export class DiscordJsGatewayClient implements DiscordGatewayClient {
	private readonly client: Client;
	private readonly botToken: string;

	public constructor(config: DiscordGatewayClientConfig, handlers: DiscordGatewayClientHandlers) {
		this.botToken = config.botToken;
		this.client = new Client({ intents: intentBitfield(config.intents) });

		// Wired before login so no dispatch is missed and no lost socket goes unreported (R1).
		this.client.on("raw", (envelope: GatewayDispatchEnvelope) => {
			if (typeof envelope.t === "string") {
				handlers.onRawEvent({ eventName: envelope.t, payload: envelope.d });
			}
		});
		this.client.on("shardDisconnect", (event: CloseEvent) => {
			handlers.onDisconnected({ cause: "closed", detail: `close code ${event.code}` });
		});
		this.client.on("invalidated", () => {
			handlers.onDisconnected({ cause: "invalidated-session", detail: "Discord invalidated the session" });
		});
	}

	public readonly login = async (): Promise<void> => {
		const confirmed = this.awaitReady();

		try {
			await this.client.login(this.botToken);
		} catch (error) {
			throw new DiscordLoginRejectedError({
				cause: TOKEN_ERROR_NAMES.includes(errorName(error)) ? "invalid-token" : "unknown",
				detail: errorName(error)
			});
		}

		await confirmed;
	};

	/**
	 * The client's own manager performs the resume; this waits for Discord's confirmation and refuses
	 * it otherwise, which is what lets the lifecycle fall back to a fresh identify (R1).
	 */
	public readonly resumeSession = async (): Promise<void> => {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`Discord did not confirm the session resume within ${CONFIRMATION_BUDGET_MS}ms`));
			}, CONFIRMATION_BUDGET_MS);
			timer.unref();

			const onResumed = (): void => {
				clearTimeout(timer);
				this.client.off("invalidated", onRefused);
				resolve();
			};

			const onRefused = (): void => {
				clearTimeout(timer);
				this.client.off("shardResume", onResumed);
				reject(new Error("Discord refused to resume the Gateway session"));
			};

			this.client.once("shardResume", onResumed);
			this.client.once("invalidated", onRefused);
		});
	};

	public readonly destroy = async (): Promise<void> => {
		await this.client.destroy();
	};

	public readonly readGuildIds = (): readonly string[] => [...this.client.guilds.cache.keys()];

	private awaitReady(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`Discord did not report the session ready within ${CONFIRMATION_BUDGET_MS}ms`));
			}, CONFIRMATION_BUDGET_MS);
			timer.unref();

			const finish = (): void => {
				clearTimeout(timer);
				this.client.off("clientReady", onReady);
				this.client.off("shardDisconnect", onClosed);
			};

			const onReady = (): void => {
				finish();
				resolve();
			};

			const onClosed = (event: CloseEvent): void => {
				finish();
				reject(rejectionFromClose(event));
			};

			this.client.once("clientReady", onReady);
			this.client.once("shardDisconnect", onClosed);
		});
	}
}

/** The production factory: one client per call; the lifecycle never holds two at once (R1). */
export class DiscordJsGatewayClientFactory implements DiscordGatewayClientFactory {
	public readonly create = (
		config: DiscordGatewayClientConfig,
		handlers: DiscordGatewayClientHandlers
	): DiscordGatewayClient => new DiscordJsGatewayClient(config, handlers);
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown";
}
