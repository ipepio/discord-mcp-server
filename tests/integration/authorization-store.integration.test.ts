import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAuthorizationStoreRepository } from "../../src/features/authorization/repositories/postgres-authorization-store.repository.js";
import type { IsolatedTestDatabase } from "./postgres-test-database.js";
import { HAS_TEST_DATABASE, openIsolatedTestDatabase } from "./postgres-test-database.js";

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");
const now = new Date("2026-11-06T12:00:00Z");
const future = new Date(now.getTime() + 600_000);
const past = new Date(now.getTime() - 600_000);

describe.skipIf(!HAS_TEST_DATABASE)("authorization store — isolated PostgreSQL", () => {
	let database: IsolatedTestDatabase;
	let store: PostgresAuthorizationStoreRepository;
	beforeAll(async () => {
		database = await openIsolatedTestDatabase("authorization");
		store = new PostgresAuthorizationStoreRepository(database.pool);
		await database.assertIsolation();
		await store.insertClient({
			clientId: "client",
			redirectUris: ["https://client.example/cb", "http://127.0.0.1:1234/cb"],
			createdAt: now
		});
	}, 60_000);
	afterAll(async () => {
		await database?.close();
	});

	it("persists exact redirect sets and does not invent missing clients", async () => {
		expect(await store.findClient("client")).toEqual({
			clientId: "client",
			redirectUris: ["https://client.example/cb", "http://127.0.0.1:1234/cb"],
			createdAt: now
		});
		expect(await store.findClient("unknown")).toBeNull();
	});

	it("consumes a pending request atomically under concurrent callbacks", async () => {
		const request = {
			discordState: "pending-concurrent",
			clientId: "client",
			redirectUri: "https://client.example/cb",
			clientState: "opaque client state + /",
			codeChallenge: "challenge",
			expiresAt: future
		};
		await store.insertPendingRequest(request);
		const results = await Promise.all([
			store.consumePendingRequest(request.discordState, now),
			store.consumePendingRequest(request.discordState, now)
		]);
		expect(results.filter(Boolean)).toEqual([request]);
		expect(await store.consumePendingRequest(request.discordState, now)).toBeNull();
	});

	it("burns expired pending requests and authorization codes", async () => {
		await store.insertPendingRequest({
			discordState: "expired-state",
			clientId: "client",
			redirectUri: "https://client.example/cb",
			clientState: "state",
			codeChallenge: "challenge",
			expiresAt: past
		});
		expect(await store.consumePendingRequest("expired-state", now)).toBeNull();
		await store.insertCode({
			codeHash: hash("expired-code"),
			clientId: "client",
			redirectUri: "https://client.example/cb",
			codeChallenge: "challenge",
			userId: "9007199254740993",
			expiresAt: past
		});
		expect(await store.consumeCode(hash("expired-code"), now)).toBeNull();
	});

	it("authorization codes have one consumer even when redemption races", async () => {
		const code = {
			codeHash: hash("code"),
			clientId: "client",
			redirectUri: "https://client.example/cb",
			codeChallenge: "challenge",
			userId: "9007199254740993",
			expiresAt: future
		};
		await store.insertCode(code);
		const results = await Promise.all([
			store.consumeCode(code.codeHash, now),
			store.consumeCode(code.codeHash, now)
		]);
		expect(results.filter(Boolean)).toEqual([code]);
	});

	it("looks up by hash only, preserves bigint ids, and never returns token hashes", async () => {
		await store.insertSession({
			sessionId: "session-one",
			tokenHash: hash("opaque-token"),
			userId: "9007199254740993",
			clientId: "client",
			issuedAt: past,
			expiresAt: future,
			revokedAt: null
		});
		expect(await store.findActiveSession("opaque-token", now)).toBeNull();
		expect(await store.findActiveSession(hash("unknown"), now)).toBeNull();
		const session = await store.findActiveSession(hash("opaque-token"), now);
		expect(session?.userId).toBe("9007199254740993");
		expect(session).not.toHaveProperty("tokenHash");
		const columns = await database.pool.query<{ column_name: string }>(
			"SELECT column_name FROM information_schema.columns WHERE table_name = 'hub_session'"
		);
		expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
			"client_id",
			"expires_at",
			"issued_at",
			"revoked_at",
			"session_id",
			"token_hash",
			"user_id"
		]);
	});

	it("enforces expiry at the exact boundary without cleanup", async () => {
		await store.insertSession({
			sessionId: "expired-session",
			tokenHash: hash("expired-token"),
			userId: "2",
			clientId: "client",
			issuedAt: past,
			expiresAt: now,
			revokedAt: null
		});
		expect(await store.findActiveSession(hash("expired-token"), now)).toBeNull();
	});

	it("revokes one session independently and all user sessions idempotently", async () => {
		for (const id of ["a", "b"])
			await store.insertSession({
				sessionId: id,
				tokenHash: hash(id),
				userId: "3",
				clientId: "client",
				issuedAt: now,
				expiresAt: future,
				revokedAt: null
			});
		expect(await store.revokeSession("a", now)).toBe(1);
		expect(await store.findActiveSession(hash("a"), now)).toBeNull();
		expect(await store.findActiveSession(hash("b"), now)).not.toBeNull();
		expect(await store.revokeUserSessions("3", now)).toBe(1);
		expect(await store.revokeUserSessions("3", now)).toBe(0);
		expect(await store.revokeUserSessions("4", now)).toBe(0);
		expect(await store.findActiveSession(hash("b"), now)).toBeNull();
	});

	it("purges expired material in bounded batches and rejects unbounded limits", async () => {
		for (let i = 0; i < 3; i++)
			await store.insertPendingRequest({
				discordState: `purge-${i}`,
				clientId: "client",
				redirectUri: "https://client.example/cb",
				clientState: "state",
				codeChallenge: "challenge",
				expiresAt: past
			});
		expect(await store.purgeExpired(now, 1)).toBeLessThanOrEqual(3);
		const remaining = await database.pool.query<{ count: string }>(
			"SELECT count(*) FROM oauth_pending_request WHERE discord_state LIKE 'purge-%'"
		);
		expect(remaining.rows[0]?.count).toBe("2");
		await expect(store.purgeExpired(now, 0)).rejects.toThrow("batch size");
	});

	it("enforces the refresh-token CHECK constraints live", async () => {
		await expect(
			store.insertRefreshToken({
				tokenHash: "not-a-sha256-hex",
				clientId: "client",
				sessionId: "a",
				familyId: randomUUID(),
				issuedAt: now,
				expiresAt: future
			})
		).rejects.toThrow();
		await expect(
			store.insertRefreshToken({
				tokenHash: hash("bad-expiry"),
				clientId: "client",
				sessionId: "a",
				familyId: randomUUID(),
				issuedAt: now,
				expiresAt: now
			})
		).rejects.toThrow();
	});

	it("consumes a refresh token exactly once and keeps the row as reuse evidence", async () => {
		await store.insertSession({
			sessionId: "refresh-session-1",
			tokenHash: hash("refresh-access-1"),
			userId: "17",
			clientId: "client",
			issuedAt: now,
			expiresAt: future,
			revokedAt: null
		});
		const token = {
			tokenHash: hash("refresh-one"),
			clientId: "client",
			sessionId: "refresh-session-1",
			familyId: randomUUID(),
			issuedAt: now,
			expiresAt: future
		};
		await store.insertRefreshToken(token);
		expect(await store.findRefreshToken(token.tokenHash, now, 30)).toMatchObject({
			userId: "17",
			consumedAt: null,
			graceEligible: false
		});
		const consumed = await store.consumeRefreshToken(token.tokenHash, now);
		expect(consumed).toMatchObject({ tokenHash: token.tokenHash, userId: "17", consumedAt: now });
		expect(await store.consumeRefreshToken(token.tokenHash, now)).toBeNull();
		expect((await store.findRefreshToken(token.tokenHash, now, 30))?.consumedAt).toEqual(now);
	});

	it("offers grace only for the latest consumption of a family with a live head", async () => {
		const familyId = randomUUID();
		const first = {
			tokenHash: hash("grace-first"),
			clientId: "client",
			sessionId: "refresh-session-1",
			familyId,
			issuedAt: past,
			expiresAt: future
		};
		await store.insertRefreshToken(first);
		expect(await store.consumeRefreshToken(first.tokenHash, now)).not.toBeNull();
		await store.insertRefreshToken({
			tokenHash: hash("grace-second"),
			clientId: "client",
			sessionId: "refresh-session-1",
			familyId,
			issuedAt: now,
			expiresAt: future
		});
		expect(
			(await store.findRefreshToken(first.tokenHash, new Date(now.getTime() + 10_000), 30))?.graceEligible
		).toBe(true);
		expect(
			(await store.findRefreshToken(first.tokenHash, new Date(now.getTime() + 31_000), 30))?.graceEligible
		).toBe(false);
		// A revoked family has no live head, so it can never be graced back to life.
		expect(await store.revokeRefreshFamily(familyId, now)).toBe(1);
		expect((await store.findRefreshToken(first.tokenHash, now, 30))?.graceEligible).toBe(false);
	});

	it("revokes a whole family and its sessions, and sweeps a user's families", async () => {
		const familyId = randomUUID();
		await store.insertSession({
			sessionId: "refresh-family-session",
			tokenHash: hash("refresh-family-access"),
			userId: "18",
			clientId: "client",
			issuedAt: now,
			expiresAt: future,
			revokedAt: null
		});
		for (const name of ["family-a", "family-b"])
			await store.insertRefreshToken({
				tokenHash: hash(name),
				clientId: "client",
				sessionId: "refresh-family-session",
				familyId,
				issuedAt: now,
				expiresAt: future
			});
		expect(await store.revokeRefreshFamily(familyId, now)).toBe(2);
		expect(await store.revokeRefreshFamily(familyId, now)).toBe(0);
		expect(await store.findActiveSession(hash("refresh-family-access"), now)).toBeNull();
		for (const name of ["family-a", "family-b"])
			expect((await store.findRefreshToken(hash(name), now, 30))?.consumedAt).toEqual(now);

		const userFamily = randomUUID();
		await store.insertSession({
			sessionId: "refresh-user-session",
			tokenHash: hash("refresh-user-access"),
			userId: "19",
			clientId: "client",
			issuedAt: now,
			expiresAt: future,
			revokedAt: null
		});
		await store.insertRefreshToken({
			tokenHash: hash("user-family"),
			clientId: "client",
			sessionId: "refresh-user-session",
			familyId: userFamily,
			issuedAt: now,
			expiresAt: future
		});
		expect(await store.revokeUserRefreshTokens("19", now)).toBe(1);
		expect(await store.revokeUserRefreshTokens("19", now)).toBe(0);
	});

	it("purges expired refresh tokens but keeps the anchor session of a live family", async () => {
		const familyId = randomUUID();
		await store.insertSession({
			sessionId: "refresh-anchor-session",
			tokenHash: hash("refresh-anchor-access"),
			userId: "20",
			clientId: "client",
			issuedAt: past,
			expiresAt: new Date(now.getTime() - 1_000),
			revokedAt: null
		});
		await store.insertRefreshToken({
			tokenHash: hash("anchor-live"),
			clientId: "client",
			sessionId: "refresh-anchor-session",
			familyId,
			issuedAt: now,
			expiresAt: future
		});
		await store.insertRefreshToken({
			tokenHash: hash("anchor-expired"),
			clientId: "client",
			sessionId: "refresh-anchor-session",
			familyId,
			issuedAt: new Date(now.getTime() - 700_000),
			expiresAt: past
		});
		expect(await store.deleteExpiredRefreshTokens(now, 10)).toBe(1);
		await store.purgeExpired(now, 10);
		const anchor = await database.pool.query<{ total: string }>(
			"SELECT count(*) AS total FROM hub_session WHERE session_id = 'refresh-anchor-session'"
		);
		expect(anchor.rows[0]?.total).toBe("1");
	});
});
