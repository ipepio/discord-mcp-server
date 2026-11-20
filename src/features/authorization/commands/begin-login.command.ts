import { randomBytes } from "node:crypto";
import { OAuthError } from "../models/domain/oauth-error.js";
import type { AuthorizationStoreRepository } from "../repositories/authorization-store.repository.js";

export interface BeginLoginInput {
	readonly clientId: string;
	readonly redirectUri: string;
	readonly responseType: string;
	readonly state: string;
	readonly codeChallenge: string;
	readonly codeChallengeMethod: string;
	readonly scope?: string;
}

export class BeginLoginCommand {
	public constructor(
		private readonly deps: {
			readonly store: AuthorizationStoreRepository;
			readonly publicBaseUrl: string;
			readonly discordClientId: string;
		}
	) {}

	public readonly execute = async (input: BeginLoginInput): Promise<{ readonly redirectUrl: string }> => {
		// Redirect validity is established before any redirect is possible; failures stay at the hub.
		const client = await this.deps.store.findClient(input.clientId);
		if (!client) throw new OAuthError("invalid_client", "The client is not registered.");
		if (!input.redirectUri || !client.redirectUris.includes(input.redirectUri))
			throw new OAuthError("invalid_request", "A registered redirect URI is required.");
		if (
			input.responseType !== "code" ||
			!input.state ||
			input.state.length > 2048 ||
			input.codeChallengeMethod !== "S256" ||
			!/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge)
		)
			throw new OAuthError("invalid_request", "A code request with state and S256 PKCE is required.");
		if (input.scope) throw new OAuthError("invalid_scope", "No additional scopes are supported.");
		const discordState = randomBytes(32).toString("base64url");
		await this.deps.store.insertPendingRequest({
			discordState,
			clientId: client.clientId,
			redirectUri: input.redirectUri,
			clientState: input.state,
			codeChallenge: input.codeChallenge,
			expiresAt: new Date(Date.now() + 300_000)
		});
		const target = URL.parse("https://discord.com/oauth2/authorize");
		if (!target) throw new OAuthError("temporarily_unavailable", "Discord login is temporarily unavailable.");
		target.search = new URLSearchParams({
			client_id: this.deps.discordClientId,
			redirect_uri: `${this.deps.publicBaseUrl}/oauth/discord/callback`,
			response_type: "code",
			scope: "identify",
			state: discordState
		}).toString();
		return { redirectUrl: target.toString() };
	};
}
