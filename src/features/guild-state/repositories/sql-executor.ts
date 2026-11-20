/**
 * The feature's driver-free persistence seam (docs/architecture/persistence.md: "Keep the application
 * transaction contract driver-free. Use a narrow transaction runner ... Do not expose BEGIN/COMMIT to
 * commands"). This file deliberately imports nothing: not `pg`, not a shared module. The managed pool
 * created in `src/shared/persistence/` is handed to {@link createSqlExecutor} at the composition seam and
 * satisfies `SqlClientSource` by shape — `query(text, values)`, `connect()` and `client.release()` — which
 * an integration check asserts against the real driver rather than trusting a comment.
 *
 * Two verbs only. `query` runs one statement on the pool, which is all a single-statement read or write
 * needs. `transaction` checks out one client and runs a unit of work inside BEGIN/COMMIT, for the
 * operations R3, R4, R6 and R8 define as one atomic removal or replacement. A repository that needs both
 * uses the session it is handed inside the transaction; using `query` there would run on a different
 * connection and be silently outside the boundary.
 */

/** A `bigint` id column accepts a decimal string; a `text`, `integer` or `boolean` column accepts its own type. */
export type SqlParameterSet = readonly unknown[];

/** What a statement came back with. Row counts come from the rows themselves, so the driver's own count never leaks. */
export interface SqlStatementResult<Row> {
	readonly rows: readonly Row[];
}

/** One checked-out connection, released exactly once by the runner. */
export interface SqlClientSession {
	readonly query: <Row = Record<string, unknown>>(
		statement: string,
		parameters?: SqlParameterSet
	) => Promise<SqlStatementResult<Row>>;
	readonly release: () => void;
}

/** The pool-shaped thing the composition injects: statement execution plus the ability to check one out. */
export interface SqlClientSource {
	readonly query: <Row = Record<string, unknown>>(
		statement: string,
		parameters?: SqlParameterSet
	) => Promise<SqlStatementResult<Row>>;
	readonly connect: () => Promise<SqlClientSession>;
}

/** The single persistence dependency a PostgreSQL repository takes. */
export interface SqlExecutor {
	readonly query: <Row = Record<string, unknown>>(
		statement: string,
		parameters?: SqlParameterSet
	) => Promise<SqlStatementResult<Row>>;
	readonly transaction: <Result>(work: (session: SqlClientSession) => Promise<Result>) => Promise<Result>;
}

/**
 * PostgreSQL's SQLSTATE for a unique/exclusion violation. The only code this feature translates, and only
 * when the named constraint is the one it owns (docs/architecture/persistence.md: "Translate a duplicate
 * violation only when both its code and the intended constraint match. Unexpected constraints and
 * connectivity errors are not silently converted to business conflicts"). Read off `unknown` rather than
 * cast, because the driver's error object is not part of this feature's vocabulary.
 */
const UNIQUE_VIOLATION_CODE = "23505";

export function isUniqueConstraintViolation(failure: unknown, constraintName: string): boolean {
	if (typeof failure !== "object" || failure === null) {
		return false;
	}
	if (!("code" in failure) || !("constraint" in failure)) {
		return false;
	}
	const { code, constraint } = failure;
	return code === UNIQUE_VIOLATION_CODE && constraint === constraintName;
}

/**
 * BEGIN, the work, COMMIT, release in `finally`. A failure rolls back and the original failure is what
 * propagates: a rollback that also fails must not replace it, so its own error is discarded here on
 * purpose and the caller sees the statement that broke.
 */
export function createSqlExecutor(source: SqlClientSource): SqlExecutor {
	return {
		query: <Row = Record<string, unknown>>(statement: string, parameters?: SqlParameterSet) =>
			source.query<Row>(statement, parameters),

		transaction: async <Result>(work: (session: SqlClientSession) => Promise<Result>): Promise<Result> => {
			const session = await source.connect();
			try {
				await session.query("BEGIN");
				try {
					const result = await work(session);
					await session.query("COMMIT");
					return result;
				} catch (failure) {
					try {
						await session.query("ROLLBACK");
					} catch {
						/* The transaction is aborted either way; the failure that matters is `failure`. */
					}
					throw failure;
				}
			} finally {
				session.release();
			}
		}
	};
}
