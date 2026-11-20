export class GetAuthorizationServerMetadataQuery {
	public constructor(private readonly baseUrl: string) {}
	public readonly execute = () => ({
		issuer: this.baseUrl,
		authorization_endpoint: `${this.baseUrl}/oauth/authorize`,
		token_endpoint: `${this.baseUrl}/oauth/token`,
		registration_endpoint: `${this.baseUrl}/oauth/register`,
		response_types_supported: ["code"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["none"],
		scopes_supported: []
	});
	public readonly protectedResource = () => ({
		resource: `${this.baseUrl}/mcp`,
		authorization_servers: [this.baseUrl],
		bearer_methods_supported: ["header"]
	});
}
