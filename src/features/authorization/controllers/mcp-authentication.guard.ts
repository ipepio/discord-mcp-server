import { HttpException, Inject, UnauthorizedException } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import { APP_LOGGER_TOKEN } from "../../../shared/logging/logging.tokens.js";
import { AuthenticateSessionQuery } from "../queries/authenticate-session.query.js";
import type { AuthenticatedPrincipal, AuthenticationOutcome } from "../queries/authenticate-session.query.js";

export const AUTHORIZATION_PUBLIC_BASE_URL_TOKEN = "AUTHORIZATION_PUBLIC_BASE_URL";

/**
 * docs/features/authorization.md R17: these three descriptions are fixed client-facing text and part of the
 * contract, so a client or a support conversation may key on them. Class (a) — no credential — has no
 * description and no `error` parameter at all, because its absence is what tells a standard client to
 * start the authorization flow instead of concluding its token is broken.
 */
const CHALLENGE_ERRORS = {
	expired: { error: "invalid_token", description: "The access token has expired." },
	invalid: { error: "invalid_token", description: "The access token is invalid." },
	unavailable: { error: "temporarily_unavailable", description: "Authentication is temporarily unavailable." }
} as const;
/** R17: the only class that carries it — replaying (a), (b) or (c) cannot succeed. */
const RETRY_AFTER_SECONDS = "5";
const BEARER_TOKEN = /^Bearer ([A-Za-z0-9_-]{43})$/i;

export interface AuthenticatedMcpRequest {
	readonly headers: { readonly authorization?: unknown };
	readonly body?: unknown;
	authorizationPrincipal?: AuthenticatedPrincipal;
}
export interface McpAuthenticationResponse {
	readonly setHeader: (name: string, value: string) => void;
}

/** Argument identity is never authority, including nested identity/permission aliases. */
function forbiddenIdentity(value: unknown, depth = 0, path: readonly string[] = [], searchCall = false): boolean {
	if (depth > 32) return true;
	if (Array.isArray(value))
		return value.some((entry) => forbiddenIdentity(entry, depth + 1, [...path, "[]"], searchCall));
	if (typeof value !== "object" || value === null) return false;
	const envelope = value as Record<string, unknown>;
	if (depth === 0) {
		const params = envelope["params"];
		searchCall =
			envelope["method"] === "tools/call" &&
			typeof params === "object" &&
			params !== null &&
			"name" in params &&
			params.name === "search_messages";
	}
	return Object.entries(value).some(([key, nested]) => {
		// Documented result filters select messages, never whose ACL is evaluated. Permit only
		// this exact schema location and a plain snowflake; nested aliases remain fail-closed.
		const retrievalFilters = ["authorId"];
		if (searchCall && path.join(".") === "params.arguments" && retrievalFilters.includes(key))
			return (
				typeof nested !== "string" ||
				!/^[1-9][0-9]{0,18}$/.test(nested) ||
				BigInt(nested) > 9223372036854775807n
			);
		const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
		return (
			/^(user|userid|discorduserid|session|sessionid|principal|identity|author|authorid|authorfilter|permission|permissions|permissionfilter|role|roles|roleid|roleids|guildid)$/.test(
				normalized
			) || forbiddenIdentity(nested, depth + 1, [...path, key], searchCall)
		);
	});
}

/** Mount on the MCP controller, never only on tools/call: continuations and discovery are protected too. */
export class McpAuthenticationGuard implements CanActivate {
	private logAnomalies = 0;
	public readonly logAnomalyCount = (): number => this.logAnomalies;
	public constructor(
		@Inject(AuthenticateSessionQuery) private readonly authenticate: AuthenticateSessionQuery,
		@Inject(AUTHORIZATION_PUBLIC_BASE_URL_TOKEN) private readonly publicBaseUrl: string,
		@Inject(APP_LOGGER_TOKEN) private readonly logger?: AppLogger
	) {}

	public readonly authenticateRequest = async (
		request: AuthenticatedMcpRequest,
		response: McpAuthenticationResponse
	): Promise<AuthenticatedPrincipal> => {
		// Never trust a principal left on a reused stream/request object by an earlier successful call.
		delete request.authorizationPrincipal;
		const header = request.headers.authorization;
		const match = typeof header === "string" ? BEARER_TOKEN.exec(header) : null;
		// Nothing presented is its own outcome class and needs no store read: there is no credential to hash.
		// A non-string header is not "nothing": it is something a parser cannot read, so it is class (c).
		const absent = header === undefined || (typeof header === "string" && header.trim() === "");
		const result = absent
			? { authenticated: false as const, outcome: "missing" as const }
			: await this.authenticate.execute(match?.[1] ?? "");
		if (!result.authenticated) throw this.refusal(response, result.outcome);
		if (forbiddenIdentity(request.body))
			throw new HttpException(
				{
					jsonrpc: "2.0",
					id: null,
					error: { code: -32602, message: "Identity and permission arguments are not accepted." }
				},
				400
			);
		try {
			this.logger?.debug("authorization request authenticated", {
				code: "authenticated",
				userId: result.principal.userId,
				sessionId: result.principal.sessionId
			});
		} catch {
			this.logAnomalies += 1;
		}
		request.authorizationPrincipal = result.principal;
		return result.principal;
	};

	public readonly canActivate = async (context: ExecutionContext): Promise<boolean> => {
		const http = context.switchToHttp();
		await this.authenticateRequest(
			http.getRequest<AuthenticatedMcpRequest>(),
			http.getResponse<McpAuthenticationResponse>()
		);
		return true;
	};

	/**
	 * One refusal, four classes (R17): every class names the protected-resource metadata document, and the body
	 * is the RFC 6750 §3.1 object in every class, so one parser serves them all and only the presence of the
	 * members differs. The class travels to the log as a code (R13: codes, ids and counts only).
	 */
	private readonly refusal = (
		response: McpAuthenticationResponse,
		outcome: AuthenticationOutcome
	): UnauthorizedException => {
		try {
			this.logger?.info("authorization request refused", { code: `authentication_${outcome}` });
		} catch {
			this.logAnomalies += 1;
		}
		const metadata = `Bearer resource_metadata="${this.publicBaseUrl}/.well-known/oauth-protected-resource"`;
		const challenge = outcome === "missing" ? undefined : CHALLENGE_ERRORS[outcome];
		response.setHeader(
			"WWW-Authenticate",
			challenge === undefined
				? metadata
				: `${metadata}, error="${challenge.error}", error_description="${challenge.description}"`
		);
		if (outcome === "unavailable") response.setHeader("Retry-After", RETRY_AFTER_SECONDS);
		return new UnauthorizedException(
			challenge === undefined ? {} : { error: challenge.error, error_description: challenge.description }
		);
	};
}
