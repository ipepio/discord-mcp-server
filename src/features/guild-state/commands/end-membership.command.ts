import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { GuildStateConfig } from "../config/guild-state-config.interface.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import { isForeignGuildRecord } from "../models/domain/registry-rules.js";
import type { RegistryMembershipRemovalResult } from "../models/domain/registry-records.js";
import type { MembershipRegistryRepository } from "../repositories/membership-registry.repository.js";

/**
 * A Membership ending (docs/features/guild-state.md R4, R9, R14).
 *
 * Leave, kick and ban are one operation. R4 is explicit that the distinction is irrelevant to authorization — all
 * three end the Membership immediately and identically — so the event carries an id and nothing else, and this
 * command has no branch to take. (Recording which of the three happened is open decision O3, and nothing here
 * pre-empts it.)
 *
 * The removal is the repository's single transaction: the role-membership rows, the private-thread membership
 * edges, the overwrites that targeted this member, and the Membership row itself. One call per event, which is
 * what makes the cascade atomic and its sweep bounded. The member-overwrite sweep is the security-favoring choice
 * pinned in `odd/tasks/guild-state.md` L3(2): R4's text names the rows this feature owns, and the schema's cascade
 * also removes the grants that named the user, so a kicked member cannot keep a channel-level grant of their own.
 *
 * R4's error case is a counted no-op: a `GUILD_MEMBER_REMOVE` for an id with no Membership — a duplicate delivery,
 * or a removal that a resync already converged — reports zero and does not fail. R9 asks the same of a replay.
 * R14: Guild id, User id, and the counts the database returned.
 */

/** One member removal: the configured Guild and the User whose Membership ended. */
export interface EndMembershipEvent {
	readonly guildId: DiscordIdentifier;
	readonly userId: DiscordIdentifier;
}

export type EndMembershipOutcome =
	| ({
			readonly status: "applied";
			readonly guildId: DiscordIdentifier;
			readonly userId: DiscordIdentifier;
	  } & RegistryMembershipRemovalResult)
	| {
			readonly status: "dropped";
			readonly guildId: DiscordIdentifier;
			readonly userId: DiscordIdentifier;
			readonly reason: "foreign-guild";
	  };

export interface EndMembershipCommandDeps {
	readonly config: GuildStateConfig;
	readonly membershipRegistry: MembershipRegistryRepository;
	readonly logger: AppLogger;
}

export class EndMembershipCommand {
	private readonly guildId: DiscordIdentifier;

	private readonly membershipRegistry: MembershipRegistryRepository;

	private readonly logger: AppLogger;

	public constructor(deps: EndMembershipCommandDeps) {
		this.guildId = deps.config.guildId;
		this.membershipRegistry = deps.membershipRegistry;
		this.logger = deps.logger;
	}

	public readonly execute = async (event: EndMembershipEvent): Promise<EndMembershipOutcome> => {
		if (isForeignGuildRecord(event.guildId, this.guildId)) {
			this.logger.warn("guild-state dropped a member removal for another guild", {
				guildId: this.guildId,
				eventGuildId: event.guildId,
				userId: event.userId,
				operation: "end-membership"
			});
			return { status: "dropped", guildId: this.guildId, userId: event.userId, reason: "foreign-guild" };
		}

		const userId = requireDiscordIdentifier("guild_membership.user_id", event.userId);
		const removed = await this.membershipRegistry.deleteMembershipAndDependents(this.guildId, userId);

		this.logger.info("guild-state membership registry ended a membership", {
			guildId: this.guildId,
			userId,
			membershipRemoved: removed.membershipRemoved,
			roleLinksRemoved: removed.roleLinksRemoved,
			overwritesRemoved: removed.overwritesRemoved,
			threadMembershipsRemoved: removed.threadMembershipsRemoved
		});

		return { status: "applied", guildId: this.guildId, userId, ...removed };
	};
}
