import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AuthenticateSessionQuery } from "../../../src/features/authorization/queries/authenticate-session.query.js";
import { RequireCurrentMembershipQuery } from "../../../src/features/authorization/queries/require-current-membership.query.js";
import { McpAuthenticationGuard } from "../../../src/features/authorization/controllers/mcp-authentication.guard.js";
import type { AuthenticatedMcpRequest } from "../../../src/features/authorization/controllers/mcp-authentication.guard.js";
import { authorizationStoreFixture } from "./authorization-store.fixture.js";

const RESOURCE_METADATA = 'Bearer resource_metadata="https://hub.example/.well-known/oauth-protected-resource"';
const invalidToken = (description: string): string =>
	`${RESOURCE_METADATA}, error="invalid_token", error_description="${description}"`;
const EXPIRED = "The access token has expired.";
const INVALID = "The access token is invalid.";
const UNAVAILABLE = "Authentication is temporarily unavailable.";

function fixture() {
	const store = authorizationStoreFixture();
	const status = vi.fn().mockResolvedValue({ status: "current" });
	const membership = vi.fn().mockResolvedValue({ status: "present" });
	const gate = new RequireCurrentMembershipQuery({
		status: { execute: status },
		membership: { execute: membership }
	});
	const query = new AuthenticateSessionQuery({ store, gate });
	const guard = new McpAuthenticationGuard(query, "https://hub.example");
	const token = "a".repeat(43);
	const session = {
		sessionId: "session",
		userId: "123",
		clientId: "client",
		issuedAt: new Date(),
		expiresAt: new Date(Date.now() + 60000),
		revokedAt: null
	};
	store.findSessionByTokenHash.mockResolvedValue(session);
	const headers: Record<string, string> = {};
	const response = {
		setHeader(name: string, value: string) {
			headers[name] = value;
		}
	};
	return { store, status, membership, query, guard, token, session, headers, response };
}

type Fixture = ReturnType<typeof fixture>;

/** One refused request: the headers the guard published and the RFC 6750 body it threw, never a principal. */
async function refusal(
	f: Fixture,
	headers: Record<string, unknown> = {}
): Promise<{ headers: Record<string, string>; body: unknown }> {
	for (const name of Object.keys(f.headers)) delete f.headers[name];
	const work = vi.fn();
	let body: unknown;
	try {
		await f.guard.authenticateRequest({ headers }, f.response);
		work();
	} catch (error: unknown) {
		expect(error).toMatchObject({ status: 401 });
		body = (error as { getResponse: () => unknown }).getResponse();
	}
	expect(work).not.toHaveBeenCalled();
	return { headers: f.headers, body };
}

