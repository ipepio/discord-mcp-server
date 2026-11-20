export type QueryErrorCode = "invalid_input" | "state_unavailable" | "internal_error";
export class QueryError extends Error {
	public constructor(
		public readonly code: QueryErrorCode,
		message: string
	) {
		super(message);
		this.name = "QueryError";
	}
}
