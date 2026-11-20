import type {
	AuthorizationCode,
	HubSession,
	NewHubSession,
	NewRefreshToken,
	PendingAuthorizationRequest,
	RefreshTokenLookup,
	RefreshTokenRecord,
	RegisteredClient
} from "../models/domain/authorization-records.js";

export interface AuthorizationStoreRepository {
	readonly insertClient: (client: RegisteredClient) => Promise<void>;
	readonly findClient: (clientId: string) => Promise<RegisteredClient | null>;
	readonly insertPendingRequest: (request: PendingAuthorizationRequest) => Promise<void>;
	/** Deletion is the single-use write; expired rows are also consumed but return null. */
	readonly consumePendingRequest: (discordState: string, now: Date) => Promise<PendingAuthorizationRequest | null>;
	readonly insertCode: (code: AuthorizationCode) => Promise<void>;
	/** Consume before checking PKCE, so failed verification burns the code too. */
	readonly consumeCode: (codeHash: string, now: Date) => Promise<AuthorizationCode | null>;
	readonly insertSession: (session: NewHubSession) => Promise<void>;
	readonly findActiveSession: (tokenHash: string, now: Date) => Promise<HubSession | null>;
	/**
	 * The row for a hash whatever its state, so the caller can name *why* a credential is unusable
	 * (docs/features/authorization.md R17): an expired session is its own outcome class, while unknown,
	 * malformed and revoked stay one indistinguishable answer decided by the caller, not by this query.
	 */
	readonly findSessionByTokenHash: (tokenHash: string) => Promise<HubSession | null>;
	readonly revokeSession: (sessionId: string, now: Date) => Promise<number>;
	readonly revokeUserSessions: (userId: string, now: Date) => Promise<number>;
	readonly insertRefreshToken: (token: NewRefreshToken) => Promise<void>;
	/**
	 * Any row for the hash, expired included, plus whether a consumed row still qualifies for the single
	 * grace acceptance. The caller — not the query — decides between routine expiry and reuse.
	 */
	readonly findRefreshToken: (
		tokenHash: string,
		now: Date,
		graceSeconds: number
	) => Promise<RefreshTokenLookup | null>;
	/** Single-use write: only an unconsumed, unexpired row is marked and returned. */
	readonly consumeRefreshToken: (tokenHash: string, now: Date) => Promise<RefreshTokenRecord | null>;
	/** Mark every row of the family consumed and revoke the sessions it issued; returns rows marked. */
	readonly revokeRefreshFamily: (familyId: string, now: Date) => Promise<number>;
	/** The membership-end sweep: every unconsumed token issued to a User id. */
	readonly revokeUserRefreshTokens: (userId: string, now: Date) => Promise<number>;
	readonly deleteExpiredRefreshTokens: (now: Date, limit: number) => Promise<number>;
	/** Families with no live head (revoked or fully consumed) before their rows would expire. */
	readonly deleteDeadRefreshFamilyTokens: (now: Date, limit: number) => Promise<number>;
	/** Each category is bounded independently; total removals are at most five times limit. */
	readonly purgeExpired: (now: Date, limit: number) => Promise<number>;
}
