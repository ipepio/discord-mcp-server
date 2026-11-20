/** One identity operation: upstream credentials are confined to the implementation's stack. */
export interface DiscordOAuthGateway {
	readonly resolveUserId: (authorizationCode: string) => Promise<string>;
}
