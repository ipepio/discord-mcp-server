import { Body, Controller, Get, HttpCode, Inject, Post, Query, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { randomUUID } from "node:crypto";
import { APP_LOGGER_TOKEN } from "../../../shared/logging/logging.tokens.js";
import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import { BeginLoginCommand } from "../commands/begin-login.command.js";
import { RegisterClientCommand } from "../commands/register-client.command.js";
import { OAuthError } from "../models/domain/oauth-error.js";
import { GetAuthorizationServerMetadataQuery } from "../queries/get-authorization-server-metadata.query.js";

interface ProtocolResponse {
	status(code: number): ProtocolResponse;
	setHeader(name: string, value: string): void;
	json(body: unknown): void;
	redirect(status: number, location: string): void;
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new OAuthError("invalid_request", "An object is required.");
	return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}
function strings(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((entry: unknown) => typeof entry === "string"))
		throw new OAuthError("invalid_client_metadata", "String arrays are required.");
	return value;
}
/**
 * docs/features/authorization.md R19: the declared grants are a set that must contain `authorization_code` and
 * may contain `refresh_token`. The command has already rejected anything else, so this echoes the set the client
 * actually declared in the canonical order; an omitted declaration keeps the registered default.
 */
function echoedGrants(declared: readonly string[] | undefined): readonly string[] {
	return declared?.includes("refresh_token") ? ["authorization_code", "refresh_token"] : ["authorization_code"];
}

/** OAuth protocol surface: each route is public by design, never a business REST API. */
@ApiExcludeController()
@Controller()
export class OAuthController {
	public constructor(
		@Inject(GetAuthorizationServerMetadataQuery) private readonly metadata: GetAuthorizationServerMetadataQuery,
		@Inject(RegisterClientCommand) private readonly registerClient: RegisterClientCommand,
		@Inject(BeginLoginCommand) private readonly beginLogin: BeginLoginCommand,
		@Inject(APP_LOGGER_TOKEN) private readonly logger?: AppLogger
	) {}

	@Get(".well-known/oauth-authorization-server")
	public authorizationMetadata(@Res() response: ProtocolResponse): void {
		response.setHeader("Cache-Control", "public, max-age=300");
		response.json(this.metadata.execute());
	}

	@Get(".well-known/oauth-protected-resource")
	public resourceMetadata(@Res() response: ProtocolResponse): void {
		response.setHeader("Cache-Control", "public, max-age=300");
		response.json(this.metadata.protectedResource());
	}

	@Post("oauth/register")
	@HttpCode(201)
	public async register(@Body() body: unknown, @Res() response: ProtocolResponse): Promise<void> {
		await this.safe(response, async () => {
			const input = record(body);
			const declaredGrants = strings(input["grant_types"]);
			const client = await this.registerClient.execute({
				redirectUris: strings(input["redirect_uris"]) ?? [],
				...(input["grant_types"] !== undefined ? { grantTypes: declaredGrants ?? [] } : {}),
				...(input["response_types"] !== undefined
					? { responseTypes: strings(input["response_types"]) ?? [] }
					: {}),
				...(input["token_endpoint_auth_method"] !== undefined
					? { tokenEndpointAuthMethod: text(input["token_endpoint_auth_method"]) }
					: {})
			});
			response.status(201).json({
				client_id: client.clientId,
				redirect_uris: client.redirectUris,
				// R19: the declared set is echoed as declared (validated above, never stored) — answering with a
				// fixed `["authorization_code"]` told a client its `refresh_token` declaration had been dropped,
				// which is exactly the kind of false signal this rule exists to remove.
				grant_types: echoedGrants(declaredGrants),
				response_types: ["code"],
				token_endpoint_auth_method: "none"
			});
		});
	}

	@Get("oauth/authorize")
	public async authorize(@Query() query: unknown, @Res() response: ProtocolResponse): Promise<void> {
		await this.safe(response, async () => {
			const input = record(query);
			const result = await this.beginLogin.execute({
				clientId: text(input["client_id"]),
				redirectUri: text(input["redirect_uri"]),
				responseType: text(input["response_type"]),
				state: text(input["state"]),
				codeChallenge: text(input["code_challenge"]),
				codeChallengeMethod: text(input["code_challenge_method"]),
				...(input["scope"] !== undefined ? { scope: text(input["scope"]) } : {})
			});
			const target = URL.parse(result.redirectUrl);
			if (!target || target.origin !== "https://discord.com" || target.pathname !== "/oauth2/authorize")
				throw new OAuthError("invalid_request", "The authorization destination is invalid.");
			response.setHeader("Location", target.toString());
			response.status(302).json({});
		});
	}

	private async safe(response: ProtocolResponse, operation: () => Promise<void>): Promise<void> {
		response.setHeader("Cache-Control", "no-store");
		try {
			await operation();
		} catch (error: unknown) {
			if (error instanceof OAuthError)
				response.status(400).json({ error: error.code, error_description: error.message });
			else {
				const correlationId = randomUUID();
				try {
					this.logger?.error("authorization protocol failure", { code: "server_error", correlationId });
				} catch {
					/* Log sink failures never replace the safe response. */
				}
				response.status(500).json({
					error: "server_error",
					error_description: "The request could not be completed.",
					correlationId
				});
			}
		}
	}
}
