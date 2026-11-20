import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AuthorizationAudit } from "../models/domain/authorization-audit.js";
import { OAuthError } from "../models/domain/oauth-error.js";
import type { RequireCurrentMembershipQuery } from "../queries/require-current-membership.query.js";
import type { AuthorizationStoreRepository } from "../repositories/authorization-store.repository.js";
import { REFRESH_TOKEN_TTL_SECONDS } from "../authorization.constants.js";
import type { TokenPair } from "./token-pair.js";

export class ExchangeAuthorizationCodeCommand {
	public constructor(
		private readonly deps: {
			readonly now?: () => Date;
			readonly store: AuthorizationStoreRepository;
			readonly gate: RequireCurrentMembershipQuery;
			readonly sessionTtlSeconds: number;
			readonly audit?: AuthorizationAudit;
		}
	) {}

	/** Substitutable clock: issued/consumed instants must be deterministic in tests. */
	private now(): Date {
		return this.deps.now?.() ?? new Date();
	}

	public readonly execute = async (input: {
		readonly grantType: string;
		readonly clientId: string;
		readonly redirectUri: string;
		readonly code: string;
		readonly codeVerifier: string;
	}): Promise<TokenPair> => {
		if (input.grantType !== "authorization_code")
			throw new OAuthError("unsupported_grant_type", "The requested grant type is not supported.");
		const code = await this.deps.store.consumeCode(
			createHash("sha256").update(input.code).digest("hex"),
			this.now()
		);
		const challenge = createHash("sha256").update(input.codeVerifier).digest("base64url");
		if (
			!code ||
			code.clientId !== input.clientId ||
			code.redirectUri !== input.redirectUri ||
			!/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier) ||
			code.codeChallenge.length !== challenge.length ||
			!timingSafeEqual(Buffer.from(code.codeChallenge), Buffer.from(challenge))
		) {
			if (code) this.deps.audit?.record({ code: "invalid_grant", clientId: code.clientId });
			throw new OAuthError("invalid_grant", "The authorization code or PKCE verification is invalid.");
		}
		await this.deps.gate.execute(code.userId);
		const accessToken = randomBytes(32).toString("base64url");
		const refreshToken = randomBytes(32).toString("base64url");
		const now = this.now();
		const sessionId = randomUUID();
		await this.deps.store.insertSession({
			sessionId,
			tokenHash: createHash("sha256").update(accessToken).digest("hex"),
			userId: code.userId,
			clientId: code.clientId,
			issuedAt: now,
			expiresAt: new Date(now.getTime() + this.deps.sessionTtlSeconds * 1000),
			revokedAt: null
		});
		// One family per login; every rotation descends from this token and shares its family id (R1).
		const familyId = randomUUID();
		await this.deps.store.insertRefreshToken({
			tokenHash: createHash("sha256").update(refreshToken).digest("hex"),
			clientId: code.clientId,
			sessionId,
			familyId,
			issuedAt: now,
			expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000)
		});
		this.deps.audit?.record({
			code: "session_issued",
			clientId: code.clientId,
			userId: code.userId,
			sessionId,
			familyId
		});
		return {
			accessToken,
			refreshToken,
			expiresIn: this.deps.sessionTtlSeconds,
			refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS
		};
	};
}
