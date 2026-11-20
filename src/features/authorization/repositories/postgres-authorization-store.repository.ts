import type {
	AuthorizationCode,
	HubSession,
	NewHubSession,
	NewRefreshToken,
	PendingAuthorizationRequest,
	RefreshTokenLookup,
	RefreshTokenRecord,
	RegisteredClient
} from "../models/domain/authorization-records.js";
import type { AuthorizationStoreRepository } from "./authorization-store.repository.js";

/** Structural pool seam, owned here rather than imported from a sibling's private adapter. */
export interface AuthorizationSqlExecutor {
	readonly query: <Row = Record<string, unknown>>(
		statement: string,
		parameters?: readonly unknown[]
	) => Promise<{ readonly rows: readonly Row[] }>;
}

type ClientRow = { client_id: string; redirect_uris: string[]; created_at: Date };
type PendingRow = {
	discord_state: string;
	client_id: string;
	redirect_uri: string;
	client_state: string;
	code_challenge: string;
	expires_at: Date;
};
type CodeRow = {
	code_hash: string;
	client_id: string;
	redirect_uri: string;
	code_challenge: string;
	user_id: string;
	expires_at: Date;
};
type SessionRow = {
	session_id: string;
	user_id: string;
	client_id: string;
	issued_at: Date;
	expires_at: Date;
	revoked_at: Date | null;
};
type RefreshTokenRow = {
	token_hash: string;
	client_id: string;
	session_id: string;
	family_id: string;
	user_id: string;
	issued_at: Date;
	expires_at: Date;
	consumed_at: Date | null;
};
type RefreshTokenLookupRow = RefreshTokenRow & { grace_eligible: boolean };

function refreshTokenRecord(row: RefreshTokenRow): RefreshTokenRecord {
	return {
		tokenHash: row.token_hash,
		clientId: row.client_id,
		sessionId: row.session_id,
		familyId: row.family_id,
		userId: row.user_id,
		issuedAt: row.issued_at,
		expiresAt: row.expires_at,
		consumedAt: row.consumed_at
	};
}

export class PostgresAuthorizationStoreRepository implements AuthorizationStoreRepository {
	public constructor(private readonly executor: AuthorizationSqlExecutor) {}

	public readonly insertClient = async (client: RegisteredClient): Promise<void> => {
		await this.executor.query(
			"INSERT INTO oauth_client (client_id, redirect_uris, created_at) VALUES ($1, $2, $3)",
			[client.clientId, client.redirectUris, client.createdAt]
		);
	};

	public readonly findClient = async (clientId: string): Promise<RegisteredClient | null> => {
		const { rows } = await this.executor.query<ClientRow>(
			"SELECT client_id, redirect_uris, created_at FROM oauth_client WHERE client_id = $1",
			[clientId]
		);
		const row = rows[0];
		return row ? { clientId: row.client_id, redirectUris: row.redirect_uris, createdAt: row.created_at } : null;
	};

	public readonly insertPendingRequest = async (request: PendingAuthorizationRequest): Promise<void> => {
		await this.executor.query(
			`INSERT INTO oauth_pending_request
			(discord_state, client_id, redirect_uri, client_state, code_challenge, expires_at)
			VALUES ($1, $2, $3, $4, $5, $6)`,
			[
				request.discordState,
				request.clientId,
				request.redirectUri,
				request.clientState,
				request.codeChallenge,
				request.expiresAt
			]
		);
	};

	public readonly consumePendingRequest = async (
		discordState: string,
		now: Date
	): Promise<PendingAuthorizationRequest | null> => {
		const { rows } = await this.executor.query<PendingRow>(
			`DELETE FROM oauth_pending_request WHERE discord_state = $1
			RETURNING discord_state, client_id, redirect_uri, client_state, code_challenge, expires_at`,
			[discordState]
		);
		const row = rows[0];
		return row && row.expires_at > now
			? {
					discordState: row.discord_state,
					clientId: row.client_id,
					redirectUri: row.redirect_uri,
					clientState: row.client_state,
					codeChallenge: row.code_challenge,
					expiresAt: row.expires_at
				}
			: null;
	};

