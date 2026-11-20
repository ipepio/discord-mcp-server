import type {
	SqlClientSession,
	SqlExecutor,
	SqlStatementResult
} from "../../../../src/features/ingestion/repositories/sql-executor.js";

/**
 * The message store adapter's database test double (docs/architecture/testing.md: the doubles prove call
 * shape; `tests/integration/` proves SQL behaviour). It records every statement with its bound parameters and
 * answers from scripted rows keyed by a marker in the statement text, so a test can assert what the adapter
 * asked for — one statement per batch, the guard in the `WHERE`, nothing interpolated, values bound — without
 * a server.
 *
 * A statement can also be failed on purpose, which is how the "a mid-transaction failure leaves nothing"
 * promise is checked here (the fake sees the ROLLBACK) and proven on real rows in the integration suite.
 */

export interface RecordedStatement {
	readonly statement: string;
	readonly parameters: readonly unknown[] | undefined;
	/** `pool` for a statement run outside a transaction, `session` for one inside, and the two boundary marks. */
	readonly via: "pool" | "session" | "BEGIN" | "COMMIT" | "ROLLBACK";
}

interface ScriptedAnswer {
	readonly marker: string;
	/** Answers consumed in order; the last one repeats when the list runs out. */
	replies: Record<string, unknown>[][];
	/** A failure to throw instead of answering, for the abort cases. */
	readonly fail?: () => Error;
}

export class RecordingSqlExecutor implements SqlExecutor {
	public readonly statements: RecordedStatement[] = [];

	private readonly scripts: ScriptedAnswer[] = [];
	private openTransactions = 0;

	/** Scripts what the statement containing `marker` answers, page by page. */
	public reply(marker: string, ...pages: readonly (readonly Record<string, unknown>[])[]): this {
		this.scripts.push({ marker, replies: pages.map((page) => [...page]) });
		return this;
	}

	/** Makes the statement containing `marker` throw, once per scripted call. */
	public failOn(marker: string, failure: () => Error): this {
		this.scripts.push({ marker, replies: [], fail: failure });
		return this;
	}

	public get transactions(): number {
		return this.statements.filter((line) => line.via === "BEGIN").length;
	}

	/** Statements whose text contains the marker, in call order, whatever ran them. */
	public matching(marker: string): RecordedStatement[] {
		return this.statements.filter((line) => line.statement.includes(marker));
	}

	public readonly query = async <Row = Record<string, unknown>>(
		statement: string,
		parameters?: readonly unknown[]
	): Promise<SqlStatementResult<Row>> => {
		this.statements.push({ statement, parameters, via: this.openTransactions > 0 ? "session" : "pool" });
		return this.answer<Row>(statement);
	};

	public readonly transaction = async <Result>(
		work: (session: SqlClientSession) => Promise<Result>
	): Promise<Result> => {
		this.statements.push({ statement: "BEGIN", parameters: undefined, via: "BEGIN" });
		this.openTransactions += 1;
		const session: SqlClientSession = { query: this.query, release: () => undefined };
		try {
			const result = await work(session);
			this.openTransactions -= 1;
			this.statements.push({ statement: "COMMIT", parameters: undefined, via: "COMMIT" });
			return result;
		} catch (failure) {
			this.openTransactions -= 1;
			this.statements.push({ statement: "ROLLBACK", parameters: undefined, via: "ROLLBACK" });
			throw failure;
		}
	};

	private async answer<Row>(statement: string): Promise<SqlStatementResult<Row>> {
		const script = this.scripts.find((candidate) => statement.includes(candidate.marker));
		if (script === undefined) {
			return { rows: [] as unknown as Row[] };
		}
		if (script.fail !== undefined) {
			throw script.fail();
		}
		const page = script.replies.shift() ?? script.replies.at(-1) ?? [];
		return { rows: page as unknown as Row[] };
	}
}

/** A pool-shaped source handed to `createSqlExecutor`, so the runner itself can be exercised on the fake. */
export function executorSourceOf(executor: RecordingSqlExecutor): {
	query: <Row = Record<string, unknown>>(
		statement: string,
		parameters?: readonly unknown[]
	) => Promise<SqlStatementResult<Row>>;
	connect: () => Promise<SqlClientSession>;
} {
	return {
		query: executor.query,
		connect: async () => ({ query: executor.query, release: () => undefined })
	};
}
