import type { AuthorizationStoreRepository } from "../repositories/authorization-store.repository.js";
import type { AppLogger } from "../../../shared/logging/logger.interface.js";

/**
 * Membership end (leave, kick, ban) revokes the User's sessions AND their whole refresh family in one
 * call, so a refresh attempt afterwards is refused instead of quietly renewing access for a user who is
 * no longer a member (docs/features/session-refresh.md R5).
 */
export class RevokeUserSessionsCommand {
	private anomalies = 0;
	public constructor(
		private readonly deps: { readonly store: AuthorizationStoreRepository; readonly logger: AppLogger }
	) {}
	public readonly anomalyCount = (): number => this.anomalies;
	public readonly execute = async (userId: string): Promise<number> => {
		try {
			const now = new Date();
			const count = await this.deps.store.revokeUserSessions(userId, now);
			const refreshTokens = await this.deps.store.revokeUserRefreshTokens(userId, now);
			try {
				this.deps.logger.info("authorization sessions revoked", {
					userId,
					count,
					refreshCount: refreshTokens,
					code: count + refreshTokens ? "sessions_revoked" : "revocation_noop"
				});
			} catch {
				this.anomalies += 1; /* A failed sink is counted, never a failed revocation. */
			}
			return count;
		} catch {
			this.anomalies += 1;
			try {
				this.deps.logger.error("authorization revocation failed", {
					userId,
					code: "revocation_failed",
					count: this.anomalies
				});
			} catch {
				this.anomalies += 1;
			}
			throw new Error("Session revocation failed.");
		}
	};
}
