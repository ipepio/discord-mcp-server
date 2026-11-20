import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ExchangeAuthorizationCodeCommand } from "../../../src/features/authorization/commands/exchange-authorization-code.command.js";
import { RotateRefreshTokenCommand } from "../../../src/features/authorization/commands/rotate-refresh-token.command.js";
import { BeginLoginCommand } from "../../../src/features/authorization/commands/begin-login.command.js";
import { CompleteLoginCommand } from "../../../src/features/authorization/commands/complete-login.command.js";
import { FirstPartyLoginController } from "../../../src/features/authorization/controllers/first-party-login.controller.js";
import { LoginController } from "../../../src/features/authorization/controllers/login.controller.js";
import { FIRST_PARTY_CLIENT_ID } from "../../../src/features/authorization/bootstrap/first-party-client.seeder.js";
import { AuthorizationAuditGateway } from "../../../src/features/authorization/gateways/authorization-audit.gateway.js";
import { StructuredLogger } from "../../../src/shared/logging/structured-logger.js";
import { GetAuthorizationServerMetadataQuery } from "../../../src/features/authorization/queries/get-authorization-server-metadata.query.js";
import { RequireCurrentMembershipQuery } from "../../../src/features/authorization/queries/require-current-membership.query.js";
import type { RefreshTokenLookup } from "../../../src/features/authorization/models/domain/authorization-records.js";
import { authorizationStoreFixture } from "./authorization-store.fixture.js";

const refreshToken = "r".repeat(43);
const accessToken = "a".repeat(43);
const familyId = "5e6c6f36-1c4b-4c1b-9d59-6f3b1a2c3d4e";
const now = new Date("2026-11-09T12:00:00Z");

function fixture(overrides: Partial<RefreshTokenLookup> = {}) {
	const store = authorizationStoreFixture();
	const status = vi.fn().mockResolvedValue({ status: "current" });
	const membership = vi.fn().mockResolvedValue({ status: "present" });
	const gate = new RequireCurrentMembershipQuery({
		status: { execute: status },
		membership: { execute: membership }
	});
	const audit = { record: vi.fn() };
	const rotate = new RotateRefreshTokenCommand({ store, gate, sessionTtlSeconds: 300, audit, now: () => now });
	const record: RefreshTokenLookup = {
		tokenHash: createHash("sha256").update(refreshToken).digest("hex"),
		clientId: "client",
		sessionId: "session-old",
		familyId,
		userId: "123",
		issuedAt: new Date(now.getTime() - 86_400_000),
		expiresAt: new Date(now.getTime() + 86_400_000),
		consumedAt: null,
		graceEligible: false,
		...overrides
	};
	store.findRefreshToken.mockResolvedValue(record);
	store.consumeRefreshToken.mockResolvedValue({ ...record, consumedAt: now });
	return { store, gate, status, membership, audit, rotate, record };
}

function response() {
	const headers: Record<string, unknown> = {};
	const body: { value?: unknown } = {};
	const captured = {
		headers,
		body,
		status(_code: number) {
			return captured;
		},
		setHeader(name: string, value: string) {
			headers[name] = value;
		},
		type(_value: string) {
			return captured;
		},
		send(value: string) {
			body.value = value;
		},
		json(value: unknown) {
			body.value = value;
		}
	};
	return captured;
}

