/**
 * The feature's driver-free persistence seam (docs/architecture/persistence.md: "Keep the application
 * transaction contract driver-free. Use a narrow transaction runner … Do not expose BEGIN/COMMIT to
 * commands"). This file deliberately imports nothing: not `pg`, not a shared module, not another feature.
 * The managed pool created in `src/shared/persistence/` is handed to {@link createSqlExecutor} at the
 * composition seam and satisfies `SqlClientSource` by shape — `query(text, values)`, `connect()` and
 * `client.release()` — which an integration check asserts against the real driver rather than trusting a
 * comment.
 *
 * Why a second copy of this seam exists: the identical helper in guild-state's `repositories/` is internal
 * to that feature, and the boundary check (`no-cross-feature-internal-adapters`, docs/architecture/
 * structure.md "Cross-feature calls go through an intentional public use case or contract, never another
 * feature's … SQL adapter") is the reason ingestion owns its own rather than importing a neighbour's. The
 * shape is unchanged on purpose so both features can be handed the same pool by the composition.
 *
 * Two verbs only. `query` runs one statement on the pool, which is all a single-statement read or write
 * needs. `transaction` checks out one client and runs a unit of work inside BEGIN/COMMIT, for the operations
 * R4, R5 and R6 define as one atomic replacement or removal. A repository that needs both uses the session
 * it is handed inside the transaction; using `query` there would run on a different connection and be
 * silently outside the boundary.
 */

/** A `bigint` id column accepts a decimal string; a `text`, `integer`, `boolean` or `timestamptz` column accepts its own type. */
export type SqlParameterSet = readonly unknown[];

/** What a statement came back with. Row counts come from the rows themselves, so the driver's count never leaks. */
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

/** The single persistence dependency a PostgreSQL message-store repository takes. */
export interface SqlExecutor {
	readonly query: <Row = Record<string, unknown>>(
		statement: string,
		parameters?: SqlParameterSet
	) => Promise<SqlStatementResult<Row>>;
	readonly transaction: <Result>(work: (session: SqlClientSession) => Promise<Result>) => Promise<Result>;
}

/** Something that can run one statement — the pool or a checked-out session, whichever a call is inside. */
export type SqlStatementRunner = Pick<SqlExecutor, "query">;

/**
 * BEGIN, the work, COMMIT, release in `finally`. A failure rolls back and the original failure is what
 * propagates: a rollback that also fails must not replace it, so its own error is discarded here on purpose
 * and the caller sees the statement that broke.
 *
 * There is no constraint-violation translation in this feature. The message store has one business conflict
 * to express — a message id that already exists — and R7 resolves it inside the statement with
 * `ON CONFLICT … DO UPDATE`, so no PostgreSQL error code is ever a state a caller needs naming
 * (docs/architecture/persistence.md: translate a duplicate only when both its code and the intended
 * constraint match; here neither is ever reached).
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
