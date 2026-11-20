/**
 * ADR 0009 configured values. The access token keeps the configured SESSION_TTL_SECONDS bounds; the
 * refresh token is absolute from its own issuance and the grace window is fixed by the accepted O-B
 * decision, so neither is re-read from the environment.
 */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const REFRESH_TOKEN_GRACE_SECONDS = 30;