describe("refresh grant with rotation", () => {
	it("rotates single-use: consumes the presented token and issues a new pair in the same family", async () => {
		const f = fixture();
		const result = await f.rotate.execute({ refreshToken, clientId: "client" });
		expect(result).toMatchObject({
			accessToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			refreshToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			expiresIn: 300,
			refreshExpiresIn: 30 * 24 * 60 * 60
		});
		expect(result.refreshToken).not.toBe(refreshToken);
		expect(result.accessToken).not.toBe(accessToken);
		expect(f.store.consumeRefreshToken).toHaveBeenCalledTimes(1);
		expect(f.store.consumeRefreshToken).toHaveBeenCalledWith(
			createHash("sha256").update(refreshToken).digest("hex"),
			expect.any(Date)
		);
		const session = f.store.insertSession.mock.calls[0]?.[0];
		expect(session).toMatchObject({ userId: "123", clientId: "client", revokedAt: null });
		expect((session?.expiresAt.getTime() ?? 0) - (session?.issuedAt.getTime() ?? 0)).toBe(300_000);
		const issued = f.store.insertRefreshToken.mock.calls[0]?.[0];
		expect(issued).toMatchObject({ clientId: "client", familyId, sessionId: session?.sessionId });
		expect(issued?.tokenHash).toBe(createHash("sha256").update(result.refreshToken).digest("hex"));
		expect(issued?.tokenHash).not.toBe(result.refreshToken);
		expect((issued?.expiresAt.getTime() ?? 0) - (issued?.issuedAt.getTime() ?? 0)).toBe(30 * 24 * 60 * 60 * 1000);
		expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({ code: "refresh_rotated", familyId }));
		expect(JSON.stringify(f.audit.record.mock.calls)).not.toContain(result.refreshToken);
	});

	it("accepts the immediately-previous generation once inside the grace window, still consumed", async () => {
		const f = fixture({ consumedAt: new Date(now.getTime() - 10_000), graceEligible: true });
		const result = await f.rotate.execute({ refreshToken, clientId: "client" });
		expect(result.refreshToken).not.toBe(refreshToken);
		// A graced token is not consumed again; it stays consumed for future presentations.
		expect(f.store.consumeRefreshToken).not.toHaveBeenCalled();
		expect(f.store.revokeRefreshFamily).not.toHaveBeenCalled();
		expect(f.store.insertRefreshToken.mock.calls[0]?.[0]?.familyId).toBe(familyId);
		expect(f.audit.record).toHaveBeenCalledWith(
			expect.objectContaining({ code: "refresh_grace_accepted", familyId })
		);
	});

	it("refuses a token presented for another client without burning or revoking anything", async () => {
		const f = fixture();
		await expect(f.rotate.execute({ refreshToken, clientId: "someone-else" })).rejects.toMatchObject({
			code: "invalid_grant"
		});
		expect(f.store.consumeRefreshToken).not.toHaveBeenCalled();
		expect(f.store.revokeRefreshFamily).not.toHaveBeenCalled();
		expect(f.store.insertSession).not.toHaveBeenCalled();
		expect(f.audit.record).not.toHaveBeenCalled();
	});

	it("refuses unknown and malformed tokens identically, without a lookup for malformed input", async () => {
		const f = fixture();
		f.store.findRefreshToken.mockResolvedValue(null);
		const unknown = await f.rotate.execute({ refreshToken, clientId: "client" }).catch((error: unknown) => error);
		const malformed = await f.rotate
			.execute({ refreshToken: "short", clientId: "client" })
			.catch((error: unknown) => error);
		expect(unknown).toMatchObject({ code: "invalid_grant" });
		expect(malformed).toMatchObject({ code: "invalid_grant" });
		expect((unknown as Error).message).toBe((malformed as Error).message);
		expect(f.store.insertSession).not.toHaveBeenCalled();
	});

	it("keeps the membership gate on every refresh and issues nothing when it fails", async () => {
		const f = fixture();
		f.membership.mockResolvedValue({ status: "absent" });
		await expect(f.rotate.execute({ refreshToken, clientId: "client" })).rejects.toMatchObject({
			code: "access_denied"
		});
		expect(f.store.consumeRefreshToken).not.toHaveBeenCalled();
		expect(f.store.insertSession).not.toHaveBeenCalled();
	});

	it("handles a lost concurrent-rotation race with the same grace rule", async () => {
		const f = fixture();
		f.store.consumeRefreshToken.mockResolvedValueOnce(null);
		f.store.findRefreshToken
			.mockResolvedValueOnce(f.record)
			.mockResolvedValueOnce({ ...f.record, consumedAt: now, graceEligible: true });
		const result = await f.rotate.execute({ refreshToken, clientId: "client" });
		expect(result.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(f.store.revokeRefreshFamily).not.toHaveBeenCalled();
	});
});

