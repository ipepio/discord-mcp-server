import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { GuildStateConfig } from "../config/guild-state-config.interface.js";
import type { DiscordIdentifier } from "../models/domain/discord-identifier.js";
import { requireDiscordIdentifier } from "../models/domain/discord-identifier.js";
import type { MembershipRegistryRepository } from "../repositories/membership-registry.repository.js";

/**
 * Is this User a member of the configured Guild (docs/features/guild-state.md Contracts:
 * `GetMembershipStatusQuery`, "consumed by the authorization feature's login gate and per-request check
 * (authorization R6, R8)"; R4, R13).
 *
 * `present`/`absent` is exactly the stored fact: a Membership row exists or it does not. R4 is the reason
 * the answer can only be two-valued — leave, kick and ban all end the Membership identically, and recording
 * which one happened is open decision O3, so nothing here may invent a third status out of a hint.
 *
 * Two honesty notes a consumer has to keep:
 * - The answer is meaningful only while the registry is current. The contract says consumers gate on
 *   `GetGuildStateStatusQuery` (T8); this query does not gate for them, because a membership read is not the
 *   place a staleness policy lives.
 * - `absent` is not "unknown". A foreign Guild cannot be asked about at all: the read is scoped to the
 *   configured Guild (R1), so a User who is only in another Guild is `absent` here, which is the correct
 *   answer for this Installation.
 */

export interface GetMembershipStatusInput {
	readonly userId: DiscordIdentifier;
}

export type GetMembershipStatusResult = {
	readonly guildId: DiscordIdentifier;
	readonly userId: DiscordIdentifier;
	/** `present` when the registry holds a Membership row, `absent` when it holds none (R4). */
	readonly status: "present" | "absent";
	/**
	 * How many roles the stored set names, @everyone excluded (R3: Discord never sends it, so it is never in
	 * the set). Zero on `absent`, where there is no set to count.
	 */
	readonly roleCount: number;
};

export interface GetMembershipStatusDeps {
	readonly config: GuildStateConfig;
	readonly membershipRegistry: MembershipRegistryRepository;
	readonly logger: AppLogger;
}

export class GetMembershipStatusQuery {
	private readonly guildId: DiscordIdentifier;

	private readonly membershipRegistry: MembershipRegistryRepository;

	private readonly logger: AppLogger;

	public constructor(deps: GetMembershipStatusDeps) {
		this.guildId = deps.config.guildId;
		this.membershipRegistry = deps.membershipRegistry;
		this.logger = deps.logger;
	}

	public readonly execute = async (input: GetMembershipStatusInput): Promise<GetMembershipStatusResult> => {
		const userId = requireDiscordIdentifier("guild_membership.user_id", input.userId);
		const membership = await this.membershipRegistry.findMembership(this.guildId, userId);
		const result: GetMembershipStatusResult = {
			guildId: this.guildId,
			userId,
			status: membership === null ? "absent" : "present",
			roleCount: membership === null ? 0 : membership.roleIds.length
		};

		// R14: id and the fact plus a count. No role ids, no display data: a login gate asks "is this user
		// here", and the answer does not need the roster of their roles in a log line.
		this.logger.debug("guild-state membership status read", {
			guildId: result.guildId,
			userId,
			operation: "get-membership-status",
			status: result.status,
			roleCount: result.roleCount
		});
		return result;
	};
}
