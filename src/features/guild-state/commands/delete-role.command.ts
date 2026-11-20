import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { GuildStateConfig } from "../config/guild-state-config.interface.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import { isForeignGuildRecord } from "../models/domain/registry-rules.js";
import type { RegistryRoleRemovalResult } from "../models/domain/registry-records.js";
import type { RoleRegistryRepository } from "../repositories/role-registry.repository.js";

/**
 * `GUILD_ROLE_DELETE` applied to the registry (docs/features/guild-state.md R3, R9, R14).
 *
 * R3's deletion rule is a cascade, and the cascade is the repository's: one transaction that removes the
 * role-membership rows, the role-targeted channel overwrites and the role row itself. This command's job is to
 * issue that call exactly once per event — never a read-modify-write of each member's set, which would be a
 * merge by another name and would leave the sweep unbounded.
 *
 * Two consequences worth stating, because they are what makes a replayed or racing event safe:
 *
 * - **R9.** Deleting a role the registry does not hold reports zero counts and is not an error. A `GUILD_ROLE_DELETE`
 *   that arrives twice, or that arrives after a resync already converged the row, changes nothing observable.
 * - **R3's stale-overwrite argument.** Once this call returns, no row can hand the role's permissions to anybody:
 *   the assignments are gone, and so is every overwrite that named the role id.
 *
 * R14: the log line is the Guild id, the role id and the counts the database returned — R3's own example of what
 * a role deletion is supposed to say.
 */

/** One role deletion: the configured Guild and the role id Discord named. */
export interface DeleteRoleEvent {
	readonly guildId: DiscordIdentifier;
	readonly roleId: DiscordIdentifier;
}

export type DeleteRoleOutcome =
	| ({
			readonly status: "applied";
			readonly guildId: DiscordIdentifier;
			readonly roleId: DiscordIdentifier;
	  } & RegistryRoleRemovalResult)
	| {
			readonly status: "dropped";
			readonly guildId: DiscordIdentifier;
			readonly roleId: DiscordIdentifier;
			readonly reason: "foreign-guild";
	  };

export interface DeleteRoleCommandDeps {
	readonly config: GuildStateConfig;
	readonly roleRegistry: RoleRegistryRepository;
	readonly logger: AppLogger;
}

export class DeleteRoleCommand {
	private readonly guildId: DiscordIdentifier;

	private readonly roleRegistry: RoleRegistryRepository;

	private readonly logger: AppLogger;

	public constructor(deps: DeleteRoleCommandDeps) {
		this.guildId = deps.config.guildId;
		this.roleRegistry = deps.roleRegistry;
		this.logger = deps.logger;
	}

	public readonly execute = async (event: DeleteRoleEvent): Promise<DeleteRoleOutcome> => {
		if (isForeignGuildRecord(event.guildId, this.guildId)) {
			this.logger.warn("guild-state dropped a role deletion for another guild", {
				guildId: this.guildId,
				eventGuildId: event.guildId,
				roleId: event.roleId,
				operation: "delete-role"
			});
			return { status: "dropped", guildId: this.guildId, roleId: event.roleId, reason: "foreign-guild" };
		}

		const roleId = requireDiscordIdentifier("guild_role.role_id", event.roleId);
		const removed = await this.roleRegistry.deleteRoleAndDependents(this.guildId, roleId);

		this.logger.info("guild-state role registry applied a role deletion", {
			guildId: this.guildId,
			roleId,
			roleRemoved: removed.roleRemoved,
			membershipLinksRemoved: removed.membershipLinksRemoved,
			overwritesRemoved: removed.overwritesRemoved
		});

		return { status: "applied", guildId: this.guildId, roleId, ...removed };
	};
}
