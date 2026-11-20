import { describe, expect, it } from "vitest";
import { createSqlExecutor } from "../../../src/features/ingestion/repositories/sql-executor.js";
import type { SqlClientSession } from "../../../src/features/ingestion/repositories/sql-executor.js";

/**
 * The driver-free transaction seam ingestion's PostgreSQL repositories run on
 * (docs/architecture/persistence.md: "Keep the application transaction contract driver-free … Do not expose
 * BEGIN/COMMIT to commands"). No command can reach these strings any other way, so the runner's own promises
 * are pinned here rather than assumed from the repository tests, which use a recording double instead.
 *
 * The two that matter for a mirror that must never half-apply an event: a unit of work that fails is rolled
 * back and the failure that happened is what propagates (not the rollback's), and the checked-out client is
 * released whatever the work did.
 */

interface FakeClient {
	readonly statement: string;
	readonly calls: string[];
	released: number;
}

function harness(clients: FakeClient[] = []) {
	const calls: string[] = [];
	const made: FakeClient[] = clients;

	const source = {
		query: async <Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) => {
			calls.push(`pool:${statement}`);
			void parameters;
			return { rows: [] as unknown as Row[] };
		},
		connect: async () => {
			const client: FakeClient = { statement: "client", calls, released: 0 };
			made.push(client);
			return {
				query: async <Row = Record<string, unknown>>(statement: string, parameters?: readonly unknown[]) => {
					calls.push(`session:${statement}`);
					void parameters;
					return { rows: [] as unknown as Row[] };
				},
				release: () => {
					client.released += 1;
				}
			} satisfies SqlClientSession;
		}
	};

	return { executor: createSqlExecutor(source), calls, clients: made };
}

describe("ingestion SQL executor seam", () => {
	it("runs a plain statement on the pool, without opening a transaction", async () => {
		const h = harness();
		await h.executor.query("SELECT 1", [1]);
		expect(h.calls).toEqual(["pool:SELECT 1"]);
	});

	it("wraps one unit of work in BEGIN, the work, COMMIT, and releases the client once", async () => {
		const h = harness();
		const result = await h.executor.transaction(async (session) => {
			await session.query("INSERT INTO message (message_id) VALUES ($1)", ["1"]);
			return "done";
		});

		expect(result).toBe("done");
		expect(h.calls).toEqual([
			"session:BEGIN",
			"session:INSERT INTO message (message_id) VALUES ($1)",
			"session:COMMIT"
		]);
		expect(h.clients[0]?.released).toBe(1);
	});

	it("rolls back a unit of work that failed and propagates the failure it saw, not the rollback's", async () => {
		const h = harness();
		const failure = new Error("connection lost mid-statement");

		await expect(
			h.executor.transaction(async (session) => {
				await session.query("DELETE FROM message_attachment", []);
				throw failure;
			})
		).rejects.toBe(failure);

		expect(h.calls).toEqual(["session:BEGIN", "session:DELETE FROM message_attachment", "session:ROLLBACK"]);
		expect(h.clients[0]?.released).toBe(1);
	});

	it("still releases the client when the rollback itself fails", async () => {
		const calls: string[] = [];
		let released = 0;
		const executor = createSqlExecutor({
			query: async () => ({ rows: [] }),
			connect: async () => ({
				query: async <Row = Record<string, unknown>>(statement: string) => {
					calls.push(statement);
					if (statement === "BEGIN") {
						throw new Error("the transaction never opened");
					}
					return { rows: [] as unknown as Row[] };
				},
				release: () => {
					released += 1;
				}
			})
		});

		await expect(executor.transaction(async () => "unreachable")).rejects.toThrow("the transaction never opened");
		expect(released).toBe(1);
		expect(calls).toEqual(["BEGIN"]);
	});

	it("gives nested work the same session, so one repository method is one boundary", async () => {
		const h = harness();
		await h.executor.transaction(async (session) => {
			await h.executor.query("SELECT 1");
			await session.query("SELECT 2");
		});

		// The pool call inside the transaction is on a different connection and therefore outside the boundary:
		// the seam cannot prevent that silently, so it is recorded here as the shape the repositories must not
		// produce — and none of them does, because each passes the session it was handed.
		expect(h.calls).toEqual(["session:BEGIN", "pool:SELECT 1", "session:SELECT 2", "session:COMMIT"]);
	});
});
