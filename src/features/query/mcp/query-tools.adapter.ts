import type { GetServerMetadataQuery } from "../queries/get-server-metadata.query.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", MCP_PROTOCOL_VERSION];

import { QUERY_TOOL_NAMES } from "../models/domain/tool-input.js";
import type { QueryToolName, ToolInput } from "../models/domain/tool-input.js";
import type { QueryToolResult } from "../models/domain/tool-result.js";
import { QueryError } from "../models/domain/query.errors.js";
import { parseToolInput, QUERY_TOOL_SCHEMAS } from "../models/dtos/tool-schema.dto.js";

/** The authenticated transport supplies these facts PER INVOCATION, never from RPC arguments. */
export interface QuerySessionIdentity {
	readonly userId: string;
	readonly sessionId: string;
	readonly expiresAt: Date;
}
export interface QueryToolHandler {
	readonly execute: (input: ToolInput & { readonly userId: string }) => Promise<QueryToolResult>;
}
export type QueryToolHandlers = Readonly<Record<QueryToolName, QueryToolHandler>>;
export class QueryAuthenticationError extends Error {
	public constructor() {
		super("Authenticated current session required");
		this.name = "QueryAuthenticationError";
	}
}

/** Thin MCP protocol adapter. Streamable HTTP mounting/session issuance belongs to authorization.
 * Protocol: 2025-06-18 server/tools and schema.ts; no SDK dependency or parallel REST surface.
 */
export class QueryToolsAdapter {
	public constructor(
		private readonly handlers: QueryToolHandlers,
		private readonly metadata?: Pick<GetServerMetadataQuery, "execute">
	) {}
	public async handle(envelope: unknown, identity: QuerySessionIdentity) {
		if (
			!identity ||
			!identity.sessionId ||
			!(identity.expiresAt instanceof Date) ||
			!Number.isFinite(identity.expiresAt.getTime()) ||
			!/^[1-9][0-9]{0,18}$/.test(identity.userId) ||
			BigInt(identity.userId) > 9223372036854775807n
		)
			throw new QueryAuthenticationError();
		if (
			record(envelope) &&
			envelope["jsonrpc"] === "2.0" &&
			envelope["method"] === "notifications/initialized" &&
			!("id" in envelope)
		)
			return undefined;
		if (!record(envelope) || envelope["jsonrpc"] !== "2.0" || !validId(envelope["id"]))
			return protocolError(null, -32600, "Invalid Request");
		const id = envelope["id"];
		const method = envelope["method"];
		const params = envelope["params"];
		if (method === "initialize") {
			if (!record(params) || typeof params["protocolVersion"] !== "string")
				return protocolError(id, -32602, "Invalid initialize parameters");
			if (!this.metadata) throw new Error("Server metadata provider required");
			const metadata = await this.metadata.execute();
			return {
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(params["protocolVersion"])
						? params["protocolVersion"]
						: MCP_PROTOCOL_VERSION,
					...metadata
				}
			};
		}
		if (method === "tools/list") {
			if (params !== undefined && (!record(params) || Object.keys(params).some((key) => key !== "_meta")))
				return protocolError(id, -32602, "Invalid tools/list parameters");
			return { jsonrpc: "2.0", id, result: { tools: QUERY_TOOL_SCHEMAS } };
		}
		if (method !== "tools/call") return protocolError(id, -32601, "Method not found");
		if (!record(params) || Object.keys(params).some((key) => !["name", "arguments", "_meta"].includes(key)))
			return protocolError(id, -32602, "Invalid tools/call parameters");
		const name = params["name"];
		if (!isTool(name)) return protocolError(id, -32602, "Unknown tool");
		try {
			const args = parseToolInput(name, params["arguments"] ?? {});
			const data = await this.handlers[name].execute({ ...args, userId: identity.userId });
			return {
				jsonrpc: "2.0",
				id,
				result: { isError: false, content: [{ type: "text", text: "Retrieved data" }], structuredContent: data }
			};
		} catch (error) {
			const failure =
				error instanceof QueryError ? error : new QueryError("internal_error", "Could not retrieve data");
			return {
				jsonrpc: "2.0",
				id,
				result: {
					isError: true,
					content: [{ type: "text", text: failure.message }],
					structuredContent: {
						data: [],
						error: {
							code: failure.code,
							message: failure.message,
							retryable: failure.code === "state_unavailable"
						}
					}
				}
			};
		}
	}
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validId(value: unknown): value is string | number {
	return typeof value === "string" ? value.length <= 128 : typeof value === "number" && Number.isSafeInteger(value);
}
function isTool(value: unknown): value is QueryToolName {
	return typeof value === "string" && QUERY_TOOL_NAMES.some((name) => name === value);
}
function protocolError(id: string | number | null, code: number, message: string) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}
