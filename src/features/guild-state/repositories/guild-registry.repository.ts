import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import type { RegistryGuild } from "../models/domain/registry-records.js";

/**
 * The Guild row of the permission registry (docs/features/guild-state.md Contracts: "Repository contracts
 * … upsert Guild"; R1, R13).
 *
 * One Guild exists. `upsertGuild` creates or renames it; it can never add a second one, because the
 * schema carries `guild_registry_single_guild_index` and the adapter turns that violation into
 * {@link SingleGuildViolationError} instead of letting a divergent registry appear (R1).
 */
export interface GuildRegistryRepository {
	/** The Guild snapshot row: id and name (R1, R13). */
	readonly upsertGuild: (guild: RegistryGuild) => Promise<RegistryGuild>;

	/** The stored Guild, or `null` when the registry has never been bootstrapped. */
	readonly findGuild: (guildId: DiscordIdentifier) => Promise<RegistryGuild | null>;
}
