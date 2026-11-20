import { describe, expect, it } from "vitest";
import { up as upRefreshMigration, down as downRefreshMigration } from "../../../migrations/8_refresh_tokens.js";
import { PostgresAuthorizationStoreRepository } from "../../../src/features/authorization/repositories/postgres-authorization-store.repository.js";
import { PurgeExpiredSessionsCommand } from "../../../src/features/authorization/commands/purge-expired-sessions.command.js";
import type { AuthorizationSqlExecutor } from "../../../src/features/authorization/repositories/postgres-authorization-store.repository.js";

interface RecordedStatement {
	readonly statement: string;
	readonly parameters: readonly unknown[];
}

/** Captures the parameterized statements the adapter issues; no database and no driver involved. */
function recordingExecutor(rowsFor: (statement: string) => readonly Record<string, unknown>[]): {
	executor: AuthorizationSqlExecutor;
	statements: RecordedStatement[];
} {
	const statements: RecordedStatement[] = [];
	const executor: AuthorizationSqlExecutor = {
		query: async <Row>(statement: string, parameters?: readonly unknown[]) => {
			statements.push({ statement, parameters: parameters ?? [] });
			return { rows: rowsFor(statement) as Row[] };
		}
	};
	return { executor, statements };
}

const now = new Date("2026-11-09T12:00:00Z");
const hash = (value: string): string => value.repeat(64).slice(0, 64);

describe("refresh token schema (migration 8)", () => {
	it("adds the table with its hash CHECK, both foreign keys, family id and consumed marker", () => {
		const statements: string[] = [];
		upRefreshMigration({ sql: (statement: string) => statements.push(statement) } as never);
		const sql = statements.join("\n");
		expect(sql).toContain("CREATE TABLE oauth_refresh_token");
		expect(sql).toContain("token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$')");
		expect(sql).toContain("client_id text NOT NULL REFERENCES oauth_client(client_id)");
		expect(sql).toContain("session_id text NOT NULL REFERENCES hub_session(session_id)");
		expect(sql).toContain("family_id uuid NOT NULL");
		expect(sql).toContain("expires_at timestamptz NOT NULL CHECK (expires_at > issued_at)");
		expect(sql).toContain("consumed_at timestamptz");
		// Family sweep, partial unconsumed index for validation, bounded housekeeping order.
		expect(sql).toContain("CREATE INDEX oauth_refresh_family ON oauth_refresh_token(family_id)");
		expect(sql).toContain(
			"CREATE INDEX oauth_refresh_family_live ON oauth_refresh_token(family_id) WHERE consumed_at IS NULL"
		);
		expect(sql).toContain("CREATE INDEX oauth_refresh_expiry ON oauth_refresh_token(expires_at, token_hash)");
	});

	it("drops only the table it created", () => {
		const statements: string[] = [];
		downRefreshMigration({ sql: (statement: string) => statements.push(statement) } as never);
		expect(statements.join("\n")).toBe("DROP TABLE oauth_refresh_token;");
	});
});

