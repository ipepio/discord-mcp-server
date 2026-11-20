import { InvalidRegistryBatchError } from "../models/domain/guild-state-registry.errors.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import { DEFAULT_REGISTRY_WRITE_BATCH_SIZE, resolveWriteBatchSize } from "../repositories/registry-write-batch.js";

/**
 * What guild-state needs to know about this Installation (docs/features/guild-state.md R1, R9).
 *
 * The Guild id is not guild-state's to parse: the `discord` feature owns reading `DISCORD_GUILD_ID` and
 * validating it once, and the composition hands the same value here through `DISCORD_CONFIG_TOKEN`. One
 * source, one validator, so the registry cannot be scoped to a Guild the connection is not serving (R1) —
 * and a bootstrap that wrote to a different Guild than the event stream feeds would silently diverge.
 *
 * The bounds are guild-state's own. "Bounded pages and bounded batch transactions" (R2, R9) is a registry
 * concern, and the numbers have to be stated somewhere a test can read them.
 */

/** How far one bootstrap pass walks the roster, and how many rows one registry transaction may carry. */
export interface GuildBootstrapBounds {
	/**
	 * Pages requested from the roster read. The Discord REST policy is the ceiling either way
	 * (`memberMaxPages`, 20 by default), so a Guild larger than pageSize × memberMaxPages reports a
	 * truncated roster and the composition raises that bound rather than the registry claiming completion.
	 */
	readonly rosterMaxPages: number;
	/** Rows per registry write batch, one transaction each. Clamped to the repository ceiling. */
	readonly writeBatchSize: number;
}

export interface GuildStateConfig {
	readonly guildId: DiscordIdentifier;
	readonly bootstrap: GuildBootstrapBounds;
}

/** The v1 bounds: one bounded roster pass, 200 rows per transaction. */
export const DEFAULT_GUILD_BOOTSTRAP_BOUNDS: GuildBootstrapBounds = Object.freeze({
	rosterMaxPages: 20,
	writeBatchSize: DEFAULT_REGISTRY_WRITE_BATCH_SIZE
});

export interface GuildStateConfigInput {
	/** The configured Guild id, taken from the `discord` feature's validated configuration. */
	readonly guildId: string;
	/** Bounds a deployment may tighten; a partial block keeps the defaults it does not name. */
	readonly bootstrap?: Partial<GuildBootstrapBounds>;
}

/**
 * One validator for the whole feature: the id must be storable as a `bigint` and every bound must be a
 * positive whole number. A broken deployment throws at composition instead of discovering it mid-bootstrap.
 */
export function createGuildStateConfig(input: GuildStateConfigInput): GuildStateConfig {
	const bootstrap = input.bootstrap ?? {};
	const rosterMaxPages = bootstrap.rosterMaxPages ?? DEFAULT_GUILD_BOOTSTRAP_BOUNDS.rosterMaxPages;
	if (!Number.isInteger(rosterMaxPages) || rosterMaxPages < 1) {
		throw new InvalidRegistryBatchError(
			"bootstrap.rosterMaxPages",
			"the roster page bound must be a positive whole number"
		);
	}

	return {
		guildId: requireDiscordIdentifier("guild_state.guild_id", input.guildId),
		bootstrap: {
			rosterMaxPages,
			writeBatchSize: resolveWriteBatchSize(
				bootstrap.writeBatchSize ?? DEFAULT_GUILD_BOOTSTRAP_BOUNDS.writeBatchSize
			)
		}
	};
}
