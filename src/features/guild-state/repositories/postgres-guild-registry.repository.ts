import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import { SingleGuildViolationError } from "../models/domain/guild-state-registry.errors.js";
import type { RegistryGuild } from "../models/domain/registry-records.js";
import type { GuildRegistryRepository } from "./guild-registry.repository.js";
import { isUniqueConstraintViolation, type SqlExecutor } from "./sql-executor.js";

/**
 * The Guild row (docs/features/guild-state.md R1, R13). Explicit columns, bound values only, and the one
 * constraint this feature translates by name: `guild_registry_single_guild_index` is R1's "exactly one
 * Guild" made structural, and a second Guild row is a rejected write rather than a divergent registry.
 * Any other violation — a foreign key, a lost connection — propagates untouched. A blank name is refused
 * by the column's own `guild_name_is_never_blank` check rather than restated here.
 *
 * Reads map `bigint` to a JS string because that is what `pg` does with `int8` (see
 * `src/shared/persistence/pg-pool.factory.ts`), which is the same direction R9 wants: the id never becomes
 * a number on its way out of the registry either.
 */

/** The functional unique index behind R1, named in `migrations/1_guild_state_registry.ts`. */
const SINGLE_GUILD_INDEX = "guild_registry_single_guild_index";

type GuildRow = { guild_id: string; guild_name: string };

export class PostgresGuildRegistryRepository implements GuildRegistryRepository {
	public constructor(
		private readonly deps: {
			readonly executor: SqlExecutor;
		}
	) {}

	public readonly upsertGuild = async (guild: RegistryGuild): Promise<RegistryGuild> => {
		const guildId = requireDiscordIdentifier("guild.guild_id", guild.guildId);

		try {
			await this.deps.executor.query(
				`
					INSERT INTO guild (guild_id, guild_name)
					VALUES ($1, $2)
					ON CONFLICT (guild_id) DO UPDATE SET guild_name = EXCLUDED.guild_name
				`,
				[guildId, guild.guildName]
			);
		} catch (failure) {
			if (isUniqueConstraintViolation(failure, SINGLE_GUILD_INDEX)) {
				throw new SingleGuildViolationError(guildId);
			}
			throw failure;
		}

		return { guildId, guildName: guild.guildName };
	};

	public readonly findGuild = async (guildId: DiscordIdentifier): Promise<RegistryGuild | null> => {
		const { rows } = await this.deps.executor.query<GuildRow>(
			`
				SELECT guild_id, guild_name
				FROM guild
				WHERE guild_id = $1
			`,
			[requireDiscordIdentifier("guild.guild_id", guildId)]
		);
		const row = rows[0];
		if (row === undefined) {
			return null;
		}
		return { guildId: row.guild_id, guildName: row.guild_name };
	};
}
