import type { DiscordOAuthGateway } from "./discord-oauth.gateway.interface.js";

export class DiscordOAuthFailure extends Error {
	public constructor(public readonly code: "exchange_failed" | "identity_failed" | "invalid_identity") {
		super("Discord identity verification failed.");
	}
}

function object(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: null;
}

export class HttpDiscordOAuthGateway implements DiscordOAuthGateway {
	public constructor(
		private readonly deps: {
			readonly clientId: string;
			readonly clientSecret: string;
			readonly redirectUri: string;
			readonly fetch: typeof globalThis.fetch;
		}
	) {}

	public readonly resolveUserId = async (authorizationCode: string): Promise<string> => {
		let token: string;
		try {
			// A code exchange is NOT replay-safe: exactly one attempt, even on ambiguous timeout.
			const response = await this.deps.fetch("https://discord.com/api/oauth2/token", {
				method: "POST",
				redirect: "error",
				signal: AbortSignal.timeout(5000),
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					client_id: this.deps.clientId,
					client_secret: this.deps.clientSecret,
					grant_type: "authorization_code",
					code: authorizationCode,
					redirect_uri: this.deps.redirectUri
				})
			});
			if (!response.ok) throw new DiscordOAuthFailure("exchange_failed");
			const payload = object(await response.json());
			if (
				!payload ||
				typeof payload["access_token"] !== "string" ||
				!payload["access_token"] ||
				typeof payload["scope"] !== "string" ||
				payload["scope"].trim() !== "identify" ||
				typeof payload["token_type"] !== "string" ||
				payload["token_type"].toLowerCase() !== "bearer"
			)
				throw new DiscordOAuthFailure("exchange_failed");
			token = payload["access_token"];
		} catch {
			throw new DiscordOAuthFailure("exchange_failed");
		}

		// Identity fetch is replay-safe. Retry only transport failure or 5xx, twice total, with bounded backoff.
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const response = await this.deps.fetch("https://discord.com/api/users/@me", {
					redirect: "error",
					signal: AbortSignal.timeout(5000),
					headers: { Authorization: `Bearer ${token}` }
				});
				if (response.status >= 500 && attempt === 0) {
					await new Promise((resolve) => setTimeout(resolve, 100));
					continue;
				}
				if (!response.ok) throw new DiscordOAuthFailure("identity_failed");
				const payload = object(await response.json());
				if (
					!payload ||
					typeof payload["id"] !== "string" ||
					!/^[1-9][0-9]{0,18}$/.test(payload["id"]) ||
					BigInt(payload["id"]) > 9223372036854775807n
				)
					throw new DiscordOAuthFailure("invalid_identity");
				return payload["id"];
			} catch (error: unknown) {
				if (error instanceof DiscordOAuthFailure) throw error;
				if (attempt === 1) throw new DiscordOAuthFailure("identity_failed");
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		throw new DiscordOAuthFailure("identity_failed");
	};
}
