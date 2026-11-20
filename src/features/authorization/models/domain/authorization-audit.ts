export interface AuthorizationOutcome {
	readonly code:
		| "login_completed"
		| "access_denied"
		| "temporarily_unavailable"
		| "invalid_grant"
		| "session_issued"
		| "refresh_rotated"
		| "refresh_grace_accepted"
		| "refresh_expired"
		| "refresh_reuse_detected";
	readonly clientId: string;
	readonly userId?: string;
	readonly sessionId?: string;
	/** Family identity is the only refresh-chain detail an audit line may carry; never a token or hash. */
	readonly familyId?: string;
}
export interface AuthorizationAudit {
	readonly record: (outcome: AuthorizationOutcome) => void;
}
