import { createHash, randomBytes } from "node:crypto";
import type { DiscordOAuthGateway } from "../gateways/discord-oauth.gateway.interface.js";
import type { AuthorizationAudit } from "../models/domain/authorization-audit.js";
import { OAuthError } from "../models/domain/oauth-error.js";
import type { AuthorizationStoreRepository } from "../repositories/authorization-store.repository.js";
import type { RequireCurrentMembershipQuery } from "../queries/require-current-membership.query.js";

export class CompleteLoginCommand {
	public constructor(
		private readonly deps: {
			readonly store: AuthorizationStoreRepository;
			readonly gateway: DiscordOAuthGateway;
			readonly gate: RequireCurrentMembershipQuery;
			readonly audit?: AuthorizationAudit;
		}
	) {}

	public readonly execute = async (input: {
		readonly state: string;
		readonly code: string;
		readonly denied?: boolean;
	}): Promise<{ readonly redirectUri: string; readonly code: string; readonly state: string }> => {
		const pending = await this.deps.store.consumePendingRequest(input.state, new Date());
		if (!pending) throw new OAuthError("invalid_grant", "The login request is invalid or expired.");
		if (input.denied || !input.code) throw new OAuthError("access_denied", "Discord login was not completed.");
		let userId: string;
		try {
			userId = await this.deps.gateway.resolveUserId(input.code);
		} catch {
			this.deps.audit?.record({ code: "temporarily_unavailable", clientId: pending.clientId });
			throw new OAuthError(
				"temporarily_unavailable",
				"Discord identity verification is temporarily unavailable."
			);
		}
		try {
			await this.deps.gate.execute(userId);
		} catch (error: unknown) {
			this.deps.audit?.record({
				code:
					error instanceof OAuthError && error.code === "access_denied"
						? "access_denied"
						: "temporarily_unavailable",
				clientId: pending.clientId,
				userId
			});
			throw error;
		}
		const code = randomBytes(32).toString("base64url");
		await this.deps.store.insertCode({
			codeHash: createHash("sha256").update(code).digest("hex"),
			clientId: pending.clientId,
			redirectUri: pending.redirectUri,
			codeChallenge: pending.codeChallenge,
			userId,
			expiresAt: new Date(Date.now() + 60_000)
		});
		this.deps.audit?.record({ code: "login_completed", clientId: pending.clientId, userId });
		return { redirectUri: pending.redirectUri, code, state: pending.clientState };
	};
}
