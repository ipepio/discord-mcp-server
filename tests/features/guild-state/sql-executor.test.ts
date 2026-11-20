import { describe, expect, it } from "vitest";
import {
	createSqlExecutor,
	isUniqueConstraintViolation
} from "../../../src/features/guild-state/repositories/sql-executor.js";
import type {
	SqlClientSession,
	SqlClientSource,
	SqlStatementResult
} from "../../../src/features/guild-state/repositories/sql-executor.js";

/**
 * The transaction plumbing every cascade in R3, R4, R6 and R8 depends on, proven without a driver: which
 * statements open a boundary, what a failure inside one costs, and that the checked-out client is always
 * released. The SQL itself is not the subject here — that is what `tests/integration/` proves against a real
 * PostgreSQL; mocking `pg` would verify call construction, not correctness (persistence.md).
 */

interface Recorded {
	readonly statement: string;
	readonly on: "pool" | "client";
}

function fakeSource(options: { failIn?: string; rows?: readonly Record<string, unknown>[] } = {}) {
	const recorded: Recorded[] = [];
	const releases: number[] = [];

	const record = async <Row>(statement: string, on: "pool" | "client"): Promise<SqlStatementResult<Row>> => {
		recorded.push({ statement, on });
		if (options.failIn !== undefined && statement.includes(options.failIn)) {
			throw new Error(`statement failed: ${statement}`);
		}
		return { rows: (options.rows ?? []) as Row[] };
	};

	const source: SqlClientSource = {
		query: async <Row>(statement: string): Promise<SqlStatementResult<Row>> => record<Row>(statement, "pool"),
		connect: async (): Promise<SqlClientSession> => {
			let released = false;
			recorded.push({ statement: "<connect>", on: "pool" });
			return {
				query: async <Row>(statement: string): Promise<SqlStatementResult<Row>> => {
					if (released) {
						throw new Error("statement issued after release");
					}
					return record<Row>(statement, "client");
				},
				release: () => {
					releases.push(releases.length + 1);
					released = true;
				}
			};
		}
	};

	return { source, executor: createSqlExecutor(source), recorded, releases };
}

describe("sql executor — transaction boundaries (persistence.md)", () => {
	it("runs a single statement on the pool without opening a transaction", async () => {
		const { executor, recorded, releases } = fakeSource();
		await executor.query("SELECT guild_id FROM guild WHERE guild_id = $1");
		expect(recorded).toEqual([{ statement: "SELECT guild_id FROM guild WHERE guild_id = $1", on: "pool" }]);
		// persistence.md: no transaction runner for a single atomic statement.
		expect(recorded.map((entry) => entry.statement)).not.toContain("BEGIN");
		expect(releases).toEqual([]);
	});

	it("wraps one unit of work in BEGIN/COMMIT on one checked-out client and releases it", async () => {
		const { executor, recorded, releases } = fakeSource({ rows: [{ role_id: "160000000000000009" }] });
		const result = await executor.transaction(async (session) => {
			const rows = await session.query<{ role_id: string }>("DELETE FROM guild_role RETURNING role_id");
			return rows.rows.length;
		});

		expect(result).toBe(1);
		expect(recorded.map((entry) => entry.statement)).toEqual([
			"<connect>",
			"BEGIN",
			"DELETE FROM guild_role RETURNING role_id",
			"COMMIT"
		]);
		expect(recorded.filter((entry) => entry.on === "client").map((entry) => entry.statement)).toEqual([
			"BEGIN",
			"DELETE FROM guild_role RETURNING role_id",
			"COMMIT"
		]);
		expect(releases).toEqual([1]);
	});

	it("rolls back and rethrows the original failure, still releasing the client", async () => {
		const { executor, recorded, releases } = fakeSource({ failIn: "DELETE FROM guild_role" });
		let caught: unknown;
		try {
			await executor.transaction(async (session) => {
				await session.query("DELETE FROM guild_role WHERE role_id = $1");
				await session.query("DELETE FROM guild_membership_role WHERE role_id = $1");
				return "unreachable";
			});
		} catch (failure) {
			caught = failure;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toBe("statement failed: DELETE FROM guild_role WHERE role_id = $1");
		expect(recorded.map((entry) => entry.statement)).toEqual([
			"<connect>",
			"BEGIN",
			"DELETE FROM guild_role WHERE role_id = $1",
			"ROLLBACK"
		]);
		expect(releases).toEqual([1]);
	});

	it("keeps the boundary on one client, and shows what leaving it costs", async () => {
		const { executor, recorded } = fakeSource();
		await executor.transaction(async (session) => {
			await session.query("DELETE FROM guild_membership_role WHERE role_id = $1");
			// The documented footgun: `executor.query` inside a transaction runs on a different connection,
			// outside the boundary. Asserted here so the distinction is visible instead of implied.
			await executor.query("SELECT 1");
		});
		expect(recorded.filter((entry) => entry.on === "client").map((entry) => entry.statement)).toEqual([
			"BEGIN",
			"DELETE FROM guild_membership_role WHERE role_id = $1",
			"COMMIT"
		]);
		expect(recorded.filter((entry) => entry.on === "pool").map((entry) => entry.statement)).toEqual([
			"<connect>",
			"SELECT 1"
		]);
	});

	it("releases the client when the work itself never issues a statement", async () => {
		const { executor, releases } = fakeSource();
		await executor.transaction(async () => undefined);
		expect(releases).toEqual([1]);
	});
});

describe("constraint translation (persistence.md, R1)", () => {
	const driverError = (code: string, constraint: string): unknown => ({ code, constraint });

	it("translates only the constraint this feature owns, and only with the unique-violation code", () => {
		expect(
			isUniqueConstraintViolation(
				driverError("23505", "guild_registry_single_guild_index"),
				"guild_registry_single_guild_index"
			)
		).toBe(true);
		expect(
			isUniqueConstraintViolation(driverError("23505", "guild_role_pkey"), "guild_registry_single_guild_index")
		).toBe(false);
		expect(
			isUniqueConstraintViolation(
				driverError("23503", "guild_registry_single_guild_index"),
				"guild_registry_single_guild_index"
			)
		).toBe(false);
	});

	it("does not read a non-error or a shapeless throw as a business conflict", () => {
		for (const candidate of [undefined, null, "23505", 42, {}, { code: "23505" }, { constraint: "x" }]) {
			expect(
				isUniqueConstraintViolation(candidate, "guild_registry_single_guild_index"),
				JSON.stringify(candidate)
			).toBe(false);
		}
	});
});