	public readonly insertCode = async (code: AuthorizationCode): Promise<void> => {
		await this.executor.query(
			`INSERT INTO oauth_authorization_code
			(code_hash, client_id, redirect_uri, code_challenge, user_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
			[code.codeHash, code.clientId, code.redirectUri, code.codeChallenge, code.userId, code.expiresAt]
		);
	};

	public readonly consumeCode = async (codeHash: string, now: Date): Promise<AuthorizationCode | null> => {
		const { rows } = await this.executor.query<CodeRow>(
			`DELETE FROM oauth_authorization_code WHERE code_hash = $1
			RETURNING code_hash, client_id, redirect_uri, code_challenge, user_id, expires_at`,
			[codeHash]
		);
		const row = rows[0];
		return row && row.expires_at > now
			? {
					codeHash: row.code_hash,
					clientId: row.client_id,
					redirectUri: row.redirect_uri,
					codeChallenge: row.code_challenge,
					userId: row.user_id,
					expiresAt: row.expires_at
				}
			: null;
	};

	public readonly insertSession = async (session: NewHubSession): Promise<void> => {
		await this.executor.query(
			`INSERT INTO hub_session (session_id, token_hash, user_id, client_id, issued_at, expires_at, revoked_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			[
				session.sessionId,
				session.tokenHash,
				session.userId,
				session.clientId,
				session.issuedAt,
				session.expiresAt,
				session.revokedAt
			]
		);
	};

	public readonly findActiveSession = async (tokenHash: string, now: Date): Promise<HubSession | null> => {
		const { rows } = await this.executor.query<SessionRow>(
			`SELECT session_id, user_id, client_id, issued_at, expires_at, revoked_at FROM hub_session
			WHERE token_hash = $1 AND expires_at > $2 AND revoked_at IS NULL`,
			[tokenHash, now]
		);
		const row = rows[0];
		return row
			? {
					sessionId: row.session_id,
					userId: row.user_id,
					clientId: row.client_id,
					issuedAt: row.issued_at,
					expiresAt: row.expires_at,
					revokedAt: row.revoked_at
				}
			: null;
	};

	public readonly findSessionByTokenHash = async (tokenHash: string): Promise<HubSession | null> => {
		const { rows } = await this.executor.query<SessionRow>(
			`SELECT session_id, user_id, client_id, issued_at, expires_at, revoked_at FROM hub_session
			WHERE token_hash = $1
			LIMIT 1`,
			[tokenHash]
		);
		const row = rows[0];
		return row
			? {
					sessionId: row.session_id,
					userId: row.user_id,
					clientId: row.client_id,
					issuedAt: row.issued_at,
					expiresAt: row.expires_at,
					revokedAt: row.revoked_at
				}
			: null;
	};

	public readonly revokeSession = async (sessionId: string, now: Date): Promise<number> => {
		const { rows } = await this.executor.query(
			"UPDATE hub_session SET revoked_at = $2 WHERE session_id = $1 AND revoked_at IS NULL RETURNING session_id",
			[sessionId, now]
		);
		return rows.length;
	};

	public readonly revokeUserSessions = async (userId: string, now: Date): Promise<number> => {
		const { rows } = await this.executor.query(
			"UPDATE hub_session SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL RETURNING session_id",
			[userId, now]
		);
		return rows.length;
	};

	public readonly insertRefreshToken = async (token: NewRefreshToken): Promise<void> => {
		await this.executor.query(
			`INSERT INTO oauth_refresh_token (token_hash, client_id, session_id, family_id, issued_at, expires_at, consumed_at)
			VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
			[token.tokenHash, token.clientId, token.sessionId, token.familyId, token.issuedAt, token.expiresAt]
		);
	};

	public readonly findRefreshToken = async (
		tokenHash: string,
		now: Date,
		graceSeconds: number
	): Promise<RefreshTokenLookup | null> => {
		const graceStart = new Date(now.getTime() - graceSeconds * 1000);
		// The grace acceptance (O-B) is a property of the family's latest consumption with a live head left in
		// it. A membership-end sweep consumes every row, so it leaves no live head and can never be graced.
		const { rows } = await this.executor.query<RefreshTokenLookupRow>(
			`SELECT r.token_hash, r.client_id, r.session_id, r.family_id, r.issued_at, r.expires_at, r.consumed_at,
				s.user_id,
				(r.consumed_at IS NOT NULL AND r.consumed_at > $2
					AND r.consumed_at = (SELECT MAX(f.consumed_at) FROM oauth_refresh_token f WHERE f.family_id = r.family_id)
					AND EXISTS (SELECT 1 FROM oauth_refresh_token u WHERE u.family_id = r.family_id AND u.consumed_at IS NULL)
				) AS grace_eligible
			FROM oauth_refresh_token r JOIN hub_session s ON s.session_id = r.session_id
			WHERE r.token_hash = $1`,
			[tokenHash, graceStart]
		);
		const row = rows[0];
		return row ? { ...refreshTokenRecord(row), graceEligible: row.grace_eligible } : null;
	};

	public readonly consumeRefreshToken = async (tokenHash: string, now: Date): Promise<RefreshTokenRecord | null> => {
		const { rows } = await this.executor.query<RefreshTokenRow>(
			`WITH consumed AS (
				UPDATE oauth_refresh_token SET consumed_at = $2
				WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2
				RETURNING token_hash, client_id, session_id, family_id, issued_at, expires_at, consumed_at
			)
			SELECT c.token_hash, c.client_id, c.session_id, c.family_id, c.issued_at, c.expires_at, c.consumed_at, s.user_id
			FROM consumed c JOIN hub_session s ON s.session_id = c.session_id`,
			[tokenHash, now]
		);
		const row = rows[0];
		return row ? refreshTokenRecord(row) : null;
	};

	public readonly revokeRefreshFamily = async (familyId: string, now: Date): Promise<number> => {
		await this.executor.query(
			`UPDATE hub_session SET revoked_at = $2 WHERE revoked_at IS NULL AND session_id IN
			(SELECT session_id FROM oauth_refresh_token WHERE family_id = $1)
			RETURNING session_id`,
			[familyId, now]
		);
		const tokens = await this.executor.query(
			`UPDATE oauth_refresh_token SET consumed_at = $2 WHERE family_id = $1 AND consumed_at IS NULL
			RETURNING token_hash`,
			[familyId, now]
		);
		return tokens.rows.length;
	};

	public readonly revokeUserRefreshTokens = async (userId: string, now: Date): Promise<number> => {
		const { rows } = await this.executor.query(
			`UPDATE oauth_refresh_token SET consumed_at = $2 WHERE consumed_at IS NULL AND session_id IN
			(SELECT session_id FROM hub_session WHERE user_id = $1)
			RETURNING token_hash`,
			[userId, now]
		);
		return rows.length;
	};

	public readonly deleteExpiredRefreshTokens = async (now: Date, limit: number): Promise<number> => {
		if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
			throw new Error("Invalid authorization purge batch size");
		const { rows } = await this.executor.query(
			`DELETE FROM oauth_refresh_token WHERE token_hash IN
			(SELECT token_hash FROM oauth_refresh_token WHERE expires_at <= $1 ORDER BY expires_at, token_hash LIMIT $2 FOR UPDATE SKIP LOCKED)
			RETURNING token_hash`,
			[now, limit]
		);
		return rows.length;
	};

	public readonly deleteDeadRefreshFamilyTokens = async (now: Date, limit: number): Promise<number> => {
		if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
			throw new Error("Invalid authorization purge batch size");
		// Revoked families have no live head. Expired rows are left to the expiry sweep so each category stays
		// independently attributable.
		const { rows } = await this.executor.query(
			`DELETE FROM oauth_refresh_token WHERE token_hash IN
			(SELECT r.token_hash FROM oauth_refresh_token r
			WHERE r.consumed_at IS NOT NULL
				AND r.expires_at > $1
				AND NOT EXISTS (SELECT 1 FROM oauth_refresh_token live WHERE live.family_id = r.family_id AND live.consumed_at IS NULL)
			ORDER BY r.expires_at, r.token_hash LIMIT $2 FOR UPDATE SKIP LOCKED)
			RETURNING token_hash`,
			[now, limit]
		);
		return rows.length;
	};

	public readonly purgeExpired = async (now: Date, limit: number): Promise<number> => {
		if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
			throw new Error("Invalid authorization purge batch size");
		// Fixed SQL per table: identifiers never originate in a caller's input. Refresh tokens go first: an
		// unexpired family row is what keeps its anchor session row (whose access token may already have
		// expired) alive for the rest of the 30-day window.
		const refreshTokens = await this.deleteExpiredRefreshTokens(now, limit);
		const deadFamilies = await this.deleteDeadRefreshFamilyTokens(now, limit);
		const sessions = await this.executor.query(
			`DELETE FROM hub_session WHERE session_id IN
			(SELECT s.session_id FROM hub_session s
			WHERE s.expires_at <= $1
				AND NOT EXISTS (SELECT 1 FROM oauth_refresh_token r WHERE r.session_id = s.session_id)
			ORDER BY s.expires_at, s.session_id LIMIT $2 FOR UPDATE SKIP LOCKED)
			RETURNING session_id`,
			[now, limit]
		);
		const pending = await this.executor.query(
			`DELETE FROM oauth_pending_request WHERE discord_state IN
			(SELECT discord_state FROM oauth_pending_request WHERE expires_at <= $1 ORDER BY expires_at, discord_state LIMIT $2 FOR UPDATE SKIP LOCKED)
			RETURNING client_id`,
			[now, limit]
		);
		const codes = await this.executor.query(
			`DELETE FROM oauth_authorization_code WHERE code_hash IN
			(SELECT code_hash FROM oauth_authorization_code WHERE expires_at <= $1 ORDER BY expires_at, code_hash LIMIT $2 FOR UPDATE SKIP LOCKED)
			RETURNING client_id`,
			[now, limit]
		);
		return refreshTokens + deadFamilies + sessions.rows.length + pending.rows.length + codes.rows.length;
	};
}
