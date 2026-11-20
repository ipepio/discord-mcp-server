import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { GuildStateConfig } from "../config/guild-state-config.interface.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import { partitionKnownRoleIds } from "../models/domain/event-application-rules.js";
import { isForeignGuildRecord } from "../models/domain/registry-rules.js";
import type { MembershipRegistryRepository } from "../repositories/membership-registry.repository.js";
import type { RoleRegistryRepository } from "../repositories/role-registry.repository.js";

/**
 * A join or a member update applied to the Membership registry (docs/features/guild-state.md R4, R5, R9, R10,
 * with R1 at the event boundary).
 *
 * R5 is the whole shape of this command: Discord's member payload carries the member's *complete* role set, so
 * the stored set is replaced and never merged. The one call below — `upsertMemberships` with a single member —
 * is the repository's own one-transaction "identity row, sweep this member's assignments, write this set", which
 * is why a join and a later role change take the same path and why a replay is a no-op (R9).
 *
 * The set that reaches the registry is the set the schema can hold (the tension pinned in
 * `odd/tasks/guild-state.md` L3): `guild_membership_role` has a foreign key to `guild_role`, so an id the registry
 * has never seen cannot be part of a stored row without rejecting the member's other roles with it. Unknown ids
 * are therefore reported as deferred and named in the log — never dropped silently, and never guessed at. The
 * convergence is R10's: once the role definition arrives, the next complete member payload (or the resync roster
 * read, R11) writes the link, and evaluation gains the role's permissions at that moment.
 *
 * What the event also carries and this command deliberately ignores: nicknames, join instants, the pending flag,
 * and whether the user is a bot or a webhook. R4's boundary says a bot or webhook member is stored like any other
 * member, and R14 with open decision O2 keeps the registry id-only — so an id and a role set are the entire stored
 * fact, and nothing here can branch on data it never receives.
 */

/** One member payload: the configured Guild, the User, and the whole role set as Discord sent it. */
export interface ApplyMemberUpdateEvent {
	readonly guildId: DiscordIdentifier;
	readonly userId: DiscordIdentifier;
	/** The complete set. An empty array is a member holding nothing but `@everyone`, which is a real state (R5). */
	readonly roleIds: readonly DiscordIdentifier[];
}

export type ApplyMemberUpdateOutcome =
	| {
			readonly status: "applied";
			readonly guildId: DiscordIdentifier;
			readonly userId: DiscordIdentifier;
			/** The set as stored, in payload order: the reported set minus what the foreign key would refuse (R5, L3). */
			readonly roleIdsStored: readonly DiscordIdentifier[];
			/** Role ids the payload named that the registry has no row for yet. Convergence is R10's job. */
			readonly deferredRoleIds: readonly DiscordIdentifier[];
			readonly rowsWritten: number;
	  }
	| {
			readonly status: "dropped";
			readonly guildId: DiscordIdentifier;
			readonly userId: DiscordIdentifier;
			readonly reason: "foreign-guild";
	  };

export interface ApplyMemberUpdateCommandDeps {
	readonly config: GuildStateConfig;
	readonly roleRegistry: RoleRegistryRepository;
	readonly membershipRegistry: MembershipRegistryRepository;
	readonly logger: AppLogger;
}

export class ApplyMemberUpdateCommand {
	private readonly guildId: DiscordIdentifier;

	private readonly roleRegistry: RoleRegistryRepository;

	private readonly membershipRegistry: MembershipRegistryRepository;

	private readonly logger: AppLogger;

	public constructor(deps: ApplyMemberUpdateCommandDeps) {
		this.guildId = deps.config.guildId;
		this.roleRegistry = deps.roleRegistry;
		this.membershipRegistry = deps.membershipRegistry;
		this.logger = deps.logger;
	}

	public readonly execute = async (event: ApplyMemberUpdateEvent): Promise<ApplyMemberUpdateOutcome> => {
		if (isForeignGuildRecord(event.guildId, this.guildId)) {
			return this.dropForeignGuild(event.guildId, event.userId);
		}

		const userId = requireDiscordIdentifier("guild_membership.user_id", event.userId);
		const reportedRoleIds = event.roleIds.map((roleId) =>
			requireDiscordIdentifier("guild_membership_role.role_id", roleId)
		);

		const { storableRoleIds, deferredRoleIds } = await this.storableSetOf(reportedRoleIds);
		const written = await this.membershipRegistry.upsertMemberships([
			{ guildId: this.guildId, userId, roleIds: storableRoleIds }
		]);

		if (deferredRoleIds.length > 0) {
			// An anomaly to converge, not a failure to hide: R5 wanted these ids stored as given, and the
			// foreign key said no. R14 asks for ids and counts, and that is exactly what travels here.
			this.logger.warn("guild-state deferred role ids a member event named that the registry does not hold", {
				guildId: this.guildId,
				userId,
				deferredRoleIds,
				deferredRoleCount: deferredRoleIds.length
			});
		}

		this.logger.info("guild-state membership registry applied a member event", {
			guildId: this.guildId,
			userId,
			roleCount: storableRoleIds.length,
			deferredRoleCount: deferredRoleIds.length,
			rowsWritten: written.rowsWritten
		});

		return {
			status: "applied",
			guildId: this.guildId,
			userId,
			roleIdsStored: storableRoleIds,
			deferredRoleIds,
			rowsWritten: written.rowsWritten
		};
	};

	/** R1: named and counted, never stored — a member of another Guild has no row in this registry. */
	private dropForeignGuild(eventGuildId: DiscordIdentifier, userId: DiscordIdentifier): ApplyMemberUpdateOutcome {
		this.logger.warn("guild-state dropped a member event for another guild", {
			guildId: this.guildId,
			eventGuildId,
			userId,
			operation: "apply-member-update"
		});
		return { status: "dropped", guildId: this.guildId, userId, reason: "foreign-guild" };
	}

	/**
	 * Which of the reported ids the `guild_membership_role` foreign key will accept. The role-bitfield projection
	 * answers exactly this question and nothing else: an id absent from its result is a role the registry has never
	 * seen, which is R5's error case and the trigger R11 names for a targeted read of the role list.
	 */
	private async storableSetOf(
		reportedRoleIds: readonly DiscordIdentifier[]
	): Promise<{ storableRoleIds: readonly DiscordIdentifier[]; deferredRoleIds: readonly DiscordIdentifier[] }> {
		if (reportedRoleIds.length === 0) {
			return { storableRoleIds: [], deferredRoleIds: [] };
		}
		const known = await this.roleRegistry.findRolePermissions(this.guildId, reportedRoleIds);
		return partitionKnownRoleIds(
			reportedRoleIds,
			known.map((entry) => entry.roleId)
		);
	}
}
