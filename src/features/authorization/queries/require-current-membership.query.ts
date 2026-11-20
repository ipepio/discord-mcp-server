import type { GetMembershipStatusQuery, GuildStateStatusResult } from "../../guild-state/index.js";
import { OAuthError } from "../models/domain/oauth-error.js";

export interface MembershipGateDependencies {
	readonly status: { readonly execute: () => Promise<Pick<GuildStateStatusResult, "status">> };
	readonly membership: {
		readonly execute: (
			input: Parameters<GetMembershipStatusQuery["execute"]>[0]
		) => Promise<{ readonly status: "present" | "absent" }>;
	};
}

export class RequireCurrentMembershipQuery {
	public constructor(private readonly deps: MembershipGateDependencies) {}
	public readonly execute = async (userId: string): Promise<void> => {
		try {
			if ((await this.deps.status.execute()).status !== "current")
				throw new OAuthError("temporarily_unavailable", "Membership verification is temporarily unavailable.");
			const membership = await this.deps.membership.execute({ userId });
			// Recheck after the read to avoid accepting a read made during an observed resync transition.
			if ((await this.deps.status.execute()).status !== "current")
				throw new OAuthError("temporarily_unavailable", "Membership verification is temporarily unavailable.");
			if (membership.status !== "present")
				throw new OAuthError("access_denied", "This Discord account is not a member of this Guild.");
		} catch (error: unknown) {
			if (error instanceof OAuthError) throw error;
			throw new OAuthError("temporarily_unavailable", "Membership verification is temporarily unavailable.");
		}
	};
}