describe("refresh reuse detection and expiry", () => {
	it("a consumed token outside the grace window revokes the family and its sessions", async () => {
		const f = fixture({ consumedAt: new Date(now.getTime() - 31_000) });
		f.store.revokeRefreshFamily.mockResolvedValue(2);
		await expect(f.rotate.execute({ refreshToken, clientId: "client" })).rejects.toMatchObject({
			code: "invalid_grant"
		});
		expect(f.store.revokeRefreshFamily).toHaveBeenCalledWith(familyId, expect.any(Date));
		expect(f.store.consumeRefreshToken).not.toHaveBeenCalled();
		expect(f.store.insertSession).not.toHaveBeenCalled();
		expect(f.store.insertRefreshToken).not.toHaveBeenCalled();
		expect(f.audit.record).toHaveBeenCalledWith(
			expect.objectContaining({ code: "refresh_reuse_detected", familyId })
		);
	});

	it("a later token of a revoked family fails identically after the sweep", async () => {
		const f = fixture();
		// The family sweep consumed every row: the former head is now consumed with no live head left.
		f.store.findRefreshToken
			.mockResolvedValueOnce({ ...f.record, consumedAt: new Date(now.getTime() - 1_000) })
			.mockResolvedValue(null);
		await expect(f.rotate.execute({ refreshToken, clientId: "client" })).rejects.toMatchObject({
			code: "invalid_grant"
		});
		expect(f.store.revokeRefreshFamily).toHaveBeenCalledTimes(1);
		const other = "s".repeat(43);
		await expect(f.rotate.execute({ refreshToken: other, clientId: "client" })).rejects.toMatchObject({
			code: "invalid_grant"
		});
		expect(f.store.insertSession).not.toHaveBeenCalled();
	});

	it("an expired unconsumed token is refused without touching its family", async () => {
		const f = fixture({ expiresAt: new Date(now.getTime() - 1_000) });
		await expect(f.rotate.execute({ refreshToken, clientId: "client" })).rejects.toMatchObject({
			code: "invalid_grant"
		});
		expect(f.store.revokeRefreshFamily).not.toHaveBeenCalled();
		expect(f.store.consumeRefreshToken).not.toHaveBeenCalled();
		expect(f.store.insertSession).not.toHaveBeenCalled();
		expect(f.store.insertRefreshToken).not.toHaveBeenCalled();
		expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({ code: "refresh_expired", familyId }));
	});

	it("a replayed consumed token is reuse even after its own expiry", async () => {
		const f = fixture({
			expiresAt: new Date(now.getTime() - 1_000),
			consumedAt: new Date(now.getTime() - 86_400_000)
		});
		await expect(f.rotate.execute({ refreshToken, clientId: "client" })).rejects.toMatchObject({
			code: "invalid_grant"
		});
		expect(f.store.revokeRefreshFamily).toHaveBeenCalledWith(familyId, expect.any(Date));
	});

	it("makes unknown, malformed, consumed and expired refusals indistinguishable", async () => {
		const unknown = fixture();
		unknown.store.findRefreshToken.mockResolvedValue(null);
		const consumed = fixture({ consumedAt: new Date(now.getTime() - 60_000) });
		const expired = fixture({ expiresAt: new Date(now.getTime() - 1_000) });
		const failures = await Promise.all(
			[
				unknown.rotate.execute({ refreshToken, clientId: "client" }),
				consumed.rotate.execute({ refreshToken, clientId: "client" }),
				expired.rotate.execute({ refreshToken, clientId: "client" }),
				unknown.rotate.execute({ refreshToken: "x", clientId: "client" })
			].map((attempt) => attempt.catch((error: unknown) => error as Error))
		);
		for (const failure of failures)
			expect(failure).toMatchObject({
				code: "invalid_grant",
				message: "The refresh token is invalid or expired."
			});
	});
});

