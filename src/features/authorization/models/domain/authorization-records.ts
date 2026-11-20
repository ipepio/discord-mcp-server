export interface RegisteredClient {
	readonly clientId: string;
	readonly redirectUris: readonly string[];
	readonly createdAt: Date;
}

export interface PendingAuthorizationRequest {
	readonly discordState: string;
	readonly clientId: string;
	readonly redirectUri: string;
	readonly clientState: string;
	readonly codeChallenge: string;
	readonly expiresAt: Date;
}

export interface AuthorizationCode {
	readonly codeHash: string;
	readonly clientId: string;
	readonly redirectUri: string;
	readonly codeChallenge: string;
	readonly userId: string;
	readonly expiresAt: Date;
}

/** A read projection deliberately excluding token material and its hash. */
export interface HubSession {
	readonly sessionId: string;
	readonly userId: string;
	readonly clientId: string;
	readonly issuedAt: Date;
	readonly expiresAt: Date;
	readonly revokedAt: Date | null;
}

export interface NewHubSession extends HubSession {
	readonly tokenHash: string;
}

/** A refresh-token row; the hash is the row key and the plaintext is never stored. */
export interface RefreshTokenRecord {
	readonly tokenHash: string;
	readonly clientId: string;
	readonly sessionId: string;
	readonly familyId: string;
	readonly userId: string;
	readonly issuedAt: Date;
	readonly expiresAt: Date;
	readonly consumedAt: Date | null;
}

export interface NewRefreshToken {
	readonly tokenHash: string;
	readonly clientId: string;
	readonly sessionId: string;
	readonly familyId: string;
	readonly issuedAt: Date;
	readonly expiresAt: Date;
}

/**
 * A lookup adds the only fact the caller cannot derive: whether a consumed token is still the family's
 * latest consumption inside the configured grace window (O-B), with a live head left in its family.
 */
export interface RefreshTokenLookup extends RefreshTokenRecord {
	readonly graceEligible: boolean;
}
