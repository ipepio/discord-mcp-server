/**
 * The additive token response of docs/features/session-refresh.md R1/R2: the access token keeps its
 * TTL bounds, the refresh token is a new opaque credential, and the plaintext exists only here.
 */
export interface TokenPair {
	readonly accessToken: string;
	readonly refreshToken: string;
	readonly expiresIn: number;
	readonly refreshExpiresIn: number;
}
