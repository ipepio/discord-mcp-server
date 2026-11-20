import { createHash, randomBytes, randomUUID } from "node:crypto";
import { REFRESH_TOKEN_GRACE_SECONDS, REFRESH_TOKEN_TTL_SECONDS } from "../authorization.constants.js";
import type { AuthorizationAudit } from "../models/domain/authorization-audit.js";
import type { RefreshTokenRecord } from "../models/domain/authorization-records.js";
import { OAuthError } from "../models/domain/oauth-error.js";
import type { RequireCurrentMembershipQuery } from "../queries/require-current-membership.query.js";
import type { AuthorizationStoreRepository } from "../repositories/authorization-store.repository.js";
import type { TokenPair } from "./token-pair.js";

/** Every refusal — unknown, malformed, consumed or expired — is this one response (R2: no oracle). */
const refusal = (): OAuthError => new OAuthError("invalid_grant", "The refresh token is invalid or expired.");

/**
 * `grant_type=refresh_token` (docs/features/session-refresh.md R2–R4, ADR 0009).
 *
 * Validation is family-based, not session-alive-based: a token is valid while it is unconsumed,
 * unexpired, from the requesting client, in a family that was not revoked and whose user still passes
 * the membership gate. Success consumes the presented token and issues a fresh pair in the same
 * family, anchored to a new session, so a 24-hour access token can be renewed for the family's 30-day
 * life without a human re-login.
 */
export class RotateRefreshTokenCommand {
	public constructor(
		private readonly deps: {
			readonly store: AuthorizationStoreRepository;
			readonly gate: RequireCurrentMembershipQuery;
			readonly now?: () => Date;
			readonly sessionTtlSeconds: number;
			readonly audit?: AuthorizationAudit;
		}
	) {}

	/** Substitutable clock: issued/consumed instants must be deterministic in tests. */
	private now(): Date {
		return this.deps.now?.() ?? new Date();
	}

	public readonly execute = async (input: {
		readonly refreshToken: string;
		readonly clientId: string;
	}): Promise<TokenPair> => {
		if (!/^[A-Za-z0-9_-]{43}$/.test(input.refreshToken)) throw refusal();
		const tokenHash = createHash("sha256").update(input.refreshToken).digest("hex");
		const now = this.now();
		const record = await this.deps.store.findRefreshToken(tokenHash, now, REFRESH_TOKEN_GRACE_SECONDS);
		if (!record || record.clientId !== input.clientId) throw refusal();
		// Reuse: a consumed token outside the accepted grace window is evidence the family leaked (R3).
		if (record.consumedAt !== null && !record.graceEligible) return this.reuse(record, now);
		if (record.consumedAt === null && record.expiresAt.getTime() <= now.getTime()) {
			// Routine expiry (R4): refused without touching the family, unlike reuse.
			this.deps.audit?.record({
				code: "refresh_expired",
				clientId: record.clientId,
				userId: record.userId,
				familyId: record.familyId
			});
			throw refusal();
		}
		// Fail closed: the membership gate is re-derived at every refresh, never frozen at login (R6/R10).
		await this.deps.gate.execute(record.userId);
		if (record.consumedAt === null) {
			const consumed = await this.deps.store.consumeRefreshToken(tokenHash, now);
			if (!consumed) {
				// A concurrent rotation consumed it between the read and the conditional write; decide again
				// with the same grace/reuse rule instead of guessing.
				const recheck = await this.deps.store.findRefreshToken(tokenHash, now, REFRESH_TOKEN_GRACE_SECONDS);
				if (!recheck || recheck.clientId !== input.clientId || !recheck.graceEligible)
					return this.reuse(record, now);
			}
		} else {
			// O-B: the single immediately-previous generation is accepted inside the window and stays consumed.
			this.deps.audit?.record({
				code: "refresh_grace_accepted",
				clientId: record.clientId,
				userId: record.userId,
				familyId: record.familyId
			});
		}
		return this.issue(record, now);
	};

	private readonly reuse = async (record: RefreshTokenRecord, now: Date): Promise<never> => {
		// The whole family and the sessions it issued die together; every later attempt fails identically.
		await this.deps.store.revokeRefreshFamily(record.familyId, now);
		this.deps.audit?.record({
			code: "refresh_reuse_detected",
			clientId: record.clientId,
			userId: record.userId,
			familyId: record.familyId
		});
		throw refusal();
	};

	private readonly issue = async (record: RefreshTokenRecord, now: Date): Promise<TokenPair> => {
		const accessToken = randomBytes(32).toString("base64url");
		const refreshToken = randomBytes(32).toString("base64url");
		const sessionId = randomUUID();
		await this.deps.store.insertSession({
			sessionId,
			tokenHash: createHash("sha256").update(accessToken).digest("hex"),
			// The user binding comes from the stored family, never from request input, and never changes.
			userId: record.userId,
			clientId: record.clientId,
			issuedAt: now,
			expiresAt: new Date(now.getTime() + this.deps.sessionTtlSeconds * 1000),
			revokedAt: null
		});
		await this.deps.store.insertRefreshToken({
			tokenHash: createHash("sha256").update(refreshToken).digest("hex"),
			clientId: record.clientId,
			sessionId,
			familyId: record.familyId,
			issuedAt: now,
			expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000)
		});
		this.deps.audit?.record({
			code: "refresh_rotated",
			clientId: record.clientId,
			userId: record.userId,
			sessionId,
			familyId: record.familyId
		});
		return {
			accessToken,
			refreshToken,
			expiresIn: this.deps.sessionTtlSeconds,
			refreshExpiresIn: REFRESH_TOKEN_TTL_SECONDS
		};
	};
}
