export type OAuthErrorCode =
	| "invalid_client_metadata"
	| "invalid_request"
	| "invalid_client"
	| "unauthorized_client"
	| "invalid_grant"
	| "unsupported_grant_type"
	| "invalid_scope"
	| "access_denied"
	| "temporarily_unavailable";

/** Safe descriptions are authored locally; never wrap upstream or validation exception messages. */
export class OAuthError extends Error {
	public constructor(
		public readonly code: OAuthErrorCode,
		description: string
	) {
		super(description);
	}
}
