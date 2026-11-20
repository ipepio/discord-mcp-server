import { createHash } from "node:crypto";
import type { AuthorizationStoreRepository } from "../repositories/authorization-store.repository.js";
import type { RequireCurrentMembershipQuery } from "./require-current-membership.query.js";
import { OAuthError } from "../models/domain/oauth-error.js";

export interface AuthenticatedPrincipal {
	readonly userId: string;
	readonly sessionId: string;
	readonly expiresAt: Date;
}

/**
 * The outcome classes of docs/features/authorization.md R17, and the only thing two refusals differ in:
 * *missing* (nothing was presented, decided by the guard before any lookup because there is no credential
 * to hash), *expired*, *invalid* (malformed, unknown or revoked — deliberately indistinguishable) and
 * *unavailable* (a technical failure the caller may retry). Nothing here is a security claim about a row:
 * the expired/invalid split is a UX fact, and no class carries a session, User or client id.
 */
export type AuthenticationOutcome = "missing" | "expired" | "invalid" | "unavailable";

export type AuthenticateSessionResult =
	| {
			readonly authenticated: true;
			readonly principal: AuthenticatedPrincipal;
			readonly sessionAuthenticated: true;
			readonly membershipCurrent: true;
			readonly registryStatus: "current";
	  }
	| { readonly authenticated: false; readonly outcome: AuthenticationOutcome };

const refusal = (outcome: AuthenticationOutcome): AuthenticateSessionResult => ({
	authenticated: false,
	outcome
});

export class AuthenticateSessionQuery {
	public constructor(
		private readonly deps: {
			readonly store: AuthorizationStoreRepository;
			readonly gate: RequireCurrentMembershipQuery;
		}
	) {}
	public readonly execute = async (token: string): Promise<AuthenticateSessionResult> => {
		// A value that is not a hub token shape is a malformed credential: class (c), never (a) or (b).
		if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return refusal("invalid");
		try {
			// State-preserving read: an expired row must be nameable (R17b), revocation and absence must not be
			// distinguishable from each other or from a malformed value (R17c). The decision is taken here, so the
			// store keeps answering "a row for this hash" and never "why is it unusable".
			const session = await this.deps.store.findSessionByTokenHash(
				createHash("sha256").update(token).digest("hex")
			);
			if (!session || session.revokedAt !== null) return refusal("invalid");
			if (session.expiresAt.getTime() <= Date.now()) return refusal("expired");
			await this.deps.gate.execute(session.userId);
			if (session.expiresAt.getTime() <= Date.now()) return refusal("expired");
			return {
				authenticated: true,
				principal: { userId: session.userId, sessionId: session.sessionId, expiresAt: session.expiresAt },
				sessionAuthenticated: true,
				membershipCurrent: true,
				registryStatus: "current"
			};
		} catch (error: unknown) {
			// R17 error behavior: a cause this query cannot classify is (c) or (d), never (a) and never (b). The
			// gate's own denial (a Membership that ended) is (c): retrying the same credential cannot help.
			return refusal(
				!(error instanceof OAuthError) || error.code === "temporarily_unavailable" ? "unavailable" : "invalid"
			);
		}
	};
}