describe("refresh token store SQL", () => {
	it("inserts the hash with no plaintext column and no preset consumption", async () => {
		const { executor, statements } = recordingExecutor(() => []);
		const store = new PostgresAuthorizationStoreRepository(executor);
		await store.insertRefreshToken({
			tokenHash: hash("a"),
			clientId: "client",
			sessionId: "session",
			familyId: "5e6c6f36-1c4b-4c1b-9d59-6f3b1a2c3d4e",
			issuedAt: now,
			expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
		});
		const [insert] = statements;
		expect(insert?.statement).toContain("INSERT INTO oauth_refresh_token");
		expect(insert?.statement).toContain("VALUES ($1, $2, $3, $4, $5, $6, NULL)");
		expect(insert?.parameters).toEqual([
			hash("a"),
			"client",
			"session",
			"5e6c6f36-1c4b-4c1b-9d59-6f3b1a2c3d4e",
			now,
			new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
		]);
	});

	it("looks up by hash only and computes grace from the family's latest consumption", async () => {
		const row = {
			token_hash: hash("b"),
			client_id: "client",
			session_id: "session",
			family_id: "5e6c6f36-1c4b-4c1b-9d59-6f3b1a2c3d4e",
			user_id: "9007199254740993",
			issued_at: now,
			expires_at: new Date(now.getTime() + 60_000),
			consumed_at: null,
			grace_eligible: false
		};
		const { executor, statements } = recordingExecutor(() => [row]);
		const store = new PostgresAuthorizationStoreRepository(executor);
		expect(await store.findRefreshToken(hash("b"), now, 30)).toEqual({
			tokenHash: hash("b"),
			clientId: "client",
			sessionId: "session",
			familyId: "5e6c6f36-1c4b-4c1b-9d59-6f3b1a2c3d4e",
			userId: "9007199254740993",
			issuedAt: now,
			expiresAt: new Date(now.getTime() + 60_000),
			consumedAt: null,
			graceEligible: false
		});
		const [lookup] = statements;
		expect(lookup?.parameters).toEqual([hash("b"), new Date(now.getTime() - 30_000)]);
		expect(lookup?.statement).toContain("r.token_hash = $1");
		// Reuse detection and grace both depend on the family, never on the session being alive.
		expect(lookup?.statement).toContain("MAX(f.consumed_at)");
		expect(lookup?.statement).not.toContain("revoked_at");
		// Only the hash is bound: no plaintext credential ever reaches a statement.
	});

	it("consumes single-use with one conditional write and returns the row joined to its user", async () => {
		const { executor, statements } = recordingExecutor(() => [
			{
				token_hash: hash("c"),
				client_id: "client",
				session_id: "session",
				family_id: "5e6c6f36-1c4b-4c1b-9d59-6f3b1a2c3d4e",
				user_id: "7",
				issued_at: now,
				expires_at: new Date(now.getTime() + 60_000),
				consumed_at: now
			}
		]);
		const store = new PostgresAuthorizationStoreRepository(executor);
		expect((await store.consumeRefreshToken(hash("c"), now))?.userId).toBe("7");
		const [consume] = statements;
		expect(consume?.statement).toContain("UPDATE oauth_refresh_token SET consumed_at = $2");
		expect(consume?.statement).toContain("consumed_at IS NULL AND expires_at > $2");
		expect(consume?.parameters).toEqual([hash("c"), now]);
	});

	it("revokes a family: sessions first, then every remaining token, reporting tokens marked", async () => {
		const { executor, statements } = recordingExecutor((statement) =>
			statement.includes("UPDATE oauth_refresh_token")
				? [{ token_hash: hash("d") }, { token_hash: hash("e") }]
				: []
		);
		const store = new PostgresAuthorizationStoreRepository(executor);
		const familyId = "5e6c6f36-1c4b-4c1b-9d59-6f3b1a2c3d4e";
		expect(await store.revokeRefreshFamily(familyId, now)).toBe(2);
		expect(statements).toHaveLength(2);
		expect(statements[0]?.statement).toContain("UPDATE hub_session SET revoked_at = $2");
		expect(statements[0]?.statement).toContain("family_id = $1");
		expect(statements[1]?.statement).toContain("UPDATE oauth_refresh_token SET consumed_at = $2");
		for (const statement of statements) expect(statement.parameters).toEqual([familyId, now]);
	});

	it("sweeps a user's whole family set in one statement through the retained sessions", async () => {
		const { executor, statements } = recordingExecutor(() => [{ token_hash: hash("f") }]);
		const store = new PostgresAuthorizationStoreRepository(executor);
		expect(await store.revokeUserRefreshTokens("9007199254740993", now)).toBe(1);
		expect(statements[0]?.statement).toContain("session_id IN");
		expect(statements[0]?.statement).toContain("WHERE user_id = $1");
		expect(statements[0]?.parameters).toEqual(["9007199254740993", now]);
	});

	it("deletes expired tokens in bounded batches and refuses unbounded limits", async () => {
		const { executor, statements } = recordingExecutor(() => [{ token_hash: hash("g") }]);
		const store = new PostgresAuthorizationStoreRepository(executor);
		expect(await store.deleteExpiredRefreshTokens(now, 1)).toBe(1);
		expect(statements[0]?.statement).toContain("expires_at <= $1");
		expect(statements[0]?.statement).toContain("LIMIT $2");
		expect(statements[0]?.parameters).toEqual([now, 1]);
		await expect(store.deleteExpiredRefreshTokens(now, 0)).rejects.toThrow("batch size");
		await expect(store.deleteExpiredRefreshTokens(now, 1001)).rejects.toThrow("batch size");
	});

	it("deletes dead-family rows in bounded batches without touching expired or live families", async () => {
		const { executor, statements } = recordingExecutor(() => [{ token_hash: hash("i") }]);
		const store = new PostgresAuthorizationStoreRepository(executor);
		expect(await store.deleteDeadRefreshFamilyTokens(now, 4)).toBe(1);
		const [sweep] = statements;
		expect(sweep?.statement).toContain("consumed_at IS NOT NULL");
		expect(sweep?.statement).toContain("expires_at > $1");
		expect(sweep?.statement).toContain(
			"NOT EXISTS (SELECT 1 FROM oauth_refresh_token live WHERE live.family_id = r.family_id AND live.consumed_at IS NULL)"
		);
		expect(sweep?.statement).toContain("LIMIT $2");
		expect(sweep?.parameters).toEqual([now, 4]);
	});

	it("purges expired refresh tokens before sessions so a live family keeps its anchor row", async () => {
		const { executor, statements } = recordingExecutor((statement) => {
			if (statement.includes("DELETE FROM oauth_refresh_token")) return [{ token_hash: hash("h") }];
			if (statement.includes("DELETE FROM hub_session")) return [{ session_id: "s" }];
			return [];
		});
		const store = new PostgresAuthorizationStoreRepository(executor);
		expect(await store.purgeExpired(now, 5)).toBe(3);
		expect(statements[0]?.statement).toContain("DELETE FROM oauth_refresh_token");
		expect(statements[1]?.statement).toContain("DELETE FROM oauth_refresh_token");
		const sessionDelete = statements.find((statement) => statement.statement.includes("DELETE FROM hub_session"));
		expect(sessionDelete?.statement).toContain(
			"NOT EXISTS (SELECT 1 FROM oauth_refresh_token r WHERE r.session_id = s.session_id)"
		);
	});
});

describe("bounded housekeeping command", () => {
	it("sweeps through the repository with the caller's batch limit and never authorizes anything", async () => {
		const { executor, statements } = recordingExecutor(() => []);
		const store = new PostgresAuthorizationStoreRepository(executor);
		expect(await new PurgeExpiredSessionsCommand(store).execute(25)).toBe(0);
		expect(statements).toHaveLength(5);
		expect(statements.every((statement) => statement.parameters.includes(25))).toBe(true);
	});
});
