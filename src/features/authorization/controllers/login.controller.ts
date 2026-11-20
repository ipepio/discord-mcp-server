import { Body, Controller, Get, Inject, Post, Query, Res } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { randomUUID } from "node:crypto";
import { APP_LOGGER_TOKEN } from "../../../shared/logging/logging.tokens.js";
import type { AppLogger } from "../../../shared/logging/logger.interface.js";
import { CompleteLoginCommand } from "../commands/complete-login.command.js";
import { ExchangeAuthorizationCodeCommand } from "../commands/exchange-authorization-code.command.js";
import { RotateRefreshTokenCommand } from "../commands/rotate-refresh-token.command.js";
import { OAuthError } from "../models/domain/oauth-error.js";

interface ProtocolResponse {
	status(code: number): ProtocolResponse;
	setHeader(name: string, value: string): void;
	json(body: unknown): void;
}
function fields(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new OAuthError("invalid_request", "An object is required.");
	return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Public OAuth endpoints: callback is single-use state bound; token redemption requires PKCE. */
@ApiExcludeController()
@Controller("oauth")
export class LoginController {
	public constructor(
		@Inject(CompleteLoginCommand) private readonly complete: CompleteLoginCommand,
		@Inject(ExchangeAuthorizationCodeCommand) private readonly exchange: ExchangeAuthorizationCodeCommand,
		@Inject(RotateRefreshTokenCommand) private readonly rotate: RotateRefreshTokenCommand,
		@Inject(APP_LOGGER_TOKEN) private readonly logger?: AppLogger
	) {}

	@Get("discord/callback")
	public async callback(@Query() query: unknown, @Res() response: ProtocolResponse): Promise<void> {
		await this.safe(response, async () => {
			const input = fields(query);
			const result = await this.complete.execute({
				state: text(input["state"]),
				code: text(input["code"]),
				denied: input["error"] !== undefined
			});
			// The command returns the exact registered URI from the consumed server-side request, not request input.
			const target = URL.parse(result.redirectUri);
			if (
				!target ||
				(target.protocol !== "https:" &&
					!(target.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(target.hostname)))
			)
				throw new OAuthError("invalid_request", "A registered redirect URI is required.");
			target.searchParams.set("code", result.code);
			target.searchParams.set("state", result.state);
			response.setHeader("Location", target.toString());
			response.status(302).json({});
		});
	}

	@Post("token")
	public async token(@Body() body: unknown, @Res() response: ProtocolResponse): Promise<void> {
		await this.safe(response, async () => {
			const input = fields(body);
			// One endpoint, two grants (ADR 0009): everything that is not a refresh stays on the code grant so
			// an unsupported grant type keeps its existing error.
			const result =
				text(input["grant_type"]) === "refresh_token"
					? await this.rotate.execute({
							refreshToken: text(input["refresh_token"]),
							clientId: text(input["client_id"])
						})
					: await this.exchange.execute({
							grantType: text(input["grant_type"]),
							clientId: text(input["client_id"]),
							redirectUri: text(input["redirect_uri"]),
							code: text(input["code"]),
							codeVerifier: text(input["code_verifier"])
						});
			response.status(200).json({
				access_token: result.accessToken,
				token_type: "Bearer",
				expires_in: result.expiresIn,
				refresh_token: result.refreshToken,
				// R18: the lifetime the command just stored for the credential in this same body, never re-derived.
				refresh_expires_in: result.refreshExpiresIn
			});
		});
	}

	private async safe(response: ProtocolResponse, operation: () => Promise<void>): Promise<void> {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("Pragma", "no-cache");
		try {
			await operation();
		} catch (error: unknown) {
			if (error instanceof OAuthError)
				response
					.status(error.code === "temporarily_unavailable" ? 503 : 400)
					.json({ error: error.code, error_description: error.message });
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
