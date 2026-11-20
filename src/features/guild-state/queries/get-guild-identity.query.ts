import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { GuildStateConfig } from "../config/guild-state-config.interface.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import type { RegistryGuild } from "../models/domain/registry-records.js";
import type { GuildRegistryRepository } from "../repositories/guild-registry.repository.js";

/**
 * The Installation's Guild id and name, read from the registry (docs/features/guild-state.md Contracts:
 * `GetGuildIdentityQuery`, "consumed by the query feature's server metadata (query R8)"; R13).
 *
 * The read is the registry row and nothing else. It is not a REST call and never will be: the name arrived
 * with the bootstrap or a `GUILD_UPDATE`, and a metadata read that went to Discord per request would break
 * ADR 0005's rule the same way a per-query permission read would (R12).
 *
 * `not-registered` is a state, not an error. A fresh installation has no Guild row until the bootstrap's first
 * write lands, and a caller that cannot tell that apart from "the Guild has no name" would render an empty
 * server name instead of waiting for the registry. Whether the registry as a whole is current is
 * `GetGuildStateStatusQuery`'s subject (T8), not this query's.
 */

export type GetGuildIdentityResult =
	/** The stored row: id and the name the registry last saw Discord carry (R2). */
	| { readonly status: "registered"; readonly guild: RegistryGuild }
	/** The registry holds no Guild row: nothing has been bootstrapped yet (R2). */
	| { readonly status: "not-registered"; readonly guildId: DiscordIdentifier };

export interface GetGuildIdentityDeps {
	readonly config: GuildStateConfig;
	readonly guildRegistry: GuildRegistryRepository;
	readonly logger: AppLogger;
}

export class GetGuildIdentityQuery {
	private readonly guildId: DiscordIdentifier;

	private readonly guildRegistry: GuildRegistryRepository;

	private readonly logger: AppLogger;

	public constructor(deps: GetGuildIdentityDeps) {
		this.guildId = deps.config.guildId;
		this.guildRegistry = deps.guildRegistry;
		this.logger = deps.logger;
	}

	public readonly execute = async (): Promise<GetGuildIdentityResult> => {
		const guild = await this.guildRegistry.findGuild(this.guildId);
		if (guild === null) {
			// R14: the id and the fact, nothing else — there is no name to report in this branch.
			this.logger.debug("guild-state guild identity has no registered guild row", {
				guildId: this.guildId,
				operation: "get-guild-identity",
				registered: false
			});
			return { status: "not-registered", guildId: this.guildId };
		}
		this.logger.debug("guild-state guild identity read", {
			guildId: guild.guildId,
			operation: "get-guild-identity",
			registered: true
		});
		return { status: "registered", guild };
	};
}