describe("token endpoint dispatch and first-party page", () => {
	it("advertises both grants in server metadata", () => {
		expect(new GetAuthorizationServerMetadataQuery("https://hub.example").execute().grant_types_supported).toEqual([
			"authorization_code",
			"refresh_token"
		]);
	});

	it("routes grant_type=refresh_token to the rotation and returns the pair", async () => {
		const store = authorizationStoreFixture();
		const gate = new RequireCurrentMembershipQuery({
			status: { execute: async () => ({ status: "current" }) },
			membership: { execute: async () => ({ status: "present" }) }
		});
		const rotation = { execute: vi.fn() };
		rotation.execute.mockResolvedValue({
			accessToken: "new-access",
			refreshToken: "new-refresh",
			expiresIn: 300,
			refreshExpiresIn: 2_592_000
		});
		const controller = new LoginController(
			new CompleteLoginCommand({ store, gate, gateway: { resolveUserId: async () => "123" } }),
			new ExchangeAuthorizationCodeCommand({ store, gate, sessionTtlSeconds: 300 }),
			rotation as unknown as RotateRefreshTokenCommand
		);
		const answer = response();
		await controller.token(
			{ grant_type: "refresh_token", refresh_token: "presented", client_id: "client" },
			answer
		);
		expect(rotation.execute).toHaveBeenCalledWith({ refreshToken: "presented", clientId: "client" });
		// R18: the rotation's own lifetime is published, never re-derived in the controller.
		expect(answer.body.value).toEqual({
			access_token: "new-access",
			token_type: "Bearer",
			expires_in: 300,
			refresh_token: "new-refresh",
			refresh_expires_in: 2_592_000
		});
	});

	it("keeps unsupported grant types on their existing error", async () => {
		const store = authorizationStoreFixture();
		const gate = new RequireCurrentMembershipQuery({
			status: { execute: async () => ({ status: "current" }) },
			membership: { execute: async () => ({ status: "present" }) }
		});
		const controller = new LoginController(
			new CompleteLoginCommand({ store, gate, gateway: { resolveUserId: async () => "123" } }),
			new ExchangeAuthorizationCodeCommand({ store, gate, sessionTtlSeconds: 300 }),
			{ execute: vi.fn() } as unknown as RotateRefreshTokenCommand
		);
		const answer = response();
		await controller.token({ grant_type: "password" }, answer);
		expect(answer.body.value).toMatchObject({ error: "unsupported_grant_type" });
	});

	it("renders both credentials and their expiry hints on the first-party page", async () => {
		const exchange = {
			execute: vi.fn().mockResolvedValue({
				accessToken: "first-party-access",
				refreshToken: "first-party-refresh",
				expiresIn: 300,
				refreshExpiresIn: 30 * 24 * 60 * 60
			})
		};
		const controller = new FirstPartyLoginController(
			new BeginLoginCommand({
				store: authorizationStoreFixture(),
				publicBaseUrl: "https://hub.example",
				discordClientId: "id"
			}),
			exchange as unknown as ExchangeAuthorizationCodeCommand,
			"https://hub.example"
		);
		const answer = response();
		await controller.callback({ state: "state", code: "code" }, "hub_login=verifier.state", answer);
		const page = String(answer.body.value);
		expect(exchange.execute).toHaveBeenCalledWith(
			expect.objectContaining({ clientId: FIRST_PARTY_CLIENT_ID, code: "code", codeVerifier: "verifier" })
		);
		expect(page).toContain("first-party-access");
		expect(page).toContain("first-party-refresh");
		expect(page).toContain("Token de sesión");
		expect(page).toContain("Token de refresco");
		expect(page).toContain("30 días");
		expect(answer.headers["Cache-Control"]).toBe("no-store");
	});
});

describe("refresh log safety", () => {
	it("logs no token or hash material and carries the family id with outcome codes only", async () => {
		const f = fixture();
		const lines: string[] = [];
		const audit = new AuthorizationAuditGateway(new StructuredLogger("debug", (line) => lines.push(line)));
		const rotate = new RotateRefreshTokenCommand({
			store: f.store,
			gate: f.gate,
			sessionTtlSeconds: 300,
			audit,
			// The log-safety scenario must not depend on the runner's wall clock (the family's
			// timestamps are frozen at the fixture instant): the command clock is injected.
			now: () => now
		});
		f.store.findRefreshToken.mockResolvedValueOnce({ ...f.record, consumedAt: null });
		f.store.consumeRefreshToken.mockResolvedValueOnce({ ...f.record, consumedAt: now });
		const rotated = await rotate.execute({ refreshToken, clientId: "client" });
		f.store.findRefreshToken.mockResolvedValueOnce({
			...f.record,
			consumedAt: new Date(now.getTime() - 90_000)
		});
		await expect(rotate.execute({ refreshToken, clientId: "client" })).rejects.toMatchObject({
			code: "invalid_grant"
		});
		const output = lines.join("\n");
		for (const secret of [refreshToken, rotated.refreshToken, rotated.accessToken, f.record.tokenHash])
			expect(output).not.toContain(secret);
		const outcomes = lines
			.map((line) => JSON.parse(line) as { message: string; fields: Record<string, unknown> })
			.filter((line) => line.message === "authorization outcome")
			.map((line) => line.fields);
		expect(outcomes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "refresh_rotated", familyId, clientId: "client", userId: "123" }),
				expect.objectContaining({ code: "refresh_reuse_detected", familyId })
			])
		);
		expect(output).not.toContain("stack");
	});
});
