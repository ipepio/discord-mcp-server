import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import type { AuthorizationAudit, AuthorizationOutcome } from "../models/domain/authorization-audit.js";

/** Fixed event message and explicit fields: no arbitrary exception, payload or credential context. */
export class AuthorizationAuditGateway implements AuthorizationAudit {
	private failures = 0;
	public constructor(private readonly logger: AppLogger) {}
	public readonly anomalyCount = (): number => this.failures;
	public readonly record = (outcome: AuthorizationOutcome): void => {
		try {
			this.logger.info("authorization outcome", {
				code: outcome.code,
				count: 1,
				clientId: outcome.clientId,
				...(outcome.userId === undefined ? {} : { userId: outcome.userId }),
				...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }),
				...(outcome.familyId === undefined ? {} : { familyId: outcome.familyId })
			});
		} catch {
			this.failures += 1;
			try {
				this.logger.warn("authorization audit anomaly", { code: "audit_failed", count: this.failures });
			} catch {
				/* A broken sink never changes authentication outcomes. */
			}
		}
	};
}
