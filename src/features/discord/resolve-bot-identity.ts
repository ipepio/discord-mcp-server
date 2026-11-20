import type { EnvSource } from "../../shared/config/app-config.interface.js";
import type { AppLogger } from "../../shared/logging/logger.interface.js";
import { loadDiscordConfig } from "./config/discord-config.validator.js";
import { DiscordRestGateway } from "./gateways/discord-rest.gateway.js";
import type { DiscordRestTransport } from "./gateways/discord-rest.gateway.interface.js";
import { DiscordJsRestTransport } from "./gateways/discord-rest.transport.gateway.js";
import { systemClock, waitReal } from "./models/domain/discord-timing.js";

// Startup has no container logger yet. Never log credentials, payloads or upstream errors here.
const silentLogger: AppLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	withContext: () => silentLogger
};

/** Learns the connected bot's identity; optional transport is the same read seam used by the module. */
export async function resolveBotIdentity(env: EnvSource, transport?: DiscordRestTransport): Promise<string> {
	const config = loadDiscordConfig(env);
	return DiscordRestGateway.create({
		transport: transport ?? new DiscordJsRestTransport(config),
		guildId: config.guildId,
		logger: silentLogger,
		clock: systemClock,
		wait: waitReal
	}).readBotIdentity();
}
