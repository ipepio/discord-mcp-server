import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ExchangeAuthorizationCodeCommand } from "../../src/features/authorization/commands/exchange-authorization-code.command.js";
import type { CompleteLoginCommand } from "../../src/features/authorization/commands/complete-login.command.js";
import { RevokeUserSessionsCommand } from "../../src/features/authorization/commands/revoke-user-sessions.command.js";
import { RotateRefreshTokenCommand } from "../../src/features/authorization/commands/rotate-refresh-token.command.js";
import { LoginController } from "../../src/features/authorization/controllers/login.controller.js";
import { AuthorizationAuditGateway } from "../../src/features/authorization/gateways/authorization-audit.gateway.js";
import { AuthenticateSessionQuery } from "../../src/features/authorization/queries/authenticate-session.query.js";
import { RequireCurrentMembershipQuery } from "../../src/features/authorization/queries/require-current-membership.query.js";
import { PostgresAuthorizationStoreRepository } from "../../src/features/authorization/repositories/postgres-authorization-store.repository.js";
import { StructuredLogger } from "../../src/shared/logging/structured-logger.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const verifier = "v".repeat(43);
const redirectUri = "https://client.example/cb";
const userId = "9007199254740993";

/** The controller's protocol response, captured instead of sent. */
interface ProtocolAnswer {
	readonly headers: Record<string, string>;
	readonly body: { value?: Record<string, unknown> };
	status(code: number): ProtocolAnswer;
	setHeader(name: string, value: string): void;
	json(value: unknown): void;
}