describe("per-request MCP authentication", () => {
	it("resolves identity with validity facts and uses hash lookup only", async () => {
		const f = fixture();
		expect(await f.query.execute(f.token)).toMatchObject({
			authenticated: true,
			principal: { userId: "123", sessionId: "session" },
			membershipCurrent: true,
			registryStatus: "current"
		});
		expect(f.store.findSessionByTokenHash).toHaveBeenCalledWith(createHash("sha256").update(f.token).digest("hex"));
	});
	it("class (a) no credential presented: resource_metadata only, no error parameter", async () => {
		const f = fixture();
		// An absent header and an empty one are both "nothing was presented": the client must start the flow.
		for (const authorization of [undefined, "", "   "]) {
			const { headers, body } = await refusal(f, { authorization });
			expect(headers["WWW-Authenticate"]).toBe(RESOURCE_METADATA);
			expect(headers["WWW-Authenticate"]).not.toContain("error=");
			expect(headers["Retry-After"]).toBeUndefined();
			expect(body).toEqual({});
		}
	});
	it("class (c) malformed, unknown and revoked credentials answer identically", async () => {
		const malformed = [
			"Basic secret",
			"Bearer invalid",
			["Bearer " + "a".repeat(43)],
			"Bearer " + "a".repeat(43) + " extra"
		];
		const unknown = fixture();
		unknown.store.findSessionByTokenHash.mockResolvedValue(null);
		const revoked = fixture();
		revoked.store.findSessionByTokenHash.mockResolvedValue({ ...revoked.session, revokedAt: new Date() });
		const expiredAndRevoked = fixture();
		expiredAndRevoked.store.findSessionByTokenHash.mockResolvedValue({
			...expiredAndRevoked.session,
			issuedAt: new Date(Date.now() - 60000),
			expiresAt: new Date(Date.now() - 1000),
			revokedAt: new Date()
		});
		const answers = [
			...(await Promise.all(malformed.map((authorization) => refusal(fixture(), { authorization })))),
			await refusal(unknown, { authorization: `Bearer ${unknown.token}` }),
			await refusal(revoked, { authorization: `Bearer ${revoked.token}` }),
			await refusal(expiredAndRevoked, { authorization: `Bearer ${expiredAndRevoked.token}` })
		];
		expect(answers).toHaveLength(7);
		for (const { headers, body } of answers) {
			expect(headers["WWW-Authenticate"]).toBe(invalidToken(INVALID));
			expect(headers["Retry-After"]).toBeUndefined();
			expect(body).toEqual({ error: "invalid_token", error_description: INVALID });
			// The body names the cause of a credential, never a row: no session, User or client id.
			expect(JSON.stringify(body)).not.toMatch(/"session"|"123"|"client"/);
		}
	});
	it("class (b) an expired credential names its own cause", async () => {
		const f = fixture();
		f.store.findSessionByTokenHash.mockResolvedValue({ ...f.session, expiresAt: new Date(Date.now() - 1000) });
		const { headers, body } = await refusal(f, { authorization: `Bearer ${f.token}` });
		expect(headers["WWW-Authenticate"]).toBe(invalidToken(EXPIRED));
		expect(headers["Retry-After"]).toBeUndefined();
		expect(body).toEqual({ error: "invalid_token", error_description: EXPIRED });
	});
	it("class (d) a technical failure is the only class that is retryable", async () => {
		const f = fixture();
		f.status.mockResolvedValue({ status: "stale" });
		const { headers, body } = await refusal(f, { authorization: `Bearer ${f.token}` });
		expect(headers["WWW-Authenticate"]).toBe(
			`${RESOURCE_METADATA}, error="temporarily_unavailable", error_description="${UNAVAILABLE}"`
		);
		expect(headers["Retry-After"]).toBe("5");
		expect(body).toEqual({ error: "temporarily_unavailable", error_description: UNAVAILABLE });
	});
	it("expired-session: no dispatch and no successful JSON-RPC response", async () => {
		const f = fixture();
		f.store.findSessionByTokenHash.mockResolvedValue({ ...f.session, expiresAt: new Date(Date.now() - 1000) });
		const { headers } = await refusal(f, { authorization: `Bearer ${f.token}` });
		expect(headers["WWW-Authenticate"]).toBe(invalidToken(EXPIRED));
	});
	it("checks membership and status on every initialize/list/call/continuation request", async () => {
		const f = fixture();
		for (const method of ["initialize", "tools/list", "tools/call", undefined]) {
			const request: AuthenticatedMcpRequest = {
				headers: { authorization: `Bearer ${f.token}` },
				body: { method }
			};
			await f.guard.authenticateRequest(request, f.response);
			expect(request.authorizationPrincipal).toMatchObject({ userId: "123", sessionId: "session" });
		}
		expect(f.store.findSessionByTokenHash).toHaveBeenCalledTimes(4);
		expect(f.membership).toHaveBeenCalledTimes(4);
	});
	it.each(["userId", "user_id", "author", "author_filter", "permissions", "permission", "discord_user_id", "roles"])(
		"identity argument %s is rejected before dispatch",
		async (key) => {
			const f = fixture();
			const work = vi.fn();
			await expect(
				(async () => {
					await f.guard.authenticateRequest(
						{
							headers: { authorization: `Bearer ${f.token}` },
							body: { method: "tools/call", params: { arguments: { [key]: "another-user" } } }
						},
						f.response
					);
					work();
				})()
			).rejects.toMatchObject({ status: 400, response: { error: { code: -32602 } } });
			expect(work).not.toHaveBeenCalled();
		}
	);
	it("documented authorId is a result filter only at the search arguments boundary", async () => {
		const f = fixture();
		const request = (arguments_: unknown) => ({
			headers: { authorization: `Bearer ${f.token}` },
			body: {
				method: "tools/call",
				params: { name: "search_messages", arguments: arguments_ }
			}
		});
		await expect(
			f.guard.authenticateRequest(request({ query: "hello", authorId: "456" }), f.response)
		).resolves.toMatchObject({ userId: "123" });
		for (const args of [{ nested: { authorId: "456" } }, { authorId: { userId: "456" } }, { authorId: "bad" }])
			await expect(f.guard.authenticateRequest(request(args), f.response)).rejects.toMatchObject({ status: 400 });
	});
	it.each([
		"userId",
		"discord_user_id",
		"sessionId",
		"session",
		"principal",
		"identity",
		"permissions",
		"permission",
		"roles",
		"roleId",
		"roleIds",
		"guildId",
		"author",
		"authorFilter"
	])("rejects %s at arbitrary depth", async (key) => {
		const f = fixture();
		for (const body of [{ [key]: "456" }, { params: { arguments: { nested: [{ [key]: "456" }] } } }])
			await expect(
				f.guard.authenticateRequest({ headers: { authorization: `Bearer ${f.token}` }, body }, f.response)
			).rejects.toMatchObject({ status: 400 });
	});
	it("current → stale → current refuses then resumes the same identity without renewal", async () => {
		const f = fixture();
		const request: AuthenticatedMcpRequest = { headers: { authorization: `Bearer ${f.token}` } };
		await f.guard.authenticateRequest(request, f.response);
		f.status.mockResolvedValue({ status: "stale" });
		await expect(f.guard.authenticateRequest(request, f.response)).rejects.toMatchObject({ status: 401 });
		expect(request.authorizationPrincipal).toBeUndefined();
		expect(f.headers["Retry-After"]).toBe("5");
		f.status.mockResolvedValue({ status: "current" });
		expect(await f.guard.authenticateRequest(request, f.response)).toMatchObject({ sessionId: "session" });
		expect(f.store.insertSession).not.toHaveBeenCalled();
	});
	it("membership ending between login and first call denies that call", async () => {
		const f = fixture();
		f.membership.mockResolvedValue({ status: "absent" });
		// A denial is not a technical failure: the credential is refused as invalid, without Retry-After.
		expect(await f.query.execute(f.token)).toEqual({ authenticated: false, outcome: "invalid" });
	});
});