describe.skipIf(!HAS_TEST_DATABASE)("session refresh — isolated PostgreSQL", () => {
	let database: IsolatedTestDatabase;
	let store: PostgresAuthorizationStoreRepository;
	let status: "current" | "stale";
	let membership: "present" | "absent";
	let gate: RequireCurrentMembershipQuery;
	let exchange: ExchangeAuthorizationCodeCommand;
	let rotate: RotateRefreshTokenCommand;
	let tick: () => Date;
	let lines: string[];
	let audit: AuthorizationAuditGateway;
	let codeCounter = 0;

	const login = async (clientId = "client"): Promise<{ accessToken: string; refreshToken: string }> => {
		codeCounter += 1;
		const code = `authorization-code-${codeCounter}`;
		await store.insertCode({
			codeHash: hash(code),
			clientId,
			redirectUri,
			codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
			userId,
			expiresAt: new Date(Date.now() + 60_000)
		});
		return exchange.execute({
			grantType: "authorization_code",
			clientId,
			redirectUri,
			code,
			codeVerifier: verifier
		});
	};

	beforeAll(async () => {
		database = await openIsolatedTestDatabase("session_refresh");
		store = new PostgresAuthorizationStoreRepository(database.pool);
		await database.assertIsolation();
		for (const clientId of ["client", "other-client"])
			await store.insertClient({ clientId, redirectUris: [redirectUri], createdAt: new Date() });
	}, 60_000);

	beforeEach(() => {
		let current = new Date();
		tick = () => (current = new Date(current.getTime() + 1_000));
		status = "current";
		membership = "present";
		lines = [];
		audit = new AuthorizationAuditGateway(new StructuredLogger("debug", (line) => lines.push(line)));
		gate = new RequireCurrentMembershipQuery({
			status: { execute: async () => ({ status }) },
			membership: { execute: async () => ({ status: membership }) }
		});
		exchange = new ExchangeAuthorizationCodeCommand({ store, gate, sessionTtlSeconds: 300, audit, now: tick });
		rotate = new RotateRefreshTokenCommand({ store, gate, sessionTtlSeconds: 300, audit, now: tick });
	});

	afterAll(async () => {
		await database?.close();
	});

	/** A second refresh token of the same family and instant, for tie and sweep scenarios. */
	const plantFamilyToken = async (existingRefreshToken: string, consumedAt: Date): Promise<string> => {
		const head = await store.findRefreshToken(hash(existingRefreshToken), new Date(), 30);
		if (!head) throw new Error("the anchor token vanished");
		const token = `planted-${randomBytes(24).toString("hex")}`;
		await store.insertRefreshToken({
			tokenHash: hash(token),
			clientId: head.clientId,
			sessionId: head.sessionId,
			familyId: head.familyId,
			issuedAt: new Date(consumedAt.getTime() - 1_000),
			expiresAt: new Date(consumedAt.getTime() + 30 * 24 * 3_600_000)
		});
		await store.consumeRefreshToken(hash(token), consumedAt);
		return token;
	};

	it("token-response-reports-refresh-lifetime", async () => {
		codeCounter += 1;
		const code = `authorization-code-${codeCounter}`;
		await store.insertCode({
			codeHash: hash(code),
			clientId: "client",
			redirectUri,
			codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
			userId,
			expiresAt: new Date(Date.now() + 60_000)
		});
		const controller = new LoginController(
			{ execute: vi.fn() } as unknown as CompleteLoginCommand,
			exchange,
			rotate
		);
		const answer = (): ProtocolAnswer => {
			const headers: Record<string, string> = {};
			const body: { value?: Record<string, unknown> } = {};
			const captured: ProtocolAnswer = {
				headers,
				body,
				status: (_code: number) => captured,
				setHeader: (name: string, value: string): void => {
					headers[name] = value;
				},
				json: (value: unknown): void => {
					body.value = value as Record<string, unknown>;
				}
			};
			return captured;
		};
		/** The lifetime the hub just stored for a credential, in whole seconds. */
		const issuedLifetime = async (token: string): Promise<number> => {
			const row = await store.findRefreshToken(hash(token), new Date(), 30);
			if (!row) throw new Error("the issued refresh token has no row");
			return (row.expiresAt.getTime() - row.issuedAt.getTime()) / 1000;
		};
		const shape = ["access_token", "expires_in", "refresh_expires_in", "refresh_token", "token_type"];

		const loginAnswer = answer();
		await controller.token(
			{
				grant_type: "authorization_code",
				client_id: "client",
				redirect_uri: redirectUri,
				code,
				code_verifier: verifier
			},
			loginAnswer
		);
		const loginBody = loginAnswer.body.value ?? {};
		expect(Object.keys(loginBody).sort()).toEqual(shape);
		expect(loginBody).toMatchObject({ token_type: "Bearer", expires_in: 300 });
		const loginRefresh = String(loginBody["refresh_token"]);
		expect(loginBody["refresh_expires_in"]).toBe(await issuedLifetime(loginRefresh));
		expect(loginBody["refresh_expires_in"]).toBe(2_592_000);

		const rotatedAnswer = answer();
		await controller.token(
			{ grant_type: "refresh_token", refresh_token: loginRefresh, client_id: "client" },
			rotatedAnswer
		);
		const rotatedBody = rotatedAnswer.body.value ?? {};
		const rotatedRefresh = String(rotatedBody["refresh_token"]);
		expect(Object.keys(rotatedBody).sort()).toEqual(shape);
		expect(rotatedRefresh).not.toBe(loginRefresh);
		// The rotation re-issues from zero: the reported lifetime describes the token in this same body.
		expect(rotatedBody["refresh_expires_in"]).toBe(await issuedLifetime(rotatedRefresh));
		expect(rotatedBody["refresh_expires_in"]).toBe(2_592_000);
	});

	it("refresh-rotates-single-use", async () => {
		const first = await login();
		const second = await rotate.execute({ refreshToken: first.refreshToken, clientId: "client" });
		expect(second.refreshToken).not.toBe(first.refreshToken);
		expect(second.accessToken).not.toBe(first.accessToken);
		// The presented token is consumed exactly once; a second consumption is impossible.
		const consumed = await store.findRefreshToken(hash(first.refreshToken), new Date(), 30);
		expect(consumed?.consumedAt).not.toBeNull();
		expect(await store.consumeRefreshToken(hash(first.refreshToken), new Date())).toBeNull();
		// The rotation descends from the same family, in a new session, with the same user binding.
		const head = await store.findRefreshToken(hash(second.refreshToken), new Date(), 30);
		expect(head).toMatchObject({ familyId: consumed?.familyId, userId, consumedAt: null });
		expect(head?.sessionId).not.toBe(consumed?.sessionId);
		// Boundary: the access token issued at login stays valid until its own expiry.
		expect(await store.findActiveSession(hash(first.accessToken), new Date())).not.toBeNull();
		expect(await store.findActiveSession(hash(second.accessToken), new Date())).not.toBeNull();
	});

	it("refresh-reuse-revokes-family", async () => {
		const first = await login();
		const second = await rotate.execute({ refreshToken: first.refreshToken, clientId: "client" });
		const third = await rotate.execute({ refreshToken: second.refreshToken, clientId: "client" });
		// Replaying the oldest generation is reuse: it is consumed and is not the family's latest.
		await expect(rotate.execute({ refreshToken: first.refreshToken, clientId: "client" })).rejects.toMatchObject({
			code: "invalid_grant"
		});
		// The legitimate current token is dead too, and so are the sessions the family issued.
		await expect(rotate.execute({ refreshToken: third.refreshToken, clientId: "client" })).rejects.toMatchObject({
			code: "invalid_grant"
		});
		for (const token of [second.accessToken, third.accessToken])
			expect(await store.findActiveSession(hash(token), new Date())).toBeNull();
		expect(lines.join("\n")).toContain("refresh_reuse_detected");
	});

	it("a same-instant consumption tie is never grace-eligible (fail-closed)", async () => {
		// Two rotations consumed in the SAME instant: neither is the single latest consumption, so
		// replaying either is reuse and revokes the family — the grace cannot be confused by ties.
		const first = await login();
		const now = new Date();
		await store.consumeRefreshToken(hash(first.refreshToken), now);
		const planted = await plantFamilyToken(first.refreshToken, now);
		await store.consumeRefreshToken(hash(planted), now);
		await expect(rotate.execute({ refreshToken: first.refreshToken, clientId: "client" })).rejects.toMatchObject({
			code: "invalid_grant"
		});
	});

	it("refresh-expired-refused", async () => {
		const first = await login();
		const [row] = (
			await database.pool.query<{ token_hash: string; family_id: string }>(
				"SELECT token_hash, family_id FROM oauth_refresh_token WHERE token_hash = $1",
				[hash(first.refreshToken)]
			)
		).rows;
		const revoked = vi.spyOn(store, "revokeRefreshFamily");
		await database.pool.query(
			"UPDATE oauth_refresh_token SET issued_at = $2, expires_at = $3 WHERE token_hash = $1",
			[hash(first.refreshToken), new Date(Date.now() - 120_000), new Date(Date.now() - 60_000)]
		);
		await expect(rotate.execute({ refreshToken: first.refreshToken, clientId: "client" })).rejects.toMatchObject({
			code: "invalid_grant"
		});
		// Routine expiry is not a leak signal: no family revocation, no consumption.
		expect(revoked).not.toHaveBeenCalled();
		const stored = await store.findRefreshToken(hash(first.refreshToken), new Date(), 30);
		expect(stored).toMatchObject({ consumedAt: null, familyId: row?.family_id });
		expect(lines.join("\n")).toContain("refresh_expired");
		revoked.mockRestore();
	});

	it("refresh-revoked-with-membership", async () => {
		const first = await login();
		const revoke = new RevokeUserSessionsCommand({ store, logger: new StructuredLogger("debug", () => undefined) });
		expect(await revoke.execute(userId)).toBeGreaterThanOrEqual(1);
		await expect(rotate.execute({ refreshToken: first.refreshToken, clientId: "client" })).rejects.toMatchObject({
			code: "invalid_grant"
		});
		expect(await store.findActiveSession(hash(first.accessToken), new Date())).toBeNull();
	});

	it("access-token-permissions-still-live", async () => {
		const first = await login();
		const refreshed = await rotate.execute({ refreshToken: first.refreshToken, clientId: "client" });
		const query = new AuthenticateSessionQuery({ store, gate });
		const result = await query.execute(refreshed.accessToken);
		expect(result).toMatchObject({
			authenticated: true,
			principal: { userId, sessionId: expect.any(String) }
		});
		expect(JSON.stringify(result)).not.toContain("permission");
		// A mid-session membership change applies on the next read: nothing was frozen by the refresh.
		membership = "absent";
		expect(await query.execute(refreshed.accessToken)).toEqual({ authenticated: false, outcome: "invalid" });
		membership = "present";
		expect(await query.execute(refreshed.accessToken)).toMatchObject({ authenticated: true });
	});

	it("log-safety: no token or hash material, audit carries ids and outcome codes only", async () => {
		const first = await login();
		const second = await rotate.execute({ refreshToken: first.refreshToken, clientId: "client" });
		const third = await rotate.execute({ refreshToken: second.refreshToken, clientId: "client" });
		await expect(rotate.execute({ refreshToken: first.refreshToken, clientId: "client" })).rejects.toBeTruthy();
		const output = lines.join("\n");
		for (const secret of [
			first.accessToken,
			first.refreshToken,
			second.accessToken,
			second.refreshToken,
			third.accessToken,
			third.refreshToken,
			hash(first.refreshToken),
			hash(second.refreshToken),
			hash(third.refreshToken)
		])
			expect(output).not.toContain(secret);
		const outcomes = lines
			.map((line) => JSON.parse(line) as { message: string; fields: Record<string, unknown> })
			.filter((line) => line.message === "authorization outcome")
			.map((line) => line.fields);
		expect(outcomes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "refresh_rotated", familyId: expect.any(String) }),
				expect.objectContaining({ code: "refresh_reuse_detected", familyId: expect.any(String) })
			])
		);
		expect(output).not.toMatch(/"code":"server_error"/);
	});
});
